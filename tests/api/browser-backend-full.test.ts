import { describe, expect, it, vi } from "vitest";
import { createBrowserBackendForTest, createBrowserBackend } from "../../packages/backends/browser/index";
import { WORKER_PROTOCOL_VERSION } from "../../packages/backends/browser/worker-protocol";
import { makeFakeWorker as makeWorker } from "./fake-worker";

describe("browser-backend full", () => {
  it("init postMessage throws -> TRANSPORT", async () => {
    const worker = makeWorker({ throwOnPost: true });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("init invalid reply -> TRANSPORT (worker CORE_FAILURE mapped)", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false, error: { code: "CORE_FAILURE", message: "bad" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("init INITIALIZATION_FAILED reply -> INITIALIZATION_FAILED", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false, error: { code: "INITIALIZATION_FAILED", message: "bad-init" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
  });

  it("init ABI mismatch -> ABI_MISMATCH via failAll", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 999, version: "x" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    // extractCore returns ABI_MISMATCH, init wraps? Actually init checks extractCore and failAll with ABI_MISMATCH then throws it.
    await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
      code: "ABI_MISMATCH",
    });
  });

  it("init timeout -> TIMEOUT/INITIALIZATION", async () => {
    vi.useFakeTimers();
    try {
      const worker = makeWorker({ hangInit: true });
      const b = createBrowserBackendForTest(worker as unknown as Worker, { initTimeoutMs: 50 });
      const p = b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm");
      const guarded = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await guarded;
      expect(["TIMEOUT", "INITIALIZATION_FAILED"]).toContain((err as { code: string }).code);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getInfo postMessage throws -> TRANSPORT failed", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("post fail");
    });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("transform postMessage throws -> TRANSPORT", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("post fail");
    });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("worker onerror -> WORKER_FAILED", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    const p = api.getInfo();
    worker.__emitError();
    await expect(p).rejects.toMatchObject({ code: "WORKER_FAILED" });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "WORKER_FAILED" });
    await api.dispose();
  });

  it("worker onmessageerror -> TRANSPORT", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    const p = api.getInfo();
    worker.__emitMessageError();
    await expect(p).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("broken reply (protocol mismatch) -> TRANSPORT", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    const p = api.getInfo();
    worker.__emitMessage({ protocolVersion: 999, id: 1, method: "getInfo", ok: true, data: { abiVersion: 1, version: "x" } });
    await expect(p).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("stale duplicate reply ignored; method mismatch -> TRANSPORT", async () => {
    const worker = makeWorker();
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm");
    // successful getInfo then duplicate stale
    const info = await b.getInfo();
    expect(info.core.abiVersion).toBe(1);
    // stale: emit old id again (id 2 was getInfo, now completed). Should be ignored, not fail.
    // We don't know exact ids, but emitting completed id should be stale-ignored.
    // Use currentNextId to craft stale: id 1 is init completed -> stale
    worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", ok: true, data: { abiVersion: 1, version: "0.1.0" } });
    // still ready
    const info2 = await b.getInfo();
    expect(info2.core.abiVersion).toBe(1);

    // method mismatch: start a transform, then reply with getInfo method for same id
    const tp = b.transform({ values: [1], multiplier: 1, offset: 0 });
    // need id: nextId-1 is the transform's id
    const pendingId = (b as unknown as { nextIdForTest: number }).nextIdForTest - 1;
    worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: pendingId, method: "getInfo", ok: true, data: { abiVersion: 1, version: "0.1.0" } });
    await expect(tp).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await b.dispose();
  });

  it("transform worker INVALID single stays ready; CORE_FAILURE fails", async () => {
    const worker = makeWorker({
      onPost: (msg) => {
        if (msg.method === "transform") {
          return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: false, error: { code: "OUT_OF_MEMORY", message: "oom" } };
        }
        return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 1, version: "0.1.0" } };
      },
    });
    // need custom post that uses onPost
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((msg: { id: number; method: string; payload?: unknown }) => {
      const data = ((): unknown => {
        if (msg.method === "transform") {
          return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: false, error: { code: "OUT_OF_MEMORY", message: "oom" } };
        }
        return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 1, version: "0.1.0" } };
      })();
      queueMicrotask(() => worker.__emitMessage(data));
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm");
    await expect(b.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({ code: "OUT_OF_MEMORY" });
    // ready stays
    const info = await b.getInfo();
    expect(info.core.abiVersion).toBe(1);
    await b.dispose();
  });

  it("transform result length mismatch -> TRANSPORT", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    // hijack next transform to return wrong length
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce((msg: { id: number; method: string }) => {
      const data = { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: true, data: { values: [1, 2, 3], checksum: 6 } };
      queueMicrotask(() => worker.__emitMessage(data));
    });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("transform invalid result shape -> TRANSPORT", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce((msg: { id: number; method: string }) => {
      const data = { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: true, data: { values: [1.5], checksum: 0 } };
      queueMicrotask(() => worker.__emitMessage(data));
    });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("nextIdForTest and debugState covered; dispose clears", async () => {
    const worker = makeWorker();
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm");
    expect(typeof b.nextIdForTest).toBe("number");
    expect(b.debugState().lifecycle).toBe("ready");
    await b.dispose();
    expect(b.debugState().lifecycle).toBe("disposed");
  });

  it("factory without urls falls back to buildUrls (throws without document)", async () => {
    const worker = makeWorker();
    // node環境にdocumentがないためbuildUrlsが投げる。URL必須の文書化になる。
    await expect(
      createBrowserBackend({ workerFactory: () => worker as unknown as Worker }),
    ).rejects.toThrow();
  });

  it("init: ok:false variants map codes", async () => {
    // error fieldなし -> TRANSPORT
    {
      const worker = makeWorker({
        onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false }),
      });
      (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((msg: { id: number; method: string }) => {
        queueMicrotask(() =>
          worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false }),
        );
      });
      const b = createBrowserBackendForTest(worker as unknown as Worker);
      await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
        code: "TRANSPORT_ERROR",
      });
    }
    // ABI_MISMATCH (messageあり/なし)
    for (const error of [
      { code: "ABI_MISMATCH", message: "unsupported ABI 2" },
      { code: "ABI_MISMATCH" },
    ]) {
      const worker = makeWorker();
      (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((msg: { id: number; method: string }) => {
        queueMicrotask(() =>
          worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false, error }),
        );
      });
      const b = createBrowserBackendForTest(worker as unknown as Worker);
      await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
        code: "ABI_MISMATCH",
      });
    }
    // ok:trueだがcore型不正 -> TRANSPORT
    {
      const worker = makeWorker();
      (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((msg: { id: number; method: string }) => {
        queueMicrotask(() =>
          worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: "1", version: 1 } }),
        );
      });
      const b = createBrowserBackendForTest(worker as unknown as Worker);
      await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
        code: "TRANSPORT_ERROR",
      });
    }
  });

  it("getInfo/transform: error fieldなしはTRANSPORT、getInfo致命はfailedへ", async () => {
    const worker = makeWorker();
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce((msg: { id: number; method: string }) => {
      queueMicrotask(() =>
        worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "getInfo", ok: false }),
      );
    });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();

    const worker2 = makeWorker();
    const api2 = await createBrowserBackend({
      workerFactory: () => worker2 as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker2.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce((msg: { id: number; method: string }) => {
      queueMicrotask(() =>
        worker2.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "getInfo", ok: false, error: { code: "CORE_FAILURE", message: "c boom" } }),
      );
    });
    await expect(api2.getInfo()).rejects.toMatchObject({ code: "CORE_FAILURE" });
    await expect(api2.getInfo()).rejects.toMatchObject({ code: "CORE_FAILURE" });
    await api2.dispose();

    const worker3 = makeWorker();
    const api3 = await createBrowserBackend({
      workerFactory: () => worker3 as unknown as Worker,
      moduleUrl: "https://example.test/wasm/core.mjs",
      wasmUrl: "https://example.test/wasm/core.wasm",
    });
    (worker3.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce((msg: { id: number; method: string }) => {
      queueMicrotask(() =>
        worker3.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: false }),
      );
    });
    await expect(api3.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api3.dispose();
  });

  it("post-dispose messages are ignored (failed/disposed guards)", async () => {
    const worker = makeWorker();
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm");
    await b.dispose();
    // 壊れた返信・未発行id返信はfailed/disposedガードで無視され、例外にならない
    worker.__emitMessage({ protocolVersion: 999, id: 1, method: "getInfo", ok: true });
    worker.__emitMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, id: 999999, method: "getInfo", ok: true, data: { abiVersion: 1, version: "0.1.0" } });
    // 未捕捉error系も終了後は無視される
    worker.__emitError();
    worker.__emitMessageError();
    await expect(b.getInfo()).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("init with BUSY state propagates BUSY (backend stays retryable)", async () => {
    const worker = makeWorker();
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    // 内部RequestStateを8件で埋め、initのregisterをBUSYで失敗させる。
    // initのregisterはtry外のためBUSYがそのまま伝播し、failed化しない (再試行可能)。
    const st = (b as unknown as { state: { register(m: string): { id: number; promise: Promise<unknown> } } }).state;
    for (let i = 0; i < 8; i++) st.register("transform").promise.catch(() => {});
    await expect(b.init("https://example.test/wasm/core.mjs", "https://example.test/wasm/core.wasm")).rejects.toMatchObject({
      code: "BUSY",
    });
    expect(b.debugState().lifecycle).toBe("creating");
    await b.dispose();
    expect(b.debugState().lifecycle).toBe("disposed");
  });
});
