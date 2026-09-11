/** Bridge 共通インターフェース (制御/データ分離のトランスポート層)。
 *
 * 構成の考え方:
 * - 上位 (Backend) は本インターフェースだけを見て、エンコード済み wire フレーム
 *   (`packages/api/wire.ts`) のバイト列を `send` で運ぶ。JSON/Base64 を扱わない。
 * - 下位の OS 別実装 (`transport-win/apple/android/linux`) は薄いラッパーに留め、
 *   共通の unpack ロジック (C++/Rust の `*_next_frame` ループ) へ渡す。
 * - 各トランスポートはバイト列を不透明に運ぶだけで、ヘッダー解釈は両端で行う。
 *
 * メモリコピー回数 (提案の OS 別マッピング):
 * - webview2-shared (Windows 共有メモリ): 0回 (同一メモリマッピング)
 * - webkit-ipc (macOS/iOS WKWebView): 1回 (プロセス間IPC転送のみ)
 * - android-port (WebMessagePort): 1回 (Binder/IPC転送のみ)
 * - webkit-extension (Linux 同一プロセス): 0回 (直ポインタ)
 * - tauri-invoke (JSON 既存): テキスト変換ありの基準経路
 * - invoke-b64 (Tauri内バイナリ): base64の33%増だがJSON数値parseなし
 * - scheme-binary (Tauri内raw binary): fetch+custom schemeで生バイト1コピー
 * - worker-message (Web の Dedicated Worker): transferable で所有権移転
 *
 * DOM / Tauri 型に直接依存しない。環境検出は `collectEnv()` が globalThis を
 * 安全に覗く。試験では `TransportEnv` を注入する。
 */

export type TransportKind =
  | "webview2-shared"
  | "webkit-ipc"
  | "android-port"
  | "webkit-extension"
  | "tauri-invoke"
  | "invoke-b64"
  | "scheme-binary"
  | "worker-message";

export interface TransportCaps {
  readonly kind: TransportKind;
  /** IPC 境界を越えるメモリコピー回数 (0 or 1)。tauri/worker は envelope 依存。 */
  readonly copies: 0 | 1 | 2;
  readonly zeroCopy: boolean;
  /** 1回の send に載せられる最大 byte 数。 */
  readonly maxBatchBytes: number;
  readonly supportsBatch: boolean;
  readonly description: string;
}

export const TRANSPORT_CAPS: Record<TransportKind, TransportCaps> = {
  "webview2-shared": {
    kind: "webview2-shared",
    copies: 0,
    zeroCopy: true,
    maxBatchBytes: 1 << 20,
    supportsBatch: true,
    description: "Windows WebView2 SharedBuffer (同一メモリマッピング)",
  },
  "webkit-ipc": {
    kind: "webkit-ipc",
    copies: 1,
    zeroCopy: false,
    maxBatchBytes: 1 << 20,
    supportsBatch: true,
    description: "WKWebView messageHandlers binary (IPC転送のみ1コピー)",
  },
  "android-port": {
    kind: "android-port",
    copies: 1,
    zeroCopy: false,
    maxBatchBytes: 1 << 20,
    supportsBatch: true,
    description: "Android WebMessagePort binary (Binder転送のみ1コピー)",
  },
  "webkit-extension": {
    kind: "webkit-extension",
    copies: 0,
    zeroCopy: true,
    maxBatchBytes: 1 << 20,
    supportsBatch: true,
    description: "Linux Web Process Extension (同一プロセス直結)",
  },
  "tauri-invoke": {
    kind: "tauri-invoke",
    copies: 2,
    zeroCopy: false,
    maxBatchBytes: 1 << 20,
    supportsBatch: false,
    description: "Tauri invoke JSON (既存・基準経路)",
  },
  "invoke-b64": {
    kind: "invoke-b64",
    copies: 2,
    zeroCopy: false,
    maxBatchBytes: 4 << 20,
    supportsBatch: true,
    description: "Tauri invoke base64 wire batch (JSON数値parseなし)",
  },
  "scheme-binary": {
    kind: "scheme-binary",
    copies: 1,
    zeroCopy: false,
    maxBatchBytes: 4 << 20,
    supportsBatch: true,
    description: "pocbin: scheme fetch raw binary (生バイト1コピー)",
  },
  "worker-message": {
    kind: "worker-message",
    copies: 1,
    zeroCopy: false,
    maxBatchBytes: 1 << 20,
    supportsBatch: true,
    description: "Dedicated Worker postMessage (transferable所有権移転)",
  },
};

