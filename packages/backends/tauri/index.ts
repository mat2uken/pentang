import type {
  ApplicationApi,
  RuntimeInfo,
  TransformRequest,
  TransformResult,
} from "../../api/application-api";
import { appError, normalizeInvokeRejection } from "../../api/errors";
import {
  validateRuntimeInfo,
  validateTransformRequest,
  validateTransformResult,
} from "../../api/validation";
import { RequestState } from "../request-state";
import { checkResultLength, isSingleFailure, raceWithGuard } from "../pipeline";

export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

async function realInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const mod = await import("@tauri-apps/api/core");
  return (mod as { invoke: InvokeFn }).invoke(cmd, args);
}

export interface TauriBackendDeps {
  readonly invoke?: InvokeFn;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

class TauriBackend implements ApplicationApi {
  private readonly invoke: InvokeFn;
  private readonly state: RequestState;

  constructor(deps: TauriBackendDeps = {}) {
    this.invoke = deps.invoke ?? realInvoke;
    this.state = new RequestState({
      initTimeoutMs: deps.initTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    });
  }

  // factoryはinit扱いで実getInfoを待ち、応答/ABI検査後にresolveする。
  async init(): Promise<void> {
    let guardId = -1;
    let guard: Promise<unknown> | null = null;
    try {
      const reg = this.state.register("getInfo", { init: true });
      guardId = reg.id;
      guard = reg.promise;
      // unhandled抑止のためcatchを付ける (raceでも処理するが二重安全)
      guard.catch(() => {});
      const invokeP = this.invoke("poc_get_info");
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "init timed out");
      const checked = validateRuntimeInfo(raw);
      if (!checked.ok) {
        // 形が正しくABIだけ違う場合はABI_MISMATCHでfailedへ
        this.state.failAll(checked.error);
        throw checked.error;
      }
      // invoke開始前にpending登録済み、成功でtimerを片付ける
      this.state.resolveOne(guardId, checked.info);
      this.state.markReady();
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        // TIMEOUT等で既にfailed化済み
        throw saved;
      }
      const normalized = normalizeInvokeRejection(e);
      // 初期化失敗はINITIALIZATION_FAILED等でfailed化し、timer/listenerを片付ける
      const code =
        normalized.code === "ABI_MISMATCH" ||
        normalized.code === "TIMEOUT" ||
        normalized.code === "TRANSPORT_ERROR" ||
        normalized.code === "CORE_FAILURE"
          ? normalized
          : appError(
              "INITIALIZATION_FAILED",
              `init failed: ${normalized.code}: ${normalized.message}`,
            );
      // guardが残っていれば片付ける
      if (guardId >= 0) {
        this.state.rejectOne(guardId, code);
      }
      this.state.failAll(code);
      // 初期化に失敗したインスタンスを公開APIとして返さないため、factory側でrejectする
      throw code;
    }
  }

  async getInfo(): Promise<RuntimeInfo> {
    this.state.throwIfNotReady();
    const reg = this.state.register("getInfo");
    const guard = reg.promise;
    guard.catch(() => {});
    const invokeP = this.invoke("poc_get_info");
    try {
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "timed out");
      const checked = validateRuntimeInfo(raw);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.state.rejectOne(reg.id, checked.error);
        throw checked.error;
      }
      this.state.resolveOne(reg.id, checked.info);
      return checked.info;
    } catch (e) {
      // guard起因のTIMEOUT/failedは保存した失敗を返す
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        // invoke側の遅延到着はstaleとして破棄される (pending削除済み)
        throw saved;
      }
      const normalized = normalizeInvokeRejection(e);
      if (isSingleFailure(normalized.code)) {
        // 当該要求だけreject、ready維持 (通常はgetInfoで単発エラーは起きないが規定どおり)
        this.state.rejectOne(reg.id, normalized);
        throw normalized;
      }
      this.state.failAll(normalized);
      this.state.rejectOne(reg.id, normalized);
      throw normalized;
    }
  }

  async transform(request: TransformRequest): Promise<TransformResult> {
    this.state.throwIfNotReady();
    // 入力検証と応答検証は小さな共通関数。検査済み入力を最初のawaitより前にコピーする。
    const v = validateTransformRequest(request as unknown);
    if (!v.ok) throw v.error;
    const snap = v.validated.snapshot();
    const reg = this.state.register("transform");
    const guard = reg.promise;
    guard.catch(() => {});
    // invoke開始前にpending登録済み
    const invokeP = this.invoke("poc_transform", { request: snap });
    try {
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "timed out");
      // 成功値の形を検査する。field欠落・余分・不正型はTRANSPORT_ERROR。
      const checked = validateTransformResult(raw);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.state.rejectOne(reg.id, checked.error);
        throw checked.error;
      }
      // 出力長が要求と一致するかも検査する (壊れた応答の拒否)
      const lengthError = checkResultLength(checked.result.values.length, snap.values.length);
      if (lengthError) {
        this.state.failAll(lengthError);
        this.state.rejectOne(reg.id, lengthError);
        throw lengthError;
      }
      this.state.resolveOne(reg.id, checked.result);
      // validationでtransportから切り離し済みのfreeze配列をそのまま返す (再コピー不要)。
      // 入力・他要求から独立し、readonlyのためcallerが壊せない。
      return checked.result;
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        throw saved;
      }
      const normalized = normalizeInvokeRejection(e);
      // AppErrorのうち単発で済むものは当該要求だけrejectしready維持
      if (isSingleFailure(normalized.code)) {
        this.state.rejectOne(reg.id, normalized);
        throw normalized;
      }
      // Cの予期しないstatus、内部不備、IPC送受信失敗等はfailedへ
      this.state.failAll(normalized);
      this.state.rejectOne(reg.id, normalized);
      throw normalized;
    }
  }

  async dispose(): Promise<void> {
    this.state.dispose();
  }

  /** test用: 現在のlifecycleとpending数 */
  debugState(): { lifecycle: string; pending: number } {
    return { lifecycle: this.state.lifecycle, pending: this.state.pendingCount };
  }
}

// 公開factoryは引数なし
export async function createTauriBackend(): Promise<ApplicationApi> {
  const backend = new TauriBackend();
  await backend.init();
  return backend;
}

// composition root用の統一名 (web/nativeで同じapps/poc-demo/main.ts/ui.tsを使う)
export const createBackend = createTauriBackend;

// test用のinvoke/clock注入は内部関数だけに設ける
export async function createTauriBackendWithDeps(
  deps: TauriBackendDeps,
): Promise<ApplicationApi> {
  const backend = new TauriBackend(deps);
  await backend.init();
  return backend;
}

export function createTauriBackendForTest(deps: TauriBackendDeps): TauriBackend {
  return new TauriBackend(deps);
}
