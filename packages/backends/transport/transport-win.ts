/** Windows (WebView2) 用トランスポート: 共有メモリ (SharedBuffer)。
 *
 * 狙い: `postMessageWithAdditionalObjects` 経由で ICoreWebView2SharedBuffer を
 * 共有し、同一メモリマッピングで 0コピー転送する。ネイティブが SharedBuffer に
 * 書き込み `PostSharedBufferToScript` で返す。
 *
 * 現状の位置付け: Tauri は WebView2 を抽象化しており、JS から SharedBuffer に
 * 直接触れない。そのため本クラスは将来の native plugin hook
 * (`__CORE_SHARED_BUFFER__`) が公開された場合に 0コピー経路を使い、それまでは
 * 注入された `fallback` (tauri-invoke) へ委譲する薄いラッパーである。
 */
import {
  TRANSPORT_CAPS,
  sendViaPipeOrFallback,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
} from "./bridge-interface";

export function isWebView2SharedAvailable(env: TransportEnv): boolean {
  return env.hasWebView2Shared;
}

export interface WebView2SharedDeps {
  /** 0コピー共有メモリパイプ (native plugin 提供時に注入)。 */
  readonly pipe?: BytePipe;
  readonly fallback?: BridgeTransport;
}

export class WebView2SharedTransport implements BridgeTransport {
  readonly kind = "webview2-shared" as const;
  readonly caps = TRANSPORT_CAPS["webview2-shared"];
  private readonly pipe: BytePipe | null;
  private readonly fallback: BridgeTransport | null;

  constructor(deps: WebView2SharedDeps = {}) {
    this.pipe = deps.pipe ?? null;
    this.fallback = deps.fallback ?? null;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    return sendViaPipeOrFallback(
      this.pipe,
      this.fallback,
      requestBytes,
      "webview2-shared: no shared-buffer pipe or fallback",
    );
  }
}
