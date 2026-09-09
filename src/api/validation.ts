import { MAX_VALUES } from "./application-api";
import type {
  AppError,
  CoreInfo,
  RuntimeInfo,
  TransformResult,
} from "./application-api";
import { appError } from "./errors";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function isInt32Value(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= INT32_MIN &&
    v <= INT32_MAX
  );
}

function isUint32Value(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= 4294967295
  );
}

// 検査済み入力のスナップショット。最初のawaitより前にコピーし、caller変更から切り離す。
// -0は0として受理し、1.0は整数値として受理する (Number.isIntegerが真)。
export interface ValidatedRequest {
  readonly values: readonly number[];
  readonly multiplier: number;
  readonly offset: number;
  snapshot(): { values: number[]; multiplier: number; offset: number };
}

export function validateTransformRequest(
  request: unknown,
): { ok: true; validated: ValidatedRequest } | { ok: false; error: AppError } {
  // 2. requestはnullでないobjectかつarrayではない。必須fieldを持ち、未知fieldは拒否。
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, error: appError("INVALID_ARGUMENT", "request must be a plain object") };
  }
  const obj = request as Record<string, unknown>;
  for (const key of ["values", "multiplier", "offset"]) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, error: appError("INVALID_ARGUMENT", `missing field: ${key}`) };
    }
  }
  for (const key of Object.keys(obj)) {
    if (key !== "values" && key !== "multiplier" && key !== "offset") {
      return { ok: false, error: appError("INVALID_ARGUMENT", `unknown field: ${key}`) };
    }
  }
  // 3. valuesは通常のArray。長さ4096超はLIMIT_EXCEEDED。
  const values = obj["values"];
  if (!Array.isArray(values)) {
    return { ok: false, error: appError("INVALID_ARGUMENT", "values must be an array") };
  }
  if (values.length > MAX_VALUES) {
    return {
      ok: false,
      error: appError("LIMIT_EXCEEDED", `values length ${values.length} exceeds ${MAX_VALUES}`),
    };
  }
  // 4. 全indexが自身の要素として存在し、要素・multiplier・offsetがint32であること。
  // 疎配列をeveryの飛ばし処理で通さない。
  const copied: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(values, i)) {
      return { ok: false, error: appError("INVALID_ARGUMENT", `values[${i}] is missing (sparse array)`) };
    }
    const el = (values as unknown[])[i];
    if (!isInt32Value(el)) {
      return {
        ok: false,
        error: appError("INVALID_ARGUMENT", `values[${i}] must be an int32 integer`),
      };
    }
    // -0は0として受理
    copied[i] = el === 0 ? 0 : (el as number);
  }
  const multiplier = obj["multiplier"];
  if (!isInt32Value(multiplier)) {
    return { ok: false, error: appError("INVALID_ARGUMENT", "multiplier must be an int32 integer") };
  }
  const offset = obj["offset"];
  if (!isInt32Value(offset)) {
    return { ok: false, error: appError("INVALID_ARGUMENT", "offset must be an int32 integer") };
  }
  const m = multiplier === 0 ? 0 : (multiplier as number);
  const o = offset === 0 ? 0 : (offset as number);
  // copiedは要素ごとに新規構築した所有配列のため、そのままfreezeする (再spread不要)。
  const frozen = Object.freeze(copied) as readonly number[];
  const validated: ValidatedRequest = {
    values: frozen,
    multiplier: m,
    offset: o,
    snapshot() {
      return { values: [...copied], multiplier: m, offset: o };
    },
  };
  return { ok: true, validated };
}

export function validateTransformResult(
  value: unknown,
): { ok: true; result: TransformResult } | { ok: false; error: AppError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "result must be an object") };
  }
  const obj = value as Record<string, unknown>;
  const vals = obj["values"];
  const checksum = obj["checksum"];
  if (!Array.isArray(vals)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "result.values must be an array") };
  }
  for (let i = 0; i < vals.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(vals, i) || !isInt32Value(vals[i])) {
      return { ok: false, error: appError("TRANSPORT_ERROR", `result.values[${i}] invalid`) };
    }
  }
  if (!isUint32Value(checksum)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "result.checksum must be uint32") };
  }
  // 公開APIの実装でchecksumを再計算しない。配列全体の計算一致はfixture試験が担当。
  // valsはcaller所有の可能性があるためコピーしてfreezeする (caller配列のfreeze汚染を防ぐ)。
  return {
    ok: true,
    result: {
      values: Object.freeze([...(vals as number[])]) as readonly number[],
      checksum: checksum as number,
    },
  };
}

const VALID_BACKENDS = ["tauri-native", "wasm-worker"] as const;
const VALID_HOSTS = ["macos", "windows", "ios", "android", "browser"] as const;
const VALID_EXECUTIONS = ["native-ffi", "dedicated-worker"] as const;

export function validateRuntimeInfo(
  value: unknown,
): { ok: true; info: RuntimeInfo } | { ok: false; error: AppError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "RuntimeInfo must be an object") };
  }
  const obj = value as Record<string, unknown>;
  if (obj["apiVersion"] !== 1) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "apiVersion must be 1") };
  }
  const backend = obj["backend"];
  const hostOs = obj["hostOs"];
  const execution = obj["execution"];
  const core = obj["core"] as Record<string, unknown> | undefined;
  if (typeof backend !== "string" || !(VALID_BACKENDS as readonly string[]).includes(backend)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "backend invalid") };
  }
  if (typeof hostOs !== "string" || !(VALID_HOSTS as readonly string[]).includes(hostOs)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "hostOs invalid") };
  }
  if (typeof execution !== "string" || !(VALID_EXECUTIONS as readonly string[]).includes(execution)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "execution invalid") };
  }
  // backend/host/executionの組み合わせを確認
  if (backend === "tauri-native") {
    if (execution !== "native-ffi") {
      return { ok: false, error: appError("TRANSPORT_ERROR", "tauri backend must use native-ffi") };
    }
    if (hostOs === "browser") {
      return { ok: false, error: appError("TRANSPORT_ERROR", "tauri backend must not use browser host") };
    }
  } else {
    // wasm-worker
    if (execution !== "dedicated-worker") {
      return { ok: false, error: appError("TRANSPORT_ERROR", "wasm backend must use dedicated-worker") };
    }
    if (hostOs !== "browser") {
      return { ok: false, error: appError("TRANSPORT_ERROR", "wasm backend must use browser host") };
    }
  }
  if (typeof core !== "object" || core === null) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "core missing") };
  }
  const abiVersion = (core as Record<string, unknown>)["abiVersion"];
  const version = (core as Record<string, unknown>)["version"];
  if (typeof abiVersion !== "number" || !Number.isInteger(abiVersion)) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "core.abiVersion invalid") };
  }
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, error: appError("TRANSPORT_ERROR", "core.version invalid") };
  }
  // 形が正しくABIだけ違う場合はABI_MISMATCH
  if (abiVersion !== 1) {
    return { ok: false, error: appError("ABI_MISMATCH", `unsupported ABI ${String(abiVersion)}`) };
  }
  const info: RuntimeInfo = {
    apiVersion: 1,
    backend: backend as RuntimeInfo["backend"],
    hostOs: hostOs as RuntimeInfo["hostOs"],
    execution: execution as RuntimeInfo["execution"],
    core: { abiVersion, version } as CoreInfo,
  };
  return { ok: true, info };
}
