/** Tauri invoke base64データプレーン (`poc_transform_bin`)。
 *
 * wire要求batch → base64 → invoke `{data}` → wire応答batch(base64) → decode。
 * JSON数値配列の stringify/parse (要素ごとのf64変換・検証) を避け、
 * テキスト変換はbase64の1パスのみに抑える。batchは複数フレーム可。
 * 失敗は TransportError (code付き) で返す。
 */
import { base64Decode, base64Encode } from "../../api/base64";
import {
  TRANSPORT_CAPS,
  TransportError,
  type BridgeTransport,
} from "./bridge-interface";
import type { InvokeFn } from "./index";

export class InvokeB64Transport implements BridgeTransport {
  readonly kind = "invoke-b64" as const;
  readonly caps = TRANSPORT_CAPS["invoke-b64"];
  private readonly invoke: InvokeFn;

  constructor(deps: { readonly invoke: InvokeFn }) {
    this.invoke = deps.invoke;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    let raw: unknown;
    try {
      raw = await this.invoke("poc_transform_bin", { data: base64Encode(requestBytes) });
    } catch (e) {
      throw toTransportError(e);
    }
    if (typeof raw !== "string") {
      throw new TransportError("TRANSPORT_ERROR", "invoke-b64: response must be base64 string");
    }
    const dec = base64Decode(raw);
    if (!dec.ok) {
      throw new TransportError("TRANSPORT_ERROR", `invoke-b64: bad base64 response (${dec.error})`);
    }
    return dec.bytes;
  }
}

function toTransportError(e: unknown): TransportError {
  if (e instanceof TransportError) return e;
  // Tauri invokeの拒否値が {code, message} なら引き継ぐ (AppError互換)。
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (typeof o["code"] === "string" && typeof o["message"] === "string") {
      return new TransportError(o["code"], o["message"]);
    }
  }
  if (typeof e === "string") return new TransportError("TRANSPORT_ERROR", e.slice(0, 300));
  if (e instanceof Error) return new TransportError("TRANSPORT_ERROR", e.message.slice(0, 300));
  return new TransportError("TRANSPORT_ERROR", "invoke-b64: unknown rejection");
}
