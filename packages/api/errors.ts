import type { AppError, AppErrorCode } from "./application-api";

const KNOWN_CODES: readonly AppErrorCode[] = [
  "INVALID_ARGUMENT",
  "LIMIT_EXCEEDED",
  "INITIALIZATION_FAILED",
  "ABI_MISMATCH",
  "CORE_FAILURE",
  "OUT_OF_MEMORY",
  "TRANSPORT_ERROR",
  "WORKER_FAILED",
  "TIMEOUT",
  "BUSY",
  "DISPOSED",
];

export function isAppErrorCode(code: unknown): code is AppErrorCode {
  return typeof code === "string" && (KNOWN_CODES as readonly string[]).includes(code);
}

export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isAppErrorCode(v["code"]) && typeof v["message"] === "string";
}

export function appError(code: AppErrorCode, message: string): AppError {
  return { code, message };
}

export function transportError(message: string): AppError {
  return { code: "TRANSPORT_ERROR", message };
}

// Tauri invokeの拒否値をAppErrorへ正規化する。
// 既知code+string messageを持つ場合だけコピーし、それ以外はTRANSPORT_ERROR。
export function normalizeInvokeRejection(reason: unknown): AppError {
  if (isAppError(reason)) {
    return { code: reason.code, message: reason.message };
  }
  if (typeof reason === "string") {
    return transportError(`invoke rejected with string: ${reason.slice(0, 200)}`);
  }
  if (reason instanceof Error) {
    return transportError(`invoke rejected: ${reason.message.slice(0, 200)}`);
  }
  try {
    const s = JSON.stringify(reason)?.slice(0, 200) ?? String(reason);
    return transportError(`invoke rejected with unknown value: ${s}`);
  } catch {
    return transportError("invoke rejected with unknown value");
  }
}
