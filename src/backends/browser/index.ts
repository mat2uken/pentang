import type {
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

const SINGLE_CODES = new Set([
  "INVALID_ARGUMENT",
  "LIMIT_EXCEEDED",
  "BUSY",
  "OUT_OF_MEMORY",
]);

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
  private nextLocalId = 1;

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

  static createWithUrls(
    worker: Worker,
    moduleUrl: string,
    wasmUrl: string,
    deps: BrowserBackendDeps = {},
  ): BrowserBackend {
    const backend = new BrowserBackend(worker, deps);
    void backend.init(moduleUrl, wasmUrl);
    return backend;
  }

  private pendingById = new Map<number, { method: "getInfo" | "transform"; expectedLen?: number }>();

  async init(moduleUrl: string, wasmUrl: string): Promise<void> {
    // event listenerとpendingを先に用意してからinitを送る
    const reg = this.state.register("getInfo", { init: true });
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    this.pendingById.set(id, { method: "getInfo" });
    this.attachListeners();
    const replyP = this.waitForReply(id, "init");
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
      this.pendingById.delete(id);
      this.replyResolvers.delete(id);
      throw err;
    }
    try {
      const raw = await Promise.race([
        replyP,
        guard.then(() => {
          throw this.state.getSavedFailure() ?? appError("TIMEOUT", "init timed out");
        }),
      ]);
      const core = this.extractCore(raw);
      if (!core.ok) {
        this.state.failAll(core.error);
        this.pendingById.delete(id);
        this.state.rejectOne(id, core.error);
        throw core.error;
      }
      this.state.resolveOne(id, core.data);
      this.pendingById.delete(id);
      this.state.markReady();
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") throw saved;
      const err = appError("INITIALIZATION_FAILED", `init failed: ${String((e as { message?: string })?.message ?? e).slice(0, 300)}`);
      this.state.failAll(err);
      this.pendingById.delete(id);
      throw err;
    }
  }

  private replyResolvers = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  private waitForReply(id: number, _method: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.replyResolvers.set(id, { resolve, reject });
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
    for (const [, r] of this.replyResolvers) {
      try {
        r.reject(err);
      } catch {
        // ignore
      }
    }
    this.replyResolvers.clear();
    this.pendingById.clear();
  }

  private extractCore(raw: unknown):
    | { ok: true; data: { abiVersion: number; version: string } }
    | { ok: false; error: { code: "ABI_MISMATCH" | "TRANSPORT_ERROR" | "INITIALIZATION_FAILED"; message: string } } {
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
      // 発行済みでpendingにないidは破棄
      const r = this.replyResolvers.get(id);
      if (r) {
        // 既に完了したものへの重複返信は破棄し、新しい要求やUIを変更しない
        this.replyResolvers.delete(id);
      }
      return;
    }
    if (cls === "invalid") {
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", `unknown reply id=${String(id)}`);
      this.state.failAll(err);
      this.rejectAllReplies(err);
      return;
    }
    // pendingにある
    const pending = this.pendingById.get(id);
    if (!pending) {
      // classifyではpendingだが詳細不明 (通常起きない)。staleとして破棄する。
      return;
    }
    if (pending.method !== method && !(pending.method === "getInfo" && method === "init")) {
      // pendingのmethod不一致はTRANSPORT_ERROR
      if (this.state.lifecycle === "failed" || this.state.lifecycle === "disposed") return;
      const err = appError("TRANSPORT_ERROR", `method mismatch id=${String(id)}`);
      this.state.failAll(err);
      this.rejectAllReplies(err);
      return;
    }
    const resolver = this.replyResolvers.get(id);
    if (!resolver) return;
    this.replyResolvers.delete(id);
    // 正常系はresolverへ渡し、各公開メソッドのraceが処理する
    resolver.resolve(data);
  }

  async getInfo(): Promise<RuntimeInfo> {
    try {
      this.state.throwIfNotReady();
    } catch (e) {
      throw e;
    }
    const reg = this.state.register("getInfo");
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    this.pendingById.set(id, { method: "getInfo" });
    const replyP = this.waitForReply(id, "getInfo");
    try {
      this.worker.postMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id, method: "getInfo" });
    } catch (e) {
      const err = appError("TRANSPORT_ERROR", `postMessage failed: ${String(e).slice(0, 200)}`);
      this.state.failAll(err);
      this.pendingById.delete(id);
      this.replyResolvers.delete(id);
      throw err;
    }
    try {
      const raw = await Promise.race([
        replyP,
        guard.then(() => {
          throw this.state.getSavedFailure() ?? appError("TIMEOUT", "timed out");
        }),
      ]);
      const d = raw as WorkerResponse;
      if (!d.ok) {
        const code = (d as { error?: { code?: string } }).error?.code ?? "TRANSPORT_ERROR";
        const msg = (d as { error?: { message?: string } }).error?.message ?? "worker failed";
        const err = appError(code as never, msg);
        if (SINGLE_CODES.has(code)) {
          this.state.rejectOne(id, err);
          this.pendingById.delete(id);
          this.replyResolvers.delete(id);
          throw err;
        }
        this.state.failAll(err);
        this.pendingById.delete(id);
        this.replyResolvers.delete(id);
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
        this.pendingById.delete(id);
        throw checked.error;
      }
      this.state.resolveOne(id, info);
      this.pendingById.delete(id);
      return checked.info;
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        this.pendingById.delete(id);
        this.replyResolvers.delete(id);
        throw saved;
      }
      throw e;
    }
  }

  async transform(request: TransformRequest): Promise<TransformResult> {
    try {
      this.state.throwIfNotReady();
    } catch (e) {
      throw e;
    }
    const v = validateTransformRequest(request as unknown);
    if (!v.ok) throw v.error;
    const snap = v.validated.snapshot();
    let reg: { id: number; promise: Promise<unknown> };
    try {
      reg = this.state.register("transform");
    } catch (e) {
      throw e;
    }
    const guard = reg.promise;
    guard.catch(() => {});
    const id = reg.id;
    this.pendingById.set(id, { method: "transform", expectedLen: snap.values.length });
    const replyP = this.waitForReply(id, "transform");
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
      this.pendingById.delete(id);
      this.replyResolvers.delete(id);
      throw err;
    }
    try {
      const raw = await Promise.race([
        replyP,
        guard.then(() => {
          throw this.state.getSavedFailure() ?? appError("TIMEOUT", "timed out");
        }),
      ]);
      const d = raw as WorkerResponse;
      if (!d.ok) {
        const code = (d as { error?: { code?: string } }).error?.code ?? "TRANSPORT_ERROR";
        const msg = (d as { error?: { message?: string } }).error?.message ?? "worker failed";
        const err = appError(code as never, msg);
        if (SINGLE_CODES.has(code)) {
          this.state.rejectOne(id, err);
          this.pendingById.delete(id);
          this.replyResolvers.delete(id);
          throw err;
        }
        this.state.failAll(err);
        this.pendingById.delete(id);
        this.replyResolvers.delete(id);
        throw err;
      }
      const data = (d as { data?: unknown }).data;
      const checked = validateTransformResult(data);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.pendingById.delete(id);
        throw checked.error;
      }
      if (checked.result.values.length !== snap.values.length) {
        const err = appError("TRANSPORT_ERROR", "result length mismatch");
        this.state.failAll(err);
        this.pendingById.delete(id);
        throw err;
      }
      this.state.resolveOne(id, checked.result);
      this.pendingById.delete(id);
      return { values: [...checked.result.values], checksum: checked.result.checksum };
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        this.pendingById.delete(id);
        this.replyResolvers.delete(id);
        throw saved;
      }
      throw e;
    }
  }

  async dispose(): Promise<void> {
    // disposeはtimerを待たず自分でDISPOSED終了してからWorkerを停止する
    const err = appError("DISPOSED", "disposed");
    for (const [, r] of this.replyResolvers) {
      try {
        r.reject(err);
      } catch {
        // ignore
      }
    }
    this.replyResolvers.clear();
    this.pendingById.clear();
    this.state.dispose();
  }

  debugState(): { lifecycle: string; pending: number } {
    return { lifecycle: this.state.lifecycle, pending: this.state.pendingCount };
  }

  get nextIdForTest(): number {
    void this.nextLocalId;
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
