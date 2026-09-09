import type {
  AppError,
  ApplicationApi,
  RuntimeInfo,
  TransformRequest,
  TransformResult,
} from "../../api/application-api";
import { appError } from "../../api/errors";
import {
  validateRuntimeInfo,
  validateTransformRequest,
  validateTransformResult,
} from "../../api/validation";
import { RequestState } from "../request-state";
import { checkResultLength, isSingleFailure, raceWithGuard, toErrorCode } from "../pipeline";
import { WORKER_PROTOCOL_VERSION } from "./worker-protocol";
import type { WorkerResponse } from "./worker-protocol";

export interface BrowserBackendDeps {
  readonly workerFactory?: () => Worker;
  readonly moduleUrl?: string;
  readonly wasmUrl?: string;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

function buildUrls(): { moduleUrl: string; wasmUrl: string } {
  // UI側で new URL(import.meta.env.BASE_URL, document.baseURI) を基準にする。
  // baseは / または /poc/ のような末尾slash付きpathに限定する。
  const baseEnv = (import.meta.env.BASE_URL as string | undefined) ?? "/";
  const base = new URL(baseEnv, document.baseURI);
  const moduleUrl = new URL("wasm/poc-core.mjs", base).toString();
  const wasmUrl = new URL("wasm/poc-core.wasm", base).toString();
  return { moduleUrl, wasmUrl };
}

// test用にexportする。製品動作は変えない。
export { buildUrls };

class BrowserBackend implements ApplicationApi {
  private readonly worker: Worker;
  private readonly state: RequestState;

  constructor(worker: Worker, deps: BrowserBackendDeps = {}) {
    this.worker = worker;
    this.state = new RequestState({
      initTimeoutMs: deps.initTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
      onFatal: () => {
        try {
          this.worker.onmessage = null;
          this.worker.onerror = null;
          this.worker.onmessageerror = null;
        } catch {
          // ignore
        }
        try {
          this.worker.terminate();
        } catch {
          // ignore
        }
      },
      onDispose: () => {
        try {
          this.worker.onmessage = null;
          this.worker.onerror = null;
          this.worker.onmessageerror = null;
        } catch {
          // ignore
        }
        try {
          this.worker.terminate();
        } catch {
          // ignore
        }
      },
    });
  }

  // 送信済み要求の対応表。methodと応答待ちを同一entryに持ち、二重管理を防ぐ。
  // timeout・世代管理はRequestState側、応答の対応付けだけをこちらが持つ。
  // entryの登録は送信より前に同期で行い、postMessage失敗時はfailAllと同時に消す。
  private readonly pending = new Map<
    number,
    {
      method: "getInfo" | "transform";
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  >();

  async init(moduleUrl: string, wasmUrl: string): Promise<void> {
    // event listenerとpendingを先に用意してからinitを送る
    const reg = this.state.register("getInfo", { init: true });
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    this.attachListeners();
    const replyP = this.defer(id, "getInfo");
    try {
      this.worker.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        id,
        method: "init",
        moduleUrl,
        wasmUrl,
      });
    } catch (e) {
      const err = appError("TRANSPORT_ERROR", `postMessage failed: ${String(e).slice(0, 200)}`);
      this.state.failAll(err);
      this.pending.delete(id);
      throw err;
    }
    try {
      const raw = await raceWithGuard(replyP, guard, () => this.state.getSavedFailure(), "init timed out");
      const core = this.extractCore(raw);
      if (!core.ok) {
        this.state.failAll(core.error);
        this.pending.delete(id);
        this.state.rejectOne(id, core.error);
        throw core.error;
      }
      this.state.resolveOne(id, core.data);
      this.pending.delete(id);
      this.state.markReady();
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") throw saved;
      const err = appError("INITIALIZATION_FAILED", `init failed: ${String((e as { message?: string })?.message ?? e).slice(0, 300)}`);
      this.state.failAll(err);
      this.pending.delete(id);
      throw err;
    }
  }

  // entry登録と応答待ちを一体で行う。送信より前に呼ぶ。
  private defer(id: number, method: "getInfo" | "transform"): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  private attachListeners(): void {
    this.worker.onmessage = (ev: MessageEvent<unknown>) => {
      this.onWorkerMessage(ev.data);
    };
    this.worker.onerror = () => {
      // Workerの未捕捉errorはWORKER_FAILEDで全pending終了・failedへ
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      this.state.failAll(appError("WORKER_FAILED", "worker error"));
      this.rejectAllReplies(this.state.getSavedFailure()!);
    };
    this.worker.onmessageerror = () => {
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", "worker messageerror");
      this.state.failAll(err);
      this.rejectAllReplies(err);
    };
  }

