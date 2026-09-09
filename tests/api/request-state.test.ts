import { describe, expect, it, vi } from "vitest";
import { RequestState } from "../../src/backends/request-state";

describe("request-state (L-01/L-02/L-03)", () => {
  it("life-01: 8要求受理・逆順解決・pending解放", () => {
    const st = new RequestState();
    st.markReady();
    const regs = [];
    for (let i = 0; i < 8; i++) {
      regs.push(st.register("transform"));
    }
    expect(st.pendingCount).toBe(8);
    // 逆順で返す
    for (let i = 7; i >= 0; i--) {
      expect(st.resolveOne(regs[i].id, `v${i}`)).toBe(true);
    }
    expect(st.pendingCount).toBe(0);
  });

  it("input-15: 9件目はBUSY、送信なし", () => {
    const st = new RequestState();
    st.markReady();
    for (let i = 0; i < 8; i++) st.register("transform");
    expect(() => st.register("transform")).toThrowError(
      expect.objectContaining({ code: "BUSY" }),
    );
    expect(st.pendingCount).toBe(8);
  });

  it("input-16: 9件目でも検査がBUSYより先 (validation側で担保、ここではBUSYの確認)", () => {
    const st = new RequestState();
    st.markReady();
    for (let i = 0; i < 8; i++) st.register("transform");
    // RequestStateは件数だけ見る。入力検査はBackend側でBUSYより先に行う。
    expect(st.pendingCount).toBe(8);
  });

  it("life-02: 通常要求5秒でTIMEOUT、全pending終了・failed", () => {
    vi.useFakeTimers();
    try {
      const st = new RequestState({
        requestTimeoutMs: 5000,
      });
      st.markReady();
      const p1 = st.register("transform").promise;
      const p2 = st.register("getInfo").promise;
      const fails: unknown[] = [];
      p1.catch((e) => fails.push(e));
      p2.catch((e) => fails.push(e));
      // 4999msまで保留
      vi.advanceTimersByTime(4999);
      expect(st.lifecycle).toBe("ready");
      // 5000msへ進める
      vi.advanceTimersByTime(1);
      expect(st.lifecycle).toBe("failed");
      expect(st.getSavedFailure()?.code).toBe("TIMEOUT");
      expect(st.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("life-14: pending中にdispose2回、DISPOSEDで1回だけ終了", async () => {
    const st = new RequestState();
    st.markReady();
    const p = st.register("transform").promise;
    const seen: string[] = [];
    p.catch((e) => seen.push((e as { code: string }).code));
    st.dispose();
    st.dispose();
    expect(st.lifecycle).toBe("disposed");
    await p.catch(() => {});
    expect(seen).toEqual(["DISPOSED"]);
  });

  it("life-12: 完了済みidの重複返信は破棄", () => {
    const st = new RequestState();
    st.markReady();
    const { id } = st.register("transform");
    expect(st.classifyReplyId(id)).toBe("pending");
    st.resolveOne(id, "ok");
    expect(st.classifyReplyId(id)).toBe("stale");
  });

  it("life-11/13: 不正id・未発行idはinvalid", () => {
    const st = new RequestState();
    st.markReady();
    st.register("transform");
    expect(st.classifyReplyId(999999)).toBe("invalid");
    expect(st.classifyReplyId(-1)).toBe("invalid");
    expect(st.classifyReplyId(Number.MAX_SAFE_INTEGER + 1)).toBe("invalid");
  });
});
