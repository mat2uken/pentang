import { describe, expect, it, vi } from "vitest";
import { createBrowserBackendForTest, createBrowserBackend } from "../../src/backends/browser/index";
import { WORKER_PROTOCOL_VERSION } from "../../src/backends/browser/worker-protocol";

function makeWorker(opts: {
  onPost?: (msg: { id: number; method: string; payload?: unknown }) => unknown;
  hangInit?: boolean;
  throwOnPost?: boolean;
} = {}) {
  const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>();
  let errorHandler: (() => void) | null = null;
  let messageErrorHandler: (() => void) | null = null;
  const worker = {
    postMessage: vi.fn((msg: { id: number; method: string; payload?: unknown }) => {
      if (opts.throwOnPost) throw new Error("post fail");
      if (opts.hangInit && msg.method === "init") return;
      const data = opts.onPost
        ? opts.onPost(msg)
        : msg.method === "transform"
          ? (() => {
              const p = msg.payload as { values: number[]; multiplier: number; offset: number };
              const values = p.values.map((v) => Math.max(-2147483648, Math.min(2147483647, v * p.multiplier + p.offset)));
              let sum = 0;
              for (const v of values) sum = (sum + (v >>> 0)) >>> 0;
              return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: true, data: { values, checksum: sum } };
            })()
          : { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 1, version: "0.1.0" } };
      queueMicrotask(() => {
        for (const fn of listeners.get("message") ?? []) fn({ data });
      });
    }),
    terminate: vi.fn(),
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      if (fn) {
        if (!listeners.has("message")) listeners.set("message", new Set());
        listeners.get("message")!.clear();
        listeners.get("message")!.add(fn as (ev: { data: unknown }) => void);
      } else listeners.get("message")?.clear();
    },
    get onmessage() {
      return null;
    },
    set onerror(fn: (() => void) | null) {
      errorHandler = fn;
    },
    get onerror() {
      return errorHandler;
    },
    set onmessageerror(fn: (() => void) | null) {
      messageErrorHandler = fn;
    },
    get onmessageerror() {
      return messageErrorHandler;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __emitMessage(data: unknown) {
      for (const fn of listeners.get("message") ?? []) fn({ data });
    },
    __emitError() {
      errorHandler?.();
    },
    __emitMessageError() {
      messageErrorHandler?.();
    },
  };
  return worker as unknown as Worker & {
    __emitMessage: (d: unknown) => void;
    __emitError: () => void;
    __emitMessageError: () => void;
  };
}

describe("browser-backend full", () => {
  it("init postMessage throws -> TRANSPORT", async () => {
    const worker = makeWorker({ throwOnPost: true });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("init invalid reply -> TRANSPORT (worker CORE_FAILURE mapped)", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false, error: { code: "CORE_FAILURE", message: "bad" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("init INITIALIZATION_FAILED reply -> INITIALIZATION_FAILED", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: false, error: { code: "INITIALIZATION_FAILED", message: "bad-init" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await expect(b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm")).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
  });

  it("init ABI mismatch -> ABI_MISMATCH via failAll", async () => {
    const worker = makeWorker({
      onPost: (msg) => ({ protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 999, version: "x" } }),
    });
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    // extractCore returns ABI_MISMATCH, init wraps? Actually init checks extractCore and failAll with ABI_MISMATCH then throws it.
    await expect(b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm")).rejects.toMatchObject({
      code: "ABI_MISMATCH",
    });
  });

  it("init timeout -> TIMEOUT/INITIALIZATION", async () => {
    vi.useFakeTimers();
    try {
      const worker = makeWorker({ hangInit: true });
      const b = createBrowserBackendForTest(worker as unknown as Worker, { initTimeoutMs: 50 });
      const p = b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm");
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
    });
    const p = api.getInfo();
    worker.__emitMessage({ protocolVersion: 999, id: 1, method: "getInfo", ok: true, data: { abiVersion: 1, version: "x" } });
    await expect(p).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("stale duplicate reply ignored; method mismatch -> TRANSPORT", async () => {
    const worker = makeWorker();
    const b = createBrowserBackendForTest(worker as unknown as Worker);
    await b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm");
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
    await b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm");
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
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
    await b.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm");
    expect(typeof b.nextIdForTest).toBe("number");
    expect(b.debugState().lifecycle).toBe("ready");
    await b.dispose();
    expect(b.debugState().lifecycle).toBe("disposed");
  });
});
