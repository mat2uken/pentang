import type { AppError, AppErrorCode } from "../api/application-api";
import { appError, isAppErrorCode } from "../api/errors";

// 両Backendで同一にする失敗分類。片方だけ更新される分岐を防ぐsingle source of truth。
// 当該要求だけrejectしてready維持できるcodeの一覧。
const SINGLE_FAILURE_CODES: ReadonlySet<AppErrorCode> = new Set([
  "INVALID_ARGUMENT",
  "LIMIT_EXCEEDED",
  "BUSY",
  "OUT_OF_MEMORY",
]);

export function isSingleFailure(code: unknown): code is AppErrorCode {
  return isAppErrorCode(code) && SINGLE_FAILURE_CODES.has(code);
}

// 応答に載ったcode文字列をAppErrorCodeへ正規化する。未知・欠落はfallback。
export function toErrorCode(code: unknown, fallback: AppErrorCode): AppErrorCode {
  return isAppErrorCode(code) ? code : fallback;
}

// 応答待ちと監視タイマの競争。期限側が先に終わったら保存済み失敗を投げる。
// 保存済みがない異常系ではTIMEOUTに倒す。6箇所 (両Backend×init/getInfo/transform) の同一形。
export function raceWithGuard<T>(
  reply: Promise<T>,
  guard: Promise<unknown>,
  getSavedFailure: () => AppError | null,
  timeoutMessage: "init timed out" | "timed out",
): Promise<T> {
  return Promise.race([
    reply,
    guard.then((): T => {
      throw getSavedFailure() ?? appError("TIMEOUT", timeoutMessage);
    }),
  ]);
}

// 応答長の検査。C++を実行した結果の取り違え (他要求の混入) を拒否する。
export function checkResultLength(actual: number, expected: number): AppError | null {
  return actual === expected
    ? null
    : appError("TRANSPORT_ERROR", "result length mismatch");
}
