/** Android (Chromium) 用トランスポート: WebMessagePort バイナリ転送。
 *
 * 狙い: ネイティブ側が `WebViewCompat.addWebMessageListener` で公開する
 * `window.corebin` へ ArrayBuffer を投げ、応答も ArrayBuffer で受ける
 * (構造化クローン往復2コピー+Binder、base64・URL長制限なしの真バイナリ)。
 * Rust計算 (`process_batch`) を JNI (`CorebinPort.handleBatch`) 経由で呼ぶ。
 *
 * 対応付けはwire sequenceで行い、送信は直列化する (PortTransportと同方針)。
 * `window.corebin` がなければ `pipe` → `fallback` の順に委譲する。
 */
import {
  TRANSPORT_CAPS,
  getCorebinPort,
  type BridgeTransport,
  type BytePipe,
  type RawMessagePort,
  type TransportEnv,
} from "./bridge-interface";
import { scanFrames } from "../../api/wire";

export function isAndroidPortAvailable(env: TransportEnv): boolean {
  return env.hasAndroidPort;
}

export { getCorebinPort };
export type { RawMessagePort };

export interface AndroidPortDeps {
  /** 生MessagePort (`window.corebin` 等。最優先)。 */
  readonly port?: RawMessagePort;
  /** WebMessagePort 直結パイプ (注入)。 */
  readonly pipe?: BytePipe;
  readonly fallback?: BridgeTransport;
}

export class AndroidPortTransport implements BridgeTransport {
  readonly kind = "android-port" as const;
  readonly caps = TRANSPORT_CAPS["android-port"];
  private readonly pipe: BytePipe | null;
  private readonly fallback: BridgeTransport | null;
  private readonly messenger: WebMessageTransport | null;

  constructor(deps: AndroidPortDeps = {}) {
    this.messenger =
      deps.port !== undefined && deps.port !== null
        ? new WebMessageTransport({ port: deps.port })
        : null;
    this.pipe = deps.pipe ?? null;
    this.fallback = deps.fallback ?? null;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    if (this.messenger) return this.messenger.send(requestBytes);
    if (this.pipe) return this.pipe(requestBytes);
    if (this.fallback) return this.fallback.send(requestBytes);
    throw new Error("android-port: no message port, pipe, or fallback");
  }
}

export interface WebMessageTransportDeps {
  readonly port: RawMessagePort;
}

/** 生MessagePort直結の最小実装。純ArrayBufferのみ運び、応答はwire
 * sequenceで対応付ける。送信は直列化する。transfer指定は当該WebViewで
 * 変換失敗になるため使わず、構造化クローンに任せる。 */
export class WebMessageTransport implements BridgeTransport {
  readonly kind = "android-port" as const;
  readonly caps = TRANSPORT_CAPS["android-port"];
  private readonly port: WebMessageTransportDeps["port"];
  private tail: Promise<void> = Promise.resolve();
  private readonly pending: Array<{
    readonly sequence: number;
    readonly resolve: (v: Uint8Array) => void;
    readonly reject: (e: Error) => void;
  }> = [];

  constructor(deps: WebMessageTransportDeps) {
    this.port = deps.port;
    deps.port.addEventListener("message", (ev) => {
      this.onMessage(ev.data);
    });
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    // 要求は1件以上の完全なframe連結 (batch可) とする。不正なら送らない。
    const scanned = scanFrames(requestBytes);
    if (!scanned.ok || scanned.frames.length === 0) {
      throw new Error(`port-message: invalid request batch: ${scanned.ok ? "empty" : scanned.error.message}`);
    }
    return this.sendBatch(requestBytes, scanned.frames[0]!.header.sequence);
  }

  private sendBatch(requestBytes: Uint8Array, sequence: number): Promise<Uint8Array> {
    // ArrayBuffer本体を投げる (view投下はport側で変換失敗になる)。
    // transfer指定もこのWebViewで変換失敗になるため使わず、構造化
    // クローンの1複写で送る (数μs級で無視できる)。
    const buf =
      requestBytes.byteOffset === 0 && requestBytes.byteLength === requestBytes.buffer.byteLength
        ? (requestBytes.buffer as ArrayBuffer)
        : (requestBytes.slice().buffer as ArrayBuffer);
    const run = this.tail.then(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          this.pending.push({ sequence, resolve, reject });
          try {
            this.port.postMessage(buf);
          } catch (e) {
            const idx = this.pending.findIndex((p) => p.sequence === sequence);
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
    if (!(data instanceof ArrayBuffer)) {
      this.failAll(new Error("port-message: response must be ArrayBuffer"));
      return;
    }
    const bytes = new Uint8Array(data);
    const scanned = scanFrames(bytes);
    if (!scanned.ok || scanned.frames.length === 0) {
      this.failAll(new Error("port-message: invalid response batch"));
      return;
    }
    // 直列化のため先頭frameが対応要求のはず。ずれは輸送破損として全終了する。
    const head = this.pending[0];
    if (!head || head.sequence !== scanned.frames[0]!.header.sequence) {
      this.failAll(new Error("port-message: response order mismatch"));
      return;
    }
    this.pending.shift();
    head.resolve(bytes);
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
