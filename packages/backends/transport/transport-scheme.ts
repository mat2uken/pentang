/** corebin: schemeバイナリデータプレーン (Tauri内最速のraw binary経路)。
 *
 * `fetch("corebin://localhost/transform", { method: "POST", body: bytes })` で
 * wire要求batchの生バイトを送り、wire応答batchの生バイトを受け取る。
 * base64もJSONも介さない。WebView↔ネイティブ間のコピーはIPC転送の1回のみ。
 * batchは複数フレーム可 (BatchingBridgeと直結)。
 *
 * エラーはHTTP status + JSON AppError bodyで返る (稀少経路のみテキスト)。
 * 成功応答の Content-Type は application/octet-stream。
 * fetch実装は注入可能 (試験・SSR対応)。タイムアウトは上位の寿命管理に任せる。
 */
import {
  TRANSPORT_CAPS,
  TransportError,
  type BridgeTransport,
} from "./bridge-interface";
import {
  WIRE_CMD_TRANSFORM,
  WIRE_FLAG_ERROR,
  encodeTransformRequest,
  scanFrames,
} from "../../api/wire";

export const COREBIN_TRANSFORM_URL = "corebin://localhost/transform";
export const COREBIN_HEALTH_URL = "corebin://localhost/health";

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array },
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

function defaultFetch(): FetchFn | null {
  try {
    const f = (globalThis as Record<string, unknown>)["fetch"];
    if (typeof f !== "function") return null;
    return (f as FetchFn).bind(globalThis);
  } catch {
    return null;
  }
}

export interface SchemeBinaryDeps {
  readonly fetchFn?: FetchFn;
  readonly transformUrl?: string;
}

export class SchemeBinaryTransport implements BridgeTransport {
  readonly kind = "scheme-binary" as const;
  readonly caps = TRANSPORT_CAPS["scheme-binary"];
  private readonly fetchFn: FetchFn;
  private readonly transformUrl: string;

  constructor(deps: SchemeBinaryDeps = {}) {
    const f = deps.fetchFn ?? defaultFetch();
    if (!f) throw new Error("scheme-binary: no fetch implementation");
    this.fetchFn = f;
    this.transformUrl = deps.transformUrl ?? COREBIN_TRANSFORM_URL;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    // bodyが保持されるのはview範囲のみ。正確なviewなら複写しない。
    // (呼び出し側はsend解決まで内容を変更しないこと。batcher/encodeの出力は所有移動相当で安全)
    const exact =
      requestBytes.byteOffset === 0 &&
      requestBytes.byteLength === requestBytes.buffer.byteLength;
    const body = exact ? requestBytes : requestBytes.slice();
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(this.transformUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      });
    } catch (e) {
      throw new TransportError(
        "TRANSPORT_ERROR",
        `scheme-binary: fetch failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      );
    }
    if (res.ok) {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
    // 失敗時はJSON AppError bodyをcode付きで引き継ぐ。
    let code = "TRANSPORT_ERROR";
    let message = `scheme-binary: status ${res.status}`;
    try {
      const text = await res.text();
      const v = JSON.parse(text) as { code?: unknown; message?: unknown };
      if (typeof v.code === "string") code = v.code;
      if (typeof v.message === "string") message = v.message.slice(0, 300);
    } catch {
      // bodyが読めなければstatusのみ。
    }
    throw new TransportError(code, message);
  }
}

/** corebin schemeの疎通確認 (dispatcherの事前probe・benchの前提検査用)。 */
export async function probeSchemeBinary(
  fetchFn?: FetchFn,
  healthUrl: string = COREBIN_HEALTH_URL,
): Promise<boolean> {
  const f = fetchFn ?? defaultFetch();
  if (!f) return false;
  try {
    const res = await f(healthUrl, { method: "GET" });
    // bodyは読まない (疎通のみ)。
    void res;
    return res.ok;
  } catch {
    return false;
  }
}

/** 到達可能なtransform URLを返す。POST body不達の環境では到達不可と判定し、
 * nullを返す (当該環境はport/invoke-jsonへfallbackする)。
 * dispatcher・backendのURLピン留め用。 */
export async function probeSchemeUrl(fetchFn?: FetchFn): Promise<string | null> {
  const f = fetchFn ?? defaultFetch();
  if (!f) return null;
  // probe用極小frame: values=[0], mult=1, off=0 (純粋関数のため副作用なし)。
  const probe = new Uint8Array(16 + 12 + 4);
  encodeTransformRequest(probe, 0, { sequence: 0, values: [0], multiplier: 1, offset: 0 });
  try {
    const res = await f(COREBIN_TRANSFORM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: probe,
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const scanned = scanFrames(bytes);
    if (!scanned.ok || scanned.frames.length !== 1) return null;
    const h = scanned.frames[0]!.header;
    return h.command === WIRE_CMD_TRANSFORM && (h.flags & WIRE_FLAG_ERROR) === 0
      ? COREBIN_TRANSFORM_URL
      : null;
  } catch {
    return null;
  }
}
