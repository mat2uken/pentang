/** Tauri invoke への翻訳 fallback。
 *
 * `TauriInvokeTransport`: 上位からは純バイナリに見せ、Tauri 境界では既存の
 * `core_get_info` / `core_transform` JSON invoke へ翻訳する基準経路・単一fallback。
 */
import {
  decodeTransformRequest,
  encodeGetInfoResponse,
  encodeTransformResponse,
  scanFrames,
  valuesToArray,
} from "../../api/wire";
import { TRANSPORT_CAPS, type BridgeTransport } from "./bridge-interface";

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
      const raw = await this.invoke("core_get_info");
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
    const raw = await this.invoke("core_transform", {
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
