/** 高頻度 submit のバッチ化。
 *
 * `BatchingBridge`: 任意の BridgeTransport を束ね、高頻度 submit を1回の
 * send にまとめる (リング/バッチ機構の JS Glue 側フラッシュ)。
 */
import { decodeHeader, scanFrames } from "../../api/wire";
import {
  SerialQueue,
  type BridgeTransport,
} from "./bridge-interface";
import { FrameBatcher } from "../../api/wire-ring";

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
  private readonly queue = new SerialQueue();
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
    return this.queue.enqueue(() => this.doFlush());
  }

  private enqueueSend(batch: Uint8Array, snapshot: BatchEntry[]): Promise<void> {
    return this.queue.enqueue(() => this.sendBatch(batch, snapshot));
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
