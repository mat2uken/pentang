/** PoC v1 の公開契約。Tauri / Worker / Emscripten の型は公開しない。 */
export const APPLICATION_API_VERSION = 1 as const;
export const CORE_ABI_VERSION = 1 as const;
export const MAX_VALUES = 4096 as const;

export type BackendKind = "tauri-native" | "wasm-worker";
export type HostOs = "ios" | "android" | "windows" | "macos" | "browser";

export interface CoreInfo {
  /** 実際の C++ core_abi_version() の結果。未対応の版なら初期化失敗。 */
  readonly abiVersion: number;
  /** 実際の C++ core_version() の UTF-8 文字列をコピーした値。 */
  readonly version: string;
}

export interface RuntimeInfo {
  readonly apiVersion: typeof APPLICATION_API_VERSION;
  readonly backend: BackendKind;
  readonly hostOs: HostOs;
  readonly execution: "native-ffi" | "dedicated-worker";
  readonly core: CoreInfo;
}

export interface TransformRequest {
  /** 整数のみ、signed int32 範囲、0～4096 要素。型だけでは保証できない。 */
  readonly values: readonly number[];
  /** signed int32。計算は C++ の int64_t で行う。 */
  readonly multiplier: number;
  /** signed int32。 */
  readonly offset: number;
}

export interface TransformResult {
  /** clamp(values[i] * multiplier + offset, INT32_MIN, INT32_MAX)。 */
  readonly values: readonly number[];
  /** 出力要素を uint32 として加算した mod 2^32 値。暗号学的用途ではない。 */
  readonly checksum: number;
}

export type AppErrorCode =
  | "INVALID_ARGUMENT"
  | "LIMIT_EXCEEDED"
  | "INITIALIZATION_FAILED"
  | "ABI_MISMATCH"
  | "CORE_FAILURE"
  | "OUT_OF_MEMORY"
  | "TRANSPORT_ERROR"
  | "WORKER_FAILED"
  | "TIMEOUT"
  | "BUSY"
  | "DISPOSED";

/** IPC で Error オブジェクトを直接運ばず、各 Backend がこれに正規化する。 */
export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
}

/** 初期化済みインスタンス。失敗は Promise rejection の AppError で返す。 */
export interface ApplicationApi {
  getInfo(): Promise<RuntimeInfo>;
  transform(request: TransformRequest): Promise<TransformResult>;
  /** 冪等。未完了 Promise を終了させ、以降の操作は DISPOSED。 */
  dispose(): Promise<void>;
}

/** composition root だけが使用する。UI にバックエンド選択をさせない。 */
export type BackendFactory = () => Promise<ApplicationApi>;
