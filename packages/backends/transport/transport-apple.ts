/** macOS / iOS (WKWebView) 用トランスポート: WebKit IPC Direct Binary。
 *
 * 狙い: `window.webkit.messageHandlers.<name>.postMessage(Uint8Array)` で送り、
 * WebKit 内部で直接 Data/NSData へ変換する (プロセス間IPC転送のみの1コピー)。
 * 大容量は WKURLSchemeHandler + fetch() ストリーム、小容量は
 * callAsyncJavaScript 引数バイナリを使い分ける。
 *
 * 現状の位置付け: Tauri 管理下の WKWebView では JS から直接 handler を
 * 追加できないため、将来の handler (`webkit.messageHandlers.coreBinary`) が
 * 見える場合にのみ直結し、それまでは `fallback` (tauri-invoke) へ委譲する。
 * 大容量フレームは呼び出し側が CONTINUED フラグで分割する (本層は不透明運搬)。
 */
import {
  TRANSPORT_CAPS,
  sendViaPipeOrFallback,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
} from "./bridge-interface";

export function isWebKitIpcAvailable(env: TransportEnv): boolean {
  return env.hasWebKitHandler;
}

export interface WebKitIpcDeps {
  /** WebKit messageHandler 直結パイプ (handler 公開時に注入)。 */
  readonly pipe?: BytePipe;
  readonly fallback?: BridgeTransport;
}

export class WebKitIpcTransport implements BridgeTransport {
  readonly kind = "webkit-ipc" as const;
  readonly caps = TRANSPORT_CAPS["webkit-ipc"];
  private readonly pipe: BytePipe | null;
  private readonly fallback: BridgeTransport | null;

  constructor(deps: WebKitIpcDeps = {}) {
    this.pipe = deps.pipe ?? null;
    this.fallback = deps.fallback ?? null;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    return sendViaPipeOrFallback(
      this.pipe,
      this.fallback,
      requestBytes,
      "webkit-ipc: no message-handler pipe or fallback",
    );
  }
}