/** バイト列を運ぶ最小契約。request 全体 -> response 全体 (所有権は呼び出し側)。 */
export interface BridgeTransport {
  readonly kind: TransportKind;
  readonly caps: TransportCaps;
  send(requestBytes: Uint8Array): Promise<Uint8Array>;
}

/** 生のバイトパイプ (ネイティブ送受信の実体)。各 OS 実装に注入する。 */
export type BytePipe = (outbound: Uint8Array) => Promise<Uint8Array>;

/** 検出用の環境スナップショット。試験ではこの値を直接組み立てる。 */
export interface TransportEnv {
  readonly hasTauri: boolean;
  readonly hasWebView2Shared: boolean;
  readonly hasWebKitHandler: boolean;
  readonly hasAndroidPort: boolean;
  readonly hasLinuxDirect: boolean;
  readonly userAgent: string;
}

function readGlobal(path: readonly string[]): unknown {
  let cur: unknown = globalThis;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 実行環境の能力を安全に読み取る。window/document がなくても throw しない。 */
export function collectEnv(): TransportEnv {
  let userAgent = "";
  try {
    const nav = readGlobal(["navigator", "userAgent"]);
    if (typeof nav === "string") userAgent = nav;
  } catch {
    // ignore
  }
  const hasTauri = readGlobal(["__TAURI_INTERNALS__"]) !== undefined;
  // 将来の native plugin が公開する hook (現状未実装時は undefined → fallback)。
  // chrome.webview の有無だけでは SharedBuffer 可用性を意味しないため見ない。
  const hasWebView2Shared = readGlobal(["__POC_SHARED_BUFFER__"]) !== undefined;
  const hasWebKitHandler =
    readGlobal(["webkit", "messageHandlers", "pocBinary"]) !== undefined;
  const hasAndroidPort = readGlobal(["__POC_MESSAGE_PORT__"]) !== undefined;
  const hasLinuxDirect = readGlobal(["__POC_DIRECT_BRIDGE__"]) !== undefined;
  return {
    hasTauri,
    hasWebView2Shared,
    hasWebKitHandler,
    hasAndroidPort,
    hasLinuxDirect,
    userAgent,
  };
}

/** 環境から最適トランスポート種別を選ぶ (共通JSインターフェース裏の切替)。
 *
 * 優先順位: 0コピー系 (shared/extension) → 1コピー系 (webkit-ipc/android-port)
 * → tauri-invoke (Tauri内) → worker-message (Web)。
 * Tauri が WebView を抽象化している現状では、OS 固有 hook が見える場合のみ
 * そちらを選び、通常は tauri-invoke fallback になる。
 */
export function selectTransportKind(env: TransportEnv): TransportKind {
  if (env.hasWebView2Shared) return "webview2-shared";
  if (env.hasLinuxDirect) return "webkit-extension";
  if (env.hasWebKitHandler) return "webkit-ipc";
  if (env.hasAndroidPort) return "android-port";
  if (env.hasTauri) return "tauri-invoke";
  return "worker-message";
}

/** transferable 送信用に所有権を移せる複写を作る (neutering 対策の明示化)。 */
export function toTransferableCopy(src: Uint8Array): Uint8Array {
  return src.slice();
}

/** AppErrorコード付きのトランスポート失敗。上位は code で分類できる。 */
export class TransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

/** 未知の拒否値を TransportError へ正規化する (バックエンド境界用)。 */
export function normalizeTransportFailure(reason: unknown): TransportError {
  if (reason instanceof TransportError) return reason;
  if (reason instanceof Error) return new TransportError("TRANSPORT_ERROR", reason.message);
  try {
    return new TransportError("TRANSPORT_ERROR", JSON.stringify(reason) ?? String(reason));
  } catch {
    return new TransportError("TRANSPORT_ERROR", String(reason));
  }
}
