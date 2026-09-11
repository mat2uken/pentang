/** トランスポートのディスパッチと当面の実動アダプター。
 *
 * - `createBridgeTransport`: `collectEnv()` / `selectTransportKind()` に従い
 *   OS 別実装を選ぶ。Tauri が WebView を抽象化している現状では OS 固有 hook が
 *   なければ Tauri内データプレーン (`tauriDataPlane` 指定) になる。
 * - `TauriInvokeTransport`: 上位からは純バイナリに見せ、Tauri 境界では既存の
 *   `poc_get_info` / `poc_transform` JSON invoke へ翻訳する基準経路。
 * - `InvokeB64Transport` (`transport-b64.ts`): `poc_transform_bin` への
 *   base64 batch。JSON数値parseを避ける。
 * - `SchemeBinaryTransport` (`transport-scheme.ts`): `pocbin:` schemeへの
 *   raw binary fetch。テキスト変換なしの最速経路。
 * - `PortTransport`: バイナリ対応 peer (将来の Worker 等) との transferable
 *   送受信。要求は直列化し、応答は順序対応で解決する。
 * - `BatchingBridge`: 任意の BridgeTransport を束ね、高頻度 submit を1回の
 *   send にまとめる (リング/バッチ機構の JS Glue 側フラッシュ)。
 */
import {
  decodeHeader,
  decodeTransformRequest,
  encodeGetInfoResponse,
  encodeTransformResponse,
  scanFrames,
  valuesToArray,
} from "../../api/wire";
import {
  TRANSPORT_CAPS,
  collectEnv,
  selectTransportKind,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
  type TransportKind,
} from "./bridge-interface";
import { FrameBatcher } from "../../api/wire-ring";
import { AndroidPortTransport } from "./transport-android";
import { InvokeB64Transport } from "./transport-b64";
import { LinuxDirectTransport } from "./transport-linux";
import { WebKitIpcTransport } from "./transport-apple";
import { SchemeBinaryTransport, probeSchemeEndpoint, type FetchFn, type SchemeHttpMethod } from "./transport-scheme";
import { WebView2SharedTransport } from "./transport-win";

export { InvokeB64Transport } from "./transport-b64";
export { SchemeBinaryTransport, probeSchemeBinary, probeSchemeEndpoint, probeSchemeUrl } from "./transport-scheme";
export type { FetchFn };

/** 計測済みの推奨順。
 * - POST到達 (desktop/iOS想定): scheme-binary (N=4096中央値0.4ms)。
 * - GET迂回のみ (Android相当): 単発はinvoke-b64が最速のためinvokeがあれば
 *   b64を選ぶ (emulator実測 N=3〜4096でb64がjson/scheme-GETに全勝)。
 *   batch利用者はSchemeBinaryTransportを明示構築する (32件束ねで約10倍)。
 * - 到達不能: invokeがあればb64、なければjson。
 */
export async function createFastTauriTransport(deps: BridgeDeps = {}): Promise<BridgeTransport> {
  if (deps.tauriDataPlane !== undefined) return createTauriDataTransport(deps);
  if (deps.transformUrl !== undefined) {
    return new SchemeBinaryTransport({ fetchFn: deps.fetchFn, transformUrl: deps.transformUrl, method: deps.schemeMethod });
  }
  const ep = await probeSchemeEndpoint(deps.fetchFn);
  if (ep !== null) {
    if (ep.method === "GET" && deps.invoke !== undefined) {
      return new InvokeB64Transport({ invoke: deps.invoke });
    }
    return new SchemeBinaryTransport({ fetchFn: deps.fetchFn, transformUrl: ep.transformUrl, method: ep.method });
  }
  if (deps.invoke !== undefined) {
    return new InvokeB64Transport({ invoke: deps.invoke });
  }
  return createTauriDataTransport(deps);
}

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri invoke への翻訳 fallback。batch 内の各フレームを1 invokeずつ送る。 */
export class TauriInvokeTransport implements BridgeTransport {
  readonly kind = "tauri-invoke" as const;
  readonly caps = TRANSPORT_CAPS["tauri-invoke"];
  private readonly invoke: InvokeFn;

