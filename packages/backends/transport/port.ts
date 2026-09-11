/** MessagePort 系の直列転送 (worker-message)。
 *
 * `PortTransport`: バイナリ対応 peer との transferable 送受信。
 * 要求は直列化し、応答は順序対応で解決する。
 */
import {
  SerialQueue,
  TRANSPORT_CAPS,
  type BridgeTransport,
} from "./bridge-interface";

/** バイナリ対応 peer との最小ポート契約 (Worker / MessagePort 両対応)。 */
export interface BinaryPort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (ev: { readonly data: unknown }) => void): void;
}

interface PortEnvelope {
  readonly coreBinary: 1;
  readonly id: number;
  readonly buffer: ArrayBuffer;
}

function isPortEnvelope(v: unknown): v is PortEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["coreBinary"] === 1 && typeof o["id"] === "number" && o["buffer"] instanceof ArrayBuffer;
}

/** transferable で ArrayBuffer の所有権を移して運ぶ。直列化して順序対応する。 */
export class PortTransport implements BridgeTransport {
  readonly kind = "worker-message" as const;
  readonly caps = TRANSPORT_CAPS["worker-message"];
  private readonly port: BinaryPort;
  private nextId = 1;
  private readonly queue = new SerialQueue();
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
    return this.queue.enqueue(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          this.pending.push({ id, resolve, reject });
          try {
            this.port.postMessage(
              { coreBinary: 1, id, buffer: copy.buffer as ArrayBuffer },
              [copy.buffer as ArrayBuffer],
            );
          } catch (e) {
            const idx = this.pending.findIndex((p) => p.id === id);
            if (idx >= 0) this.pending.splice(idx, 1);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }),
    );
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
