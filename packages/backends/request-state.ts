import type { AppError } from "../api/application-api";
import { appError } from "../api/errors";

export type LifecycleState = "creating" | "ready" | "failed" | "disposed";
export type PendingMethod = "getInfo" | "transform";

interface PendingEntry {
  readonly id: number;
  readonly method: PendingMethod;
  readonly resolve: (value: unknown | PromiseLike<unknown>) => void;
  readonly reject: (err: AppError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export interface RequestStateOptions {
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly onFatal?: () => void;
  readonly onDispose?: () => void;
}

const MAX_PENDING = 8;

export class RequestState {
  private state: LifecycleState = "creating";
  private savedFailure: AppError | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly initTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly onFatal: (() => void) | null;
  private readonly onDispose: (() => void) | null;

  constructor(opts: RequestStateOptions = {}) {
    this.initTimeoutMs = opts.initTimeoutMs ?? 15000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    // ブラウザでは裸のsetTimeout参照をthis付きで呼ぶとIllegal invocationになるため、
    // globalThis経由で呼ぶラッパを既定にする。
    this.setTimeoutFn =
      opts.setTimeoutFn ??
      (((fn: (...a: never[]) => void, ms?: number, ...args: never[]) =>
        globalThis.setTimeout(fn, ms, ...args)) as unknown as typeof setTimeout);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      (((h: Parameters<typeof clearTimeout>[0]) =>
        globalThis.clearTimeout(h)) as unknown as typeof clearTimeout);
    this.onFatal = opts.onFatal ?? null;
    this.onDispose = opts.onDispose ?? null;
  }

  get lifecycle(): LifecycleState {
    return this.state;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get currentNextId(): number {
    return this.nextId;
  }

  markReady(): void {
    if (this.state === "creating") this.state = "ready";
  }

  markInitFailed(error: AppError): void {
    if (this.state !== "creating") return;
    this.state = "failed";
    this.savedFailure = error;
    // 待機中の初期化promiseを残さない。failAllと同様に全pendingを拒否する。
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) {
      e.settled = true;
      if (e.timer) this.clearTimeoutFn(e.timer);
      try {
        e.reject(error);
      } catch {
        // ignore
      }
    }
    this.onFatal?.();
  }

  // 送信前に呼ぶ。DISPOSED/failed/BUSY/id上限を検査する。
  ensureCanSend(): void {
    if (this.state === "disposed") {
      throw this.savedFailure ?? appError("DISPOSED", "disposed");
    }
    if (this.state === "failed" && this.savedFailure) {
      throw this.savedFailure;
    }
    if (this.pending.size >= MAX_PENDING) {
      throw appError("BUSY", "too many pending requests");
    }
    if (!Number.isSafeInteger(this.nextId) || this.nextId <= 0) {
      const err = appError("TRANSPORT_ERROR", "request id exhausted");
      this.failAll(err);
      throw err;
    }
  }

  // pending登録は送信より前に行う。timerは送信から計測する。
  register(
    method: PendingMethod,
    opts: { init?: boolean } = {},
  ): { id: number; promise: Promise<unknown> } {
    this.ensureCanSend();
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = opts.init ? this.initTimeoutMs : this.requestTimeoutMs;
    let entry!: PendingEntry;
    const promise = new Promise<unknown>((resolve, reject) => {
      entry = {
        id,
        method,
        resolve,
        reject,
        timer: null,
        settled: false,
      };
    });
    entry.timer = this.setTimeoutFn(() => {
      this.onTimeout();
    }, timeoutMs);
    // unref可能なら保持しない (Nodeのtestで終了を妨げない)
    const t = entry.timer as unknown as { unref?: () => void };
    if (typeof t?.unref === "function") {
      try {
        t.unref();
      } catch {
        // ignore
      }
    }
    this.pending.set(id, entry);
    // promiseに何もしないとunhandledになるため、呼び出し側で必ずcatchすること。
    // ここでは握りつぶさない。
    return { id, promise };
  }

  resolveOne(id: number, value: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    if (entry.timer) this.clearTimeoutFn(entry.timer);
    this.pending.delete(id);
    entry.resolve(value);
    return true;
  }

  rejectOne(id: number, error: AppError): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    if (entry.timer) this.clearTimeoutFn(entry.timer);
    this.pending.delete(id);
    entry.reject(error);
    return true;
  }

  private onTimeout(): void {
    if (this.state === "disposed" || this.state === "failed") return;
    // 監視は停止検知用。期限到達時に全pendingを1回だけTIMEOUTで終了しfailedへ。
    this.failAll(appError("TIMEOUT", "request timed out"));
  }

  // TIMEOUTや通信の致命的失敗では全pendingを同じ原因で1回だけrejectしfailedへ。
  failAll(error: AppError): void {
    if (this.state === "disposed") return;
    if (this.state === "failed") return;
    this.state = "failed";
    this.savedFailure = error;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) {
      if (e.settled) continue;
      e.settled = true;
      if (e.timer) this.clearTimeoutFn(e.timer);
      try {
        e.reject(error);
      } catch {
        // ignore
      }
    }
    this.onFatal?.();
  }

  // disposeは常に冪等で、既にfailedでも成功する。
  dispose(): void {
    if (this.state === "disposed") return;
    const err = appError("DISPOSED", "disposed");
    this.savedFailure = err;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) {
      if (e.settled) continue;
      e.settled = true;
      if (e.timer) this.clearTimeoutFn(e.timer);
      try {
        e.reject(err);
      } catch {
        // ignore
      }
    }
    this.state = "disposed";
    this.onDispose?.();
  }

  getSavedFailure(): AppError | null {
    return this.savedFailure;
  }

  // 返信idの分類: pendingにある→処理、発行済みで完了済み→破棄、未発行/不正→TRANSPORT_ERROR。
  // idは1から単調増加し再利用しないため、発行済み判定は nextId との比較で十分。
  // 完了済みidを別集合に保持すると長期運用で無制限に増えるため、比較で判定する。
  classifyReplyId(id: unknown): "pending" | "stale" | "invalid" {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return "invalid";
    }
    if (this.pending.has(id)) return "pending";
    // 単調増加・再利用なしのため、nextId未満は発行済みとみなす
    if (id < this.nextId) return "stale";
    return "invalid";
  }

  throwIfNotReady(): void {
    if (this.state === "disposed") {
      throw this.savedFailure ?? appError("DISPOSED", "disposed");
    }
    if (this.state === "failed" && this.savedFailure) {
      throw this.savedFailure;
    }
    if (this.state !== "ready") {
      throw appError("INITIALIZATION_FAILED", "not ready");
    }
  }
}