  private rejectAllReplies(err: { code: string; message: string }): void {
    for (const [, entry] of this.pending) {
      try {
        entry.reject(err);
      } catch {
        // ignore
      }
    }
    this.pending.clear();
  }

  private extractCore(raw: unknown):
    | { ok: true; data: { abiVersion: number; version: string } }
    | { ok: false; error: AppError } {
    const d = raw as { ok?: unknown; data?: unknown };
    if (typeof d !== "object" || d === null || d.ok !== true) {
      const err = (raw as { error?: { code?: string; message?: string } }).error;
      if (err && typeof err.code === "string") {
        if (err.code === "ABI_MISMATCH") {
          return { ok: false, error: { code: "ABI_MISMATCH", message: err.message ?? "abi mismatch" } };
        }
        if (err.code === "INITIALIZATION_FAILED") {
          return { ok: false, error: { code: "INITIALIZATION_FAILED", message: err.message ?? "init failed" } };
        }
      }
      return { ok: false, error: { code: "TRANSPORT_ERROR", message: "invalid init reply" } };
    }
    const data = d.data as { abiVersion?: unknown; version?: unknown };
    if (typeof data?.abiVersion !== "number" || typeof data?.version !== "string") {
      return { ok: false, error: { code: "TRANSPORT_ERROR", message: "invalid core info" } };
    }
    if (data.abiVersion !== 1) {
      return { ok: false, error: { code: "ABI_MISMATCH", message: `unsupported ABI ${String(data.abiVersion)}` } };
    }
    return { ok: true, data: { abiVersion: data.abiVersion, version: data.version } };
  }

  private onWorkerMessage(data: unknown): void {
    // 返信検査: version、id、method、okとpayloadを検査
    const d = data as Partial<WorkerResponse> & Record<string, unknown>;
    const protocolVersion = d.protocolVersion;
    const id = d.id;
    const method = d.method;
    const ok = d.ok;
    if (
      protocolVersion !== WORKER_PROTOCOL_VERSION ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      (method !== "init" && method !== "getInfo" && method !== "transform") ||
      typeof ok !== "boolean"
    ) {
      // 壊れた返信はTRANSPORT_ERRORで全pending終了
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", "invalid worker reply");
      this.state.failAll(err);
      this.rejectAllReplies(err);
      return;
    }
    const cls = this.state.classifyReplyId(id);
    if (cls === "stale") {
      // 発行済みで対応表にないidは破棄。応答済みの重複返信はここで消える。
      this.pending.delete(id);
      return;
    }
    if (cls === "invalid") {
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", `unknown reply id=${String(id)}`);
      this.state.failAll(err);
      this.rejectAllReplies(err);
      return;
    }
    // pendingにある。対応表はdeferで同期登録するため、分類pendingのidは必ず存在する。
    const entry = this.pending.get(id);
    if (!entry) {
      // 到達不能な防御。分類と対応表がずれたら破棄する。
      return;
    }
    if (entry.method !== method && !(entry.method === "getInfo" && method === "init")) {
      // pendingのmethod不一致はTRANSPORT_ERROR
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", `method mismatch id=${String(id)}`);
      this.state.failAll(err);
      this.rejectAllReplies(err);
      return;
    }
    this.pending.delete(id);
    // 正常系はresolverへ渡し、各公開メソッドのraceが処理する
    entry.resolve(data);
  }