  constructor(deps: { readonly invoke: InvokeFn }) {
    this.invoke = deps.invoke;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    const scanned = scanFrames(requestBytes);
    if (!scanned.ok) {
      throw new Error(`tauri-invoke: invalid request batch: ${scanned.error.message}`);
    }
    const out: Uint8Array[] = [];
    let total = 0;
    for (const f of scanned.frames) {
      const bytes = await this.sendOne(f.payload, f.header.command, f.header.sequence, f.offset, requestBytes);
      out.push(bytes);
      total += bytes.length;
    }
    const resp = new Uint8Array(total);
    let o = 0;
    for (const b of out) {
      resp.set(b, o);
      o += b.length;
    }
    return resp;
  }

  private async sendOne(
    payload: Uint8Array,
    command: number,
    sequence: number,
    offset: number,
    batch: Uint8Array,
  ): Promise<Uint8Array> {
    if (command === 1) {
      const raw = await this.invoke("poc_get_info");
      const core = (raw as { core?: { abiVersion?: unknown; version?: unknown } })?.core;
      if (typeof core?.abiVersion !== "number" || typeof core?.version !== "string") {
        throw new Error("tauri-invoke: invalid getInfo reply");
      }
      const buf = new Uint8Array(16 + 8 + 64);
      const n = encodeGetInfoResponse(buf, 0, sequence, core.abiVersion, core.version);
      return buf.slice(0, n);
    }
    const frame = batch.subarray(offset, offset + 16 + payload.length);
    const dec = decodeTransformRequest(frame);
    if (!dec.ok) {
      throw new Error(`tauri-invoke: invalid transform frame: ${dec.error.message}`);
    }
    const raw = await this.invoke("poc_transform", {
      request: {
        values: valuesToArray(dec.valuesBytes, dec.count),
        multiplier: dec.multiplier,
        offset: dec.offset,
      },
    });
    const data = raw as { values?: unknown; checksum?: unknown };
    if (!Array.isArray(data?.values) || typeof data?.checksum !== "number") {
      throw new Error("tauri-invoke: invalid transform reply");
    }
    const buf = new Uint8Array(16 + 8 + data.values.length * 4);
    const n = encodeTransformResponse(buf, 0, {
      sequence,
      values: data.values as number[],
      checksum: data.checksum,
    });
    return buf.slice(0, n);
  }
}

/** バイナリ対応 peer との最小ポート契約 (Worker / MessagePort 両対応)。 */
export interface BinaryPort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (ev: { readonly data: unknown }) => void): void;
}

interface PortEnvelope {
  readonly pocBinary: 1;
  readonly id: number;
  readonly buffer: ArrayBuffer;
}

function isPortEnvelope(v: unknown): v is PortEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["pocBinary"] === 1 && typeof o["id"] === "number" && o["buffer"] instanceof ArrayBuffer;
}

/** transferable で ArrayBuffer の所有権を移して運ぶ。直列化して順序対応する。 */
export class PortTransport implements BridgeTransport {
  readonly kind = "worker-message" as const;
  readonly caps = TRANSPORT_CAPS["worker-message"];
  private readonly port: BinaryPort;
  private nextId = 1;
  private tail: Promise<void> = Promise.resolve();
  private readonly pending: Array<{
    readonly id: number;
    readonly resolve: (v: Uint8Array) => void;
    readonly reject: (e: Error) => void;
  }> = [];

  constructor(deps: { readonly port: BinaryPort }) {
    this.port = deps.port;
    deps.port.addEventListener("message", (ev) => {
      this.onMessage(ev.data);
    });
  }

