import { describe, expect, it, vi } from "vitest";
import { RequestState } from "../../packages/backends/request-state";

describe("request-state full branches", () => {
  it("markReady only from creating; markInitFailed clears and onFatal", () => {
    const onFatal = vi.fn();
    const st = new RequestState({ onFatal });
    expect(st.lifecycle).toBe("creating");
    st.markReady();
    expect(st.lifecycle).toBe("ready");
    st.markReady();
    expect(st.lifecycle).toBe("ready");

    const st2 = new RequestState({ onFatal });
    const p = st2.register("transform").promise;
    p.catch(() => {});
    st2.markInitFailed({ code: "INITIALIZATION_FAILED", message: "bad" });
    expect(st2.lifecycle).toBe("failed");
    expect(st2.pendingCount).toBe(0);
    expect(onFatal).toHaveBeenCalled();
    // second markInitFailed ignored
    st2.markInitFailed({ code: "INITIALIZATION_FAILED", message: "again" });
    expect(st2.getSavedFailure()?.message).toBe("bad");
  });

  it("ensureCanSend: disposed/failed/BUSY/id exhausted", () => {
    const st = new RequestState();
    st.markReady();
    st.dispose();
    expect(() => st.ensureCanSend()).toThrowError(expect.objectContaining({ code: "DISPOSED" }));

    const stF = new RequestState();
    const pf = stF.register("transform").promise;
    pf.catch(() => {});
    stF.markInitFailed({ code: "INITIALIZATION_FAILED", message: "init bad" });
    expect(() => stF.ensureCanSend()).toThrowError(
      expect.objectContaining({ code: "INITIALIZATION_FAILED" }),
    );

    // id exhausted: force nextId to unsafe
    const stId = new RequestState();
    stId.markReady();
    (stId as unknown as { nextId: number }).nextId = Number.MAX_SAFE_INTEGER + 1;
    expect(() => stId.register("transform")).toThrowError(
      expect.objectContaining({ code: "TRANSPORT_ERROR" }),
    );
    expect(stId.lifecycle).toBe("failed");
  });

  it("register with init timeout uses initTimeoutMs", () => {
    vi.useFakeTimers();
    try {
      const st = new RequestState({ initTimeoutMs: 15000, requestTimeoutMs: 5000 });
      const p = st.register("getInfo", { init: true }).promise;
      p.catch(() => {});
      vi.advanceTimersByTime(5000);
      expect(st.lifecycle).toBe("creating");
      vi.advanceTimersByTime(10000);
      expect(st.lifecycle).toBe("failed");
      expect(st.getSavedFailure()?.code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolveOne/rejectOne false on unknown/settled; unref path", async () => {
    const st = new RequestState();
    st.markReady();
    expect(st.resolveOne(12345, "x")).toBe(false);
    expect(st.rejectOne(12345, { code: "TIMEOUT", message: "t" })).toBe(false);
    const { id, promise } = st.register("transform");
    promise.catch(() => {});
    expect(st.resolveOne(id, "ok")).toBe(true);
    expect(st.resolveOne(id, "again")).toBe(false);
    expect(st.rejectOne(id, { code: "TIMEOUT", message: "t" })).toBe(false);

    const { id: id2, promise: p2 } = st.register("getInfo");
    p2.catch(() => {});
    expect(st.rejectOne(id2, { code: "TIMEOUT", message: "t" })).toBe(true);
    expect(st.rejectOne(id2, { code: "TIMEOUT", message: "t" })).toBe(false);
  });

  it("onTimeout ignored when disposed/failed; failAll idempotent; dispose with onDispose", async () => {
    vi.useFakeTimers();
    try {
      const onDispose = vi.fn();
      const st = new RequestState({ requestTimeoutMs: 100, onDispose });
      st.markReady();
      const p = st.register("transform").promise;
      p.catch(() => {});
      st.dispose();
      expect(st.lifecycle).toBe("disposed");
      expect(onDispose).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(st.lifecycle).toBe("disposed");
      // failAll on disposed is no-op
      st.failAll({ code: "TIMEOUT", message: "x" });
      expect(st.lifecycle).toBe("disposed");
      st.dispose();
      expect(onDispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    const st2 = new RequestState();
    st2.markReady();
    const p2 = st2.register("transform").promise;
    p2.catch(() => {});
    st2.failAll({ code: "TIMEOUT", message: "t" });
    expect(st2.lifecycle).toBe("failed");
    const saved = st2.getSavedFailure();
    st2.failAll({ code: "TIMEOUT", message: "other" });
    expect(st2.getSavedFailure()).toBe(saved);
  });

  it("classifyReplyId: pending/stale/invalid incl non-number", () => {
    const st = new RequestState();
    st.markReady();
    const { id } = st.register("transform");
    expect(st.classifyReplyId(id)).toBe("pending");
    expect(st.classifyReplyId("1" as unknown as number)).toBe("invalid");
    expect(st.classifyReplyId(0)).toBe("invalid");
    expect(st.classifyReplyId(1.5)).toBe("invalid");
    expect(st.classifyReplyId(NaN)).toBe("invalid");
    // 解決後は単調id比較でstaleになる (別集合を持たない)
    st.resolveOne(id, "v");
    expect(st.classifyReplyId(id)).toBe("stale");
    // id < nextIdなら未使用でも発行済み扱いでstaleになる (単調性)
    expect(st.classifyReplyId(1)).toBe("stale");
    // 大きな未発行id -> invalid
    expect(st.classifyReplyId(999999)).toBe("invalid");
  });

  it("throwIfNotReady: all states", () => {
    const creating = new RequestState();
    expect(() => creating.throwIfNotReady()).toThrowError(
      expect.objectContaining({ code: "INITIALIZATION_FAILED" }),
    );
    const ready = new RequestState();
    ready.markReady();
    expect(() => ready.throwIfNotReady()).not.toThrow();
    const failed = new RequestState();
    const pf = failed.register("transform").promise;
    pf.catch(() => {});
    failed.markInitFailed({ code: "INITIALIZATION_FAILED", message: "bad" });
    expect(() => failed.throwIfNotReady()).toThrowError(
      expect.objectContaining({ code: "INITIALIZATION_FAILED" }),
    );
    const disp = new RequestState();
    disp.markReady();
    disp.dispose();
    expect(() => disp.throwIfNotReady()).toThrowError(expect.objectContaining({ code: "DISPOSED" }));
  });

  it("setTimeout unref throws are ignored; custom timer fns", () => {
    const badUnref = {
      unref() {
        throw new Error("unref boom");
      },
    };
    const setTimeoutFn = vi.fn(() => badUnref as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout;
    const st = new RequestState({ setTimeoutFn, clearTimeoutFn });
    st.markReady();
    const { id, promise } = st.register("transform");
    promise.catch(() => {});
    expect(setTimeoutFn).toHaveBeenCalled();
    st.resolveOne(id, "ok");
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  it("currentNextId increments; pendingCount", () => {
    const st = new RequestState();
    st.markReady();
    const start = st.currentNextId;
    const r1 = st.register("transform");
    r1.promise.catch(() => {});
    expect(st.currentNextId).toBe(start + 1);
    expect(st.pendingCount).toBe(1);
    st.resolveOne(r1.id, 1);
    expect(st.pendingCount).toBe(0);
  });

  it("null timer handles: resolve/reject/failAll/dispose skip clearing", async () => {
    const nullTimer = (() => null) as unknown as typeof setTimeout;
    const noopClear = (() => {}) as unknown as typeof clearTimeout;
    const st = new RequestState({ setTimeoutFn: nullTimer, clearTimeoutFn: noopClear });
    st.markReady();
    const r1 = st.register("transform");
    r1.promise.catch(() => {});
    expect(st.resolveOne(r1.id, 1)).toBe(true);
    const r2 = st.register("getInfo");
    r2.promise.catch(() => {});
    expect(st.rejectOne(r2.id, { code: "TIMEOUT", message: "t" })).toBe(true);
    const r3 = st.register("transform");
    r3.promise.catch(() => {});
    st.failAll({ code: "TIMEOUT", message: "t" });
    expect(st.lifecycle).toBe("failed");
    const st2 = new RequestState({ setTimeoutFn: nullTimer, clearTimeoutFn: noopClear });
    st2.markReady();
    const r4 = st2.register("transform");
    r4.promise.catch(() => {});
    st2.dispose();
    expect(st2.lifecycle).toBe("disposed");
    await r4.promise.catch(() => {});
    // null timerのままmarkInitFailedしても全pendingを拒否できる
    const st3 = new RequestState({ setTimeoutFn: nullTimer, clearTimeoutFn: noopClear });
    const r5 = st3.register("transform");
    const seen: string[] = [];
    r5.promise.catch((e) => seen.push((e as { code: string }).code));
    st3.markInitFailed({ code: "INITIALIZATION_FAILED", message: "x" });
    expect(st3.lifecycle).toBe("failed");
    await r5.promise.catch(() => {});
    expect(seen).toEqual(["INITIALIZATION_FAILED"]);
  });

  it("timeout after dispose is ignored (no failed transition)", () => {
    vi.useFakeTimers();
    try {
      // clearを無効化してtimerを生かしたままdisposeし、期限到達時の早期復帰を covering する
      const st = new RequestState({ requestTimeoutMs: 100, clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout });
      st.markReady();
      const p = st.register("transform").promise;
      p.catch(() => {});
      st.dispose();
      expect(st.lifecycle).toBe("disposed");
      vi.advanceTimersByTime(1000);
      expect(st.lifecycle).toBe("disposed");
      expect(st.getSavedFailure()?.code).toBe("DISPOSED");
    } finally {
      vi.useRealTimers();
    }
  });
});
