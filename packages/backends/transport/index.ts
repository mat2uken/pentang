/** トランスポートのディスパッチ。
 *
 * - `createBridgeTransport`: `collectEnv()` / `selectTransportKind()` に従い
 *   OS 別実装を選ぶ。Tauri が WebView を抽象化している現状では OS 固有 hook が
 *   なければ Tauri内データプレーン (`tauriDataPlane` 指定) になる。
 * - `createFastTauriTransport` / `createTauriDataTransport`: Tauri内向けの
 *   明示構築。bench・採用経路の切替点。
 * - 実動アダプターは責務ごとに分割配置する (`tauri-invoke.ts` / `port.ts` /
 *   `batching.ts` / `transport-scheme.ts` / `transport-android.ts` /
 *   `transport-apple.ts` / `transport-win.ts`)。公開表面は本モジュールからの
 *   再 export で維持する。
 */
import {
  collectEnv,
  getCorebinPort,
  selectTransportKind,
  type BridgeTransport,
  type BytePipe,
  type TransportEnv,
  type TransportKind,
} from "./bridge-interface";
import { AndroidPortTransport } from "./transport-android";
import { LinuxDirectTransport } from "./transport-linux";
import { WebKitIpcTransport } from "./transport-apple";
import { SchemeBinaryTransport, probeSchemeUrl, type FetchFn } from "./transport-scheme";
import { WebView2SharedTransport } from "./transport-win";
import { TauriInvokeTransport, type InvokeFn } from "./tauri-invoke";
import { PortTransport, type BinaryPort } from "./port";

export { SchemeBinaryTransport, probeSchemeBinary, probeSchemeUrl } from "./transport-scheme";
export type { FetchFn };
export { TauriInvokeTransport, type InvokeFn } from "./tauri-invoke";
export { PortTransport, type BinaryPort } from "./port";
export { BatchingBridge, type BatchingBridgeOptions } from "./batching";

/** 計測済みの推奨順。
 * - 生Port公開 (Android): port-message (真バイナリ・最速)。
 * - POST到達 (desktop/iOS): scheme-binary。
 * - 到達不能: json (低速だが確実な単一fallback)。
 */
export async function createFastTauriTransport(deps: BridgeDeps = {}): Promise<BridgeTransport> {
  if (deps.tauriDataPlane !== undefined) return createTauriDataTransport(deps);
  const port = getCorebinPort();
  if (port) return new AndroidPortTransport({ port, fallback: deps.invoke !== undefined ? new TauriInvokeTransport({ invoke: deps.invoke }) : undefined });
  if (deps.transformUrl !== undefined) {
    return new SchemeBinaryTransport({ fetchFn: deps.fetchFn, transformUrl: deps.transformUrl });
  }
  const url = await probeSchemeUrl(deps.fetchFn);
  if (url !== null) {
    return new SchemeBinaryTransport({ fetchFn: deps.fetchFn, transformUrl: url });
  }
  if (deps.invoke !== undefined) {
    return new TauriInvokeTransport({ invoke: deps.invoke });
  }
  return createTauriDataTransport(deps);
}

export interface BridgeDeps {
  readonly env?: TransportEnv;
  readonly invoke?: InvokeFn;
  readonly port?: BinaryPort;
  readonly sharedPipe?: BytePipe;
  readonly webkitPipe?: BytePipe;
  readonly androidPipe?: BytePipe;
  readonly linuxPipe?: BytePipe;
  /** Tauri内でのデータプレーン選択。既定 "json" (従来動作・最安全)。 */
  readonly tauriDataPlane?: "json" | "scheme";
  readonly fetchFn?: FetchFn;
  readonly transformUrl?: string;
}

/** 環境検出に従い最適トランスポートを1つ構築する。経路がなければ throw。 */
export function createBridgeTransport(deps: BridgeDeps = {}): BridgeTransport {
  const env = deps.env ?? collectEnv();
  const kind: TransportKind = selectTransportKind(env);
  const invokeFallback =
    deps.invoke !== undefined ? new TauriInvokeTransport({ invoke: deps.invoke }) : undefined;
  switch (kind) {
    case "webview2-shared":
      return new WebView2SharedTransport({ pipe: deps.sharedPipe, fallback: invokeFallback });
    case "webkit-extension":
      return new LinuxDirectTransport({ pipe: deps.linuxPipe, fallback: invokeFallback });
    case "webkit-ipc":
      return new WebKitIpcTransport({ pipe: deps.webkitPipe, fallback: invokeFallback });
    case "android-port": {
      const port = getCorebinPort();
      if (port) return new AndroidPortTransport({ port, fallback: invokeFallback });
      return new AndroidPortTransport({ pipe: deps.androidPipe, fallback: invokeFallback });
    }
    case "tauri-invoke":
    case "scheme-binary":
      return createTauriDataTransport(deps);
    case "worker-message":
      if (deps.port === undefined) throw new Error("worker-message: no port");
      return new PortTransport({ port: deps.port });
  }
}

/** Tauri内データプレーンの明示構築。bench・採用経路の切替点。 */
export function createTauriDataTransport(deps: BridgeDeps = {}): BridgeTransport {
  const plane = deps.tauriDataPlane ?? "json";
  if (plane === "scheme") {
    return new SchemeBinaryTransport({
      fetchFn: deps.fetchFn,
      transformUrl: deps.transformUrl,
    });
  }
  if (deps.invoke === undefined) throw new Error("tauri-invoke: no invoke function");
  return new TauriInvokeTransport({ invoke: deps.invoke });
}