  send(requestBytes: Uint8Array): Promise<Uint8Array> {
    const id = this.nextId++;
    // 所有権移転のため複写して送る (呼び出し側バッファの neutering を防ぐ)。
    const copy = requestBytes.slice();
    const run = this.tail.then(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          this.pending.push({ id, resolve, reject });
          try {
            this.port.postMessage(
              { pocBinary: 1, id, buffer: copy.buffer as ArrayBuffer },
              [copy.buffer as ArrayBuffer],
            );
          } catch (e) {
            const idx = this.pending.findIndex((p) => p.id === id);
            if (idx >= 0) this.pending.splice(idx, 1);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private onMessage(data: unknown): void {
    if (!isPortEnvelope(data)) {
      this.failAll(new Error("worker-message: invalid envelope"));
      return;
    }
    const head = this.pending[0];
    if (!head || head.id !== data.id) {
      this.failAll(new Error("worker-message: response order mismatch"));
      return;
    }
    this.pending.shift();
    head.resolve(new Uint8Array(data.buffer));
  }

  private failAll(err: Error): void {
    const list = this.pending.splice(0);
    for (const p of list) {
      try {
        p.reject(err);
      } catch {
        // ignore
      }
    }
  }
}

export interface BatchingBridgeOptions {
  readonly maxBytes?: number;
  readonly maxFrames?: number;
  /** 自動フラッシュ間隔ms。0以下で無効 (呼び出し側が flushNow 駆動)。既定 0。 */
  readonly flushIntervalMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

interface BatchEntry {
  readonly sequence: number;
  readonly resolve: (v: Uint8Array) => void;
  readonly reject: (e: Error) => void;
}

/** 高頻度 submit を1回の send にまとめる。応答は wire sequence で対応付ける。 */
export class BatchingBridge {
  private readonly transport: BridgeTransport;
  private readonly batcher: FrameBatcher;
  private readonly flushIntervalMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private entries: BatchEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 送信の直列化 (応答batchと要求batchの対応を保つ)。
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(transport: BridgeTransport, opts: BatchingBridgeOptions = {}) {
    this.transport = transport;
    this.batcher = new FrameBatcher({ maxBytes: opts.maxBytes, maxFrames: opts.maxFrames });
    this.flushIntervalMs = opts.flushIntervalMs ?? 0;
    this.setTimeoutFn =
      opts.setTimeoutFn ??
      (((fn: (...a: never[]) => void, ms?: number, ...args: never[]) =>
        globalThis.setTimeout(fn, ms, ...args)) as unknown as typeof setTimeout);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      (((h: Parameters<typeof clearTimeout>[0]) =>
        globalThis.clearTimeout(h)) as unknown as typeof clearTimeout);
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  /** 完全なエンコード済みフレームを1件投入する。応答フレームの複写で解決する。 */
  submit(frame: Uint8Array): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("bridge closed"));
    const h = decodeHeader(frame, 0);
    if (!h.ok) return Promise.reject(new Error(`invalid frame: ${h.error.message}`));
    if (frame.length !== 16 + h.header.payloadLen) {
      return Promise.reject(new Error("frame must be exactly one complete frame"));
    }
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.entries.push({ sequence: h.header.sequence, resolve, reject });
    });
    // batcher.push は内部で複写するため、呼び出し側バッファを保持しない。
    // 閾値到達で batch が返った場合は entries 全体がその batch に対応する。
    const ready = this.batcher.push(frame);
    if (ready) {
      const snapshot = this.entries.splice(0);
      void this.enqueueSend(ready, snapshot);
    } else {
      this.scheduleFlush();
    }
    return promise;
  }

  /** 蓄積分を即時送信する。空なら何もしない。 */
  async flushNow(): Promise<void> {
    await this.flushSend();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      try {
        this.clearTimeoutFn(this.timer);
      } catch {
        // ignore
      }
      this.timer = null;
    }
    const list = this.entries.splice(0);
    this.batcher.flush();
    const err = new Error("bridge closed");
    for (const e of list) {
      try {
        e.reject(err);
      } catch {
        // ignore
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushIntervalMs <= 0 || this.timer || this.entries.length === 0) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.flushSend();
    }, this.flushIntervalMs);
  }

  private flushSend(): Promise<void> {
    const run = this.tail.then(() => this.doFlush());
    this.tail = run.catch(() => undefined).then(() => undefined);
    return run;
  }

  private enqueueSend(batch: Uint8Array, snapshot: BatchEntry[]): Promise<void> {
    const run = this.tail.then(() => this.sendBatch(batch, snapshot));
    this.tail = run.catch(() => undefined).then(() => undefined);
    return run;
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      try {
        this.clearTimeoutFn(this.timer);
      } catch {
        // ignore
      }
      this.timer = null;
    }
    const batch = this.batcher.flush();
    if (!batch) return;
    const snapshot = this.entries.splice(0);
    if (snapshot.length === 0) return;
    await this.sendBatch(batch, snapshot);
  }

  private async sendBatch(batch: Uint8Array, snapshot: BatchEntry[]): Promise<void> {
    let resp: Uint8Array;
    try {
      resp = await this.transport.send(batch);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      for (const en of snapshot) {
        try {
          en.reject(err);
        } catch {
          // ignore
        }
      }
      return;
    }
    const scanned = scanFrames(resp);
    if (!scanned.ok) {
      const err = new Error(`invalid response batch: ${scanned.error.message}`);
      for (const en of snapshot) {
        try {
          en.reject(err);
        } catch {
          // ignore
        }
      }
      return;
    }
    const bySeq = new Map<number, Uint8Array>();
    for (const f of scanned.frames) {
      bySeq.set(
        f.header.sequence,
        resp.slice(f.offset, f.offset + f.frameLen),
      );
    }
    for (const en of snapshot) {
      const bytes = bySeq.get(en.sequence);
      if (!bytes) {
        try {
          en.reject(new Error(`missing response for seq=${en.sequence}`));
        } catch {
          // ignore
        }
        continue;
      }
      try {
        en.resolve(bytes);
      } catch {
        // ignore
      }
    }
  }
}

