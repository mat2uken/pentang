/** Android (Chromium) 用トランスポート: WebMessagePort バイナリ転送。
 *
 * 狙い: `WebMessagePortCompat.postMessage(WebMessageCompat(byte[]))` で送り、
 * 受信側リスナーで直接 ArrayBuffer を受け取る (Binder/IPC転送のみの1コピー)。
 *
 * 現状の位置付け: Tauri 管理下の WebView では JS から Port を直接掴めないため、
 * 将来の hook (`__POC_MESSAGE_PORT__`) が公開された場合に直結し、それまでは
 * `fallback` (tauri-invoke) へ委譲する薄いラッパーである。
 */
import {
  TRANSPORT_CAPS,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
} from "./bridge-interface";

export function isAndroidPortAvailable(env: TransportEnv): boolean {
  return env.hasAndroidPort;
}

export interface AndroidPortDeps {
  /** WebMessagePort 直結パイプ (hook 公開時に注入)。 */
  readonly pipe?: BytePipe;
  readonly fallback?: BridgeTransport;
}

export class AndroidPortTransport implements BridgeTransport {
  readonly kind = "android-port" as const;
  readonly caps = TRANSPORT_CAPS["android-port"];
  private readonly pipe: BytePipe | null;
  private readonly fallback: BridgeTransport | null;

  constructor(deps: AndroidPortDeps = {}) {
    this.pipe = deps.pipe ?? null;
    this.fallback = deps.fallback ?? null;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    if (this.pipe) return this.pipe(requestBytes);
    if (this.fallback) return this.fallback.send(requestBytes);
    throw new Error("android-port: no message-port pipe or fallback");
  }
}
