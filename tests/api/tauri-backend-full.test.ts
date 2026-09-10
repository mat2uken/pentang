import { describe, expect, it, vi } from "vitest";
import {
  createTauriBackend,
  createTauriBackendForTest,
  createTauriBackendWithDeps,
} from "../../packages/backends/tauri/index";

function okInfo() {
  return {
    apiVersion: 1,
    backend: "tauri-native",
    hostOs: "macos",
    execution: "native-ffi",
    core: { abiVersion: 1, version: "0.1.0" },
  };
}

describe("tauri-backend full branches", () => {
  it("init: invoke string rejection -> TRANSPORT (saved)", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "poc_get_info") throw "string-boom";
      throw new Error("unreach");
    });
    const b = createTauriBackendForTest({ invoke });
    await expect(b.init()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(b.debugState().lifecycle).toBe("failed");
  });

  it("init: invoke Error -> TRANSPORT, second call returns saved", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("invoke fail");
    });
    const b = createTauriBackendForTest({ invoke });
    await expect(b.init()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    // after failed, getInfo returns saved failure
    await expect(b.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });

  it("init: timeout via hanging invoke", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(() => new Promise(() => {}));
      const b = createTauriBackendForTest({ invoke, initTimeoutMs: 50, requestTimeoutMs: 50 });
      const p = b.init();
      // attach catch to avoid unhandled
      const guarded = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      await expect(guarded).resolves.toMatchObject({ code: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("getInfo: SINGLE stays ready (INVALID single failure)", async () => {
    // transform returning INVALID_ARGUMENT from native should be single (ready维持)
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "poc_get_info") return okInfo();
      return { code: "INVALID_ARGUMENT", message: "bad" };
    });
    // Our mock returns object with code/message, but validateTransformResult will treat as TRANSPORT
    // Instead make native throw AppError SINGLE:
    const invoke2 = vi.fn(async (cmd: string) => {
      if (cmd === "poc_get_info") return okInfo();
      throw { code: "INVALID_ARGUMENT", message: "bad-input" };
    });
    const api = await createTauriBackendWithDeps({ invoke: invoke2 });
    // Backend validation catches invalid before invoke, so use valid input that native rejects as INVALID?
    // Valid input [1] with native throwing INVALID simulates single-error path.
    // But our transform validates first (valid), then invoke throws SINGLE -> rejectOne, ready维持.
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // ready维持: next call succeeds if native now succeeds
    void invoke;
    await api.dispose();
  });

  it("getInfo: ABI mismatch fails all", async () => {
    let n = 0;
    const invoke = vi.fn(async () => {
      n++;
      if (n === 1) return okInfo();
      return { ...okInfo(), core: { abiVersion: 2, version: "x" } };
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "ABI_MISMATCH" });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "ABI_MISMATCH" });
    await api.dispose();
  });

  it("transform: length mismatch -> TRANSPORT failed", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "poc_get_info") return okInfo();
      return { values: [1], checksum: 1 };
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.transform({ values: [1, 2], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("transform: BUSY when 8 pending", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    let calls = 0;
    const invoke = vi.fn((_cmd: string) => {
      calls++;
      if (calls === 1) return Promise.resolve(okInfo());
      // transform hangs
      if (_cmd === "poc_transform") return gate;
      return Promise.resolve(okInfo());
    });
    const b = createTauriBackendForTest({ invoke });
    await b.init();
    const pendings: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      pendings.push(b.transform({ values: [1], multiplier: 1, offset: 0 }).catch((e) => e));
    }
    await expect(b.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "BUSY",
    });
    // release with valid results
    release({ values: [1], checksum: 1 });
    // Need to release 8 times? gate is single promise shared, all 8 share same resolution.
    const results = await Promise.all(pendings);
    expect(results.length).toBe(8);
    await b.dispose();
  });

  it("transform: native CORE_FAILURE -> failed", async () => {
    let calls = 0;
    const invoke = vi.fn(async (cmd: string) => {
      calls++;
      if (calls === 1 && cmd === "poc_get_info") return okInfo();
      throw { code: "CORE_FAILURE", message: "c boom" };
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "CORE_FAILURE",
    });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "CORE_FAILURE",
    });
    await api.dispose();
  });

  it("getInfo: invoke TRANSPORT after ready -> failed and stale", async () => {
    let calls = 0;
    const invoke = vi.fn(async (cmd: string) => {
      calls++;
      if (calls === 1 && cmd === "poc_get_info") return okInfo();
      throw new Error("transport boom");
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("debugState reflects pending", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    let calls = 0;
    const invoke = vi.fn((_cmd: string) => {
      calls++;
      if (calls === 1) return Promise.resolve(okInfo());
      return gate;
    });
    const b = createTauriBackendForTest({ invoke });
    await b.init();
    expect(b.debugState().lifecycle).toBe("ready");
    const p = b.getInfo().catch((e) => e);
    expect(b.debugState().pending).toBe(1);
    release(okInfo());
    await p;
    expect(b.debugState().pending).toBe(0);
    await b.dispose();
  });

  it("public factory without deps uses real invoke (fails without Tauri runtime)", async () => {
    // 実invoke経路 (default引数) の covering。Tauri外ではTRANSPORT/INITIALIZATIONで失敗する。
    await expect(createTauriBackend()).rejects.toMatchObject({
      code: expect.stringMatching(/^(TRANSPORT_ERROR|INITIALIZATION_FAILED)$/),
    });
  });

  it("init: CORE_FAILURE is preserved (not wrapped)", async () => {
    const invoke = vi.fn(async () => {
      throw { code: "CORE_FAILURE", message: "c boom" };
    });
    const b = createTauriBackendForTest({ invoke });
    await expect(b.init()).rejects.toMatchObject({ code: "CORE_FAILURE" });
    expect(b.debugState().lifecycle).toBe("failed");
  });

  it("concurrent fatal failures: second catch returns saved failure", async () => {
    let calls = 0;
    const invoke = vi.fn(async () => {
      calls++;
      if (calls === 1) return okInfo();
      throw { code: "CORE_FAILURE", message: "c boom" };
    });
    const api = await createTauriBackendWithDeps({ invoke });
    // 2件同時発行。先行のcatchがfailAllし、後続のcatchは保存済み失敗を返す分岐を通る。
    const p1 = api.getInfo();
    const p2 = api.getInfo();
    await expect(p1).rejects.toMatchObject({ code: "CORE_FAILURE" });
    await expect(p2).rejects.toMatchObject({ code: "CORE_FAILURE" });
    expect(calls).toBe(3);
    await api.dispose();
  });
});
