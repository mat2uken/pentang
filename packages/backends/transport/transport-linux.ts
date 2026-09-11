/** Linux (WebKitGTK/WPE) 用トランスポート: Web Process Extension。
 *
 * 狙い: 拡張機能内で JSC C-API を使い、同一プロセス内でポインタを直接共有する
 * (0コピー)。C++ 側から JSC TypedArray のバッファを直接更新して返す。
 *
 * 現状の位置付け: Tauri 管理下では拡張 .so の同梱・登録が別途必要なため、
 * 将来の直結 hook (`__CORE_DIRECT_BRIDGE__`) が見える場合に 0コピー経路を使い、
 * それまでは `fallback` (tauri-invoke) へ委譲する薄いラッパーである。
 */
import {
  TRANSPORT_CAPS,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
} from "./bridge-interface";

export function isLinuxDirectAvailable(env: TransportEnv): boolean {
  return env.hasLinuxDirect;
}

export interface LinuxDirectDeps {
  /** 同一プロセス直結パイプ (extension 登録時に注入)。 */
  readonly pipe?: BytePipe;
  readonly fallback?: BridgeTransport;
}

export class LinuxDirectTransport implements BridgeTransport {
  readonly kind = "webkit-extension" as const;
  readonly caps = TRANSPORT_CAPS["webkit-extension"];
  private readonly pipe: BytePipe | null;
  private readonly fallback: BridgeTransport | null;

  constructor(deps: LinuxDirectDeps = {}) {
    this.pipe = deps.pipe ?? null;
    this.fallback = deps.fallback ?? null;
  }

  async send(requestBytes: Uint8Array): Promise<Uint8Array> {
    if (this.pipe) return this.pipe(requestBytes);
    if (this.fallback) return this.fallback.send(requestBytes);
    throw new Error("webkit-extension: no direct pipe or fallback");
  }
}