export interface BridgeDeps {
  readonly env?: TransportEnv;
  readonly invoke?: InvokeFn;
  readonly port?: BinaryPort;
  readonly sharedPipe?: BytePipe;
  readonly webkitPipe?: BytePipe;
  readonly androidPipe?: BytePipe;
  readonly linuxPipe?: BytePipe;
  /** Tauri内でのデータプレーン選択。既定 "json" (従来動作・最安全)。 */
  readonly tauriDataPlane?: "json" | "b64" | "scheme";
  readonly fetchFn?: FetchFn;
  readonly transformUrl?: string;
  readonly schemeMethod?: SchemeHttpMethod;
}

/** 環境検出に従い最適トランスポートを1つ構築する。経路がなければ throw。 */
export function createBridgeTransport(deps: BridgeDeps = {}): BridgeTransport {
  const env = deps.env ?? collectEnv();
  const kind: TransportKind = selectTransportKind(env);
  const invokeFallback =
    deps.invoke !== undefined ? new TauriInvokeTransport({ invoke: deps.invoke }) : undefined;
  switch (kind) {
    case "webview2-shared":
      return new WebView2SharedTransport({ pipe: deps.sharedPipe, fallback: invokeFallback });
    case "webkit-extension":
      return new LinuxDirectTransport({ pipe: deps.linuxPipe, fallback: invokeFallback });
    case "webkit-ipc":
      return new WebKitIpcTransport({ pipe: deps.webkitPipe, fallback: invokeFallback });
    case "android-port":
      return new AndroidPortTransport({ pipe: deps.androidPipe, fallback: invokeFallback });
    case "tauri-invoke":
    case "invoke-b64":
    case "scheme-binary":
      return createTauriDataTransport(deps);
    case "worker-message":
      if (deps.port === undefined) throw new Error("worker-message: no port");
      return new PortTransport({ port: deps.port });
  }
}

/** Tauri内データプレーンの明示構築。bench・採用経路の切替点。 */
export function createTauriDataTransport(deps: BridgeDeps = {}): BridgeTransport {
  const plane = deps.tauriDataPlane ?? "json";
  if (plane === "scheme") {
    return new SchemeBinaryTransport({
      fetchFn: deps.fetchFn,
      transformUrl: deps.transformUrl,
      method: deps.schemeMethod,
    });
  }
  if (plane === "b64") {
    if (deps.invoke === undefined) throw new Error("invoke-b64: no invoke function");
    return new InvokeB64Transport({ invoke: deps.invoke });
  }
  if (deps.invoke === undefined) throw new Error("tauri-invoke: no invoke function");
  return new TauriInvokeTransport({ invoke: deps.invoke });
}