  async getInfo(): Promise<RuntimeInfo> {
    this.state.throwIfNotReady();
    const reg = this.state.register("getInfo");
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    const replyP = this.defer(id, "getInfo");
    try {
      this.worker.postMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id, method: "getInfo" });
    } catch (e) {
      const err = appError("TRANSPORT_ERROR", `postMessage failed: ${String(e).slice(0, 200)}`);
      this.state.failAll(err);
      this.pending.delete(id);
      throw err;
    }
    try {
      const raw = await raceWithGuard(replyP, guard, () => this.state.getSavedFailure(), "timed out");
      const d = raw as WorkerResponse;
      if (!d.ok) {
        const code = toErrorCode(
          (d as { error?: { code?: string } }).error?.code,
          "TRANSPORT_ERROR",
        );
        const msg = (d as { error?: { message?: string } }).error?.message ?? "worker failed";
        const err = appError(code, msg);
        if (isSingleFailure(code)) {
          this.state.rejectOne(id, err);
          this.pending.delete(id);
          throw err;
        }
        this.state.failAll(err);
        this.pending.delete(id);
        throw err;
      }
      const core = (d as { data?: { abiVersion?: unknown; version?: unknown } }).data!;
      // BrowserBackendが browser / wasm-worker / dedicated-worker を付ける
      const info: RuntimeInfo = {
        apiVersion: 1,
        backend: "wasm-worker",
        hostOs: "browser",
        execution: "dedicated-worker",
        core: { abiVersion: core.abiVersion as number, version: core.version as string },
      };
      const checked = validateRuntimeInfo(info);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.pending.delete(id);
        throw checked.error;
      }
      this.state.resolveOne(id, info);
      this.pending.delete(id);
      return checked.info;
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        this.pending.delete(id);
        throw saved;
      }
      throw e;
    }
  }

  async transform(request: TransformRequest): Promise<TransformResult> {
    this.state.throwIfNotReady();
    const v = validateTransformRequest(request as unknown);
    if (!v.ok) throw v.error;
    const snap = v.validated.snapshot();
    const reg = this.state.register("transform");
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    const replyP = this.defer(id, "transform");
    try {
      this.worker.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        id,
        method: "transform",
        payload: snap,
      });
    } catch (e) {
      const err = appError("TRANSPORT_ERROR", `postMessage failed: ${String(e).slice(0, 200)}`);
      this.state.failAll(err);
      this.pending.delete(id);
      throw err;
    }
    try {
      const raw = await raceWithGuard(replyP, guard, () => this.state.getSavedFailure(), "timed out");
      const d = raw as WorkerResponse;
      if (!d.ok) {
        const code = toErrorCode(
          (d as { error?: { code?: string } }).error?.code,
          "TRANSPORT_ERROR",
        );
        const msg = (d as { error?: { message?: string } }).error?.message ?? "worker failed";
        const err = appError(code, msg);
        if (isSingleFailure(code)) {
          this.state.rejectOne(id, err);
          this.pending.delete(id);
          throw err;
        }
        this.state.failAll(err);
        this.pending.delete(id);
        throw err;
      }
      const data = (d as { data?: unknown }).data;
      const checked = validateTransformResult(data);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.pending.delete(id);
        throw checked.error;
      }
      const lengthError = checkResultLength(checked.result.values.length, snap.values.length);
      if (lengthError) {
        this.state.failAll(lengthError);
        this.pending.delete(id);
        throw lengthError;
      }
      this.state.resolveOne(id, checked.result);
      this.pending.delete(id);
      // validationでtransportから切り離し済みのfreeze配列をそのまま返す (再コピー不要)。
      return checked.result;
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        this.pending.delete(id);
        throw saved;
      }
      throw e;
    }
  }

  async dispose(): Promise<void> {
    // disposeはtimerを待たず自分でDISPOSED終了してからWorkerを停止する
    const err = appError("DISPOSED", "disposed");
    for (const [, entry] of this.pending) {
      try {
        entry.reject(err);
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    this.state.dispose();
  }

  debugState(): { lifecycle: string; pending: number } {
    return { lifecycle: this.state.lifecycle, pending: this.state.pendingCount };
  }

  get nextIdForTest(): number {
    return this.state.currentNextId;
  }
}

// 公開factoryでWorkerを1個作る。静的構文を保つ。
export async function createBrowserBackend(
  deps: BrowserBackendDeps = {},
): Promise<ApplicationApi> {
  const worker = deps.workerFactory
    ? deps.workerFactory()
    : new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
  const urls = deps.moduleUrl && deps.wasmUrl ? { moduleUrl: deps.moduleUrl, wasmUrl: deps.wasmUrl } : buildUrls();
  const backend = new BrowserBackend(worker, deps);
  await backend.init(urls.moduleUrl, urls.wasmUrl);
  return backend;
}

// composition root用の統一名
export const createBackend = createBrowserBackend;

// test用の注入は内部関数のみ
export function createBrowserBackendForTest(
  worker: Worker,
  deps: BrowserBackendDeps = {},
): BrowserBackend {
  return new BrowserBackend(worker, deps);
}
