import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_VERSION } from "../../packages/backends/browser/worker-protocol";

type MockSelf = {
  location: { origin: string };
  postMessage: (msg: unknown) => void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  messages: unknown[];
};

function setupSelf(origin = "https://example.test"): MockSelf {
  const mock: MockSelf = {
    location: { origin },
    postMessage: vi.fn((msg: unknown) => {
      mock.messages.push(msg);
    }),
    onmessage: null,
    onerror: null,
    messages: [],
  };
  (globalThis as unknown as { self: unknown }).self = mock as unknown as DedicatedWorkerGlobalScope;
  return mock;
}

function makeMockModule(overrides: Record<string, unknown> = {}) {
  const heap = new ArrayBuffer(1024 * 1024);
  const HEAP32 = new Int32Array(heap, 0, 256 * 1024);
  const HEAPU32 = new Uint32Array(heap, 0, 256 * 1024);
  let nextPtr = 8;
  const allocs = new Map<number, number>();
  return {
    _poc_core_abi_version: () => 1,
    _poc_core_version: () => 8,
    UTF8ToString: () => "0.1.0",
    HEAP32,
    HEAPU32,
    _malloc: (size: number) => {
      const ptr = nextPtr;
      nextPtr += (size + 7) & ~7;
      allocs.set(ptr, size);
      return ptr;
    },
    _free: () => {},
    _poc_transform_i32: (inPtr: number, count: number, mul: number, off: number, outPtr: number, _cap: number, sumPtr: number) => {
      // simple JS oracle (not C++): compute with clamp
      const h32 = HEAP32;
      const hu32 = HEAPU32;
      for (let i = 0; i < count; i++) {
        const v = h32[(inPtr >> 2) + i] ?? 0;
        const r = v * mul + off;
        const c = Math.max(-2147483648, Math.min(2147483647, r));
        h32[(outPtr >> 2) + i] = c | 0;
      }
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const v = h32[(outPtr >> 2) + i] | 0;
        sum = (sum + (v >>> 0)) >>> 0;
      }
      hu32[sumPtr >> 2] = sum >>> 0;
      return 0;
    },
    ...overrides,
  };
}

describe("worker pure helpers", () => {
  it("isSafePositiveInt", async () => {
    setupSelf();
    const mod = await import("../../packages/backends/browser/core.worker");
    expect(mod.isSafePositiveInt(1)).toBe(true);
    expect(mod.isSafePositiveInt(0)).toBe(false);
    expect(mod.isSafePositiveInt(-1)).toBe(false);
    expect(mod.isSafePositiveInt(1.5)).toBe(false);
    expect(mod.isSafePositiveInt("1")).toBe(false);
    expect(mod.isSafePositiveInt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(mod.isSafePositiveInt(NaN)).toBe(false);
  });

  it("checkUrls branches", async () => {
    const mock = setupSelf("https://example.test");
    // need self.location for checkUrls (it reads self.location.origin)
    (globalThis as unknown as { self: unknown }).self = mock as unknown as DedicatedWorkerGlobalScope;
    const mod = await import("../../packages/backends/browser/core.worker");
    const base = "https://example.test";
    expect(mod.checkUrls(`${base}/wasm/poc-core.mjs`, `${base}/wasm/poc-core.wasm`)).toBeNull();
    expect(mod.checkUrls(123, `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/wasm/poc-core.mjs`, 123)).not.toBeNull();
    expect(mod.checkUrls("not-a-url", `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls("https://other.test/wasm/poc-core.mjs", `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/wasm/poc-core.mjs?x=1`, `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/wasm/poc-core.mjs#h`, `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/other/poc-core.mjs`, `${base}/wasm/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/wasm/poc-core.mjs`, `${base}/other/poc-core.wasm`)).not.toBeNull();
    expect(mod.checkUrls(`${base}/a/wasm/poc-core.mjs`, `${base}/b/wasm/poc-core.wasm`)).not.toBeNull();
  });
});

describe("worker init/getInfo/transform via onmessage", () => {
  beforeEach(() => {
    setupSelf("https://example.test");
  });

  async function loadWorker() {
    const mod = await import("../../packages/backends/browser/core.worker");
    mod.__resetWorkerForTest();
    const selfMock = (globalThis as unknown as { self: MockSelf }).self;
    selfMock.messages = [];
    // Nodeでは初回import時にselfが未設定でhandler未登録のままになるため、付け直す。
    // 製品Workerでは既定で登録済みのため二重登録と同等で無害。
    mod.__attachForTest(selfMock);
    // reply先のpostMessageをmockへ向ける: workerは `self.postMessage` を呼ぶため、global selfのpostMessageを使う。
    // 既にsetupSelfで設定済みだが、import後にselfが上書きされていないか確認する。
    return { mod, selfMock };
  }

  function send(selfMock: MockSelf, data: unknown) {
    if (!selfMock.onmessage) throw new Error("onmessage not registered (self mock too late)");
    selfMock.onmessage({ data } as MessageEvent);
  }

  async function waitForReply(selfMock: MockSelf, count = 1, timeoutMs = 2000): Promise<unknown[]> {
    const start = Date.now();
    while (selfMock.messages.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${count} replies, got ${selfMock.messages.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return [...selfMock.messages];
  }

  it("init success + getInfo + transform basic", async () => {
    const { mod, selfMock } = await loadWorker();
    const mockModule = makeMockModule();
    mod.__setImporterForTest(async () => ({
      default: async (opts?: unknown) => {
        // locateFileの両分岐 (wasm解決・素通し) を covering する
        const locate = (opts as { locateFile?: (p: string) => string }).locateFile;
        if (locate) {
          expect(locate("poc-core.wasm")).toBe("https://example.test/wasm/poc-core.wasm");
          expect(locate("asset.js")).toBe("asset.js");
        }
        return mockModule;
      },
    }));
    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
    const replies = await waitForReply(selfMock, 1);
    expect((replies[0] as { ok: boolean }).ok).toBe(true);
    expect(mod.__getWorkerStateForTest()).toBe("ready");

    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "getInfo" });
    const replies2 = await waitForReply(selfMock, 2);
    expect((replies2[1] as { ok: boolean }).ok).toBe(true);

    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 3, method: "transform", payload: { values: [1, 2, 3], multiplier: 2, offset: 1 } });
    const replies3 = await waitForReply(selfMock, 3);
    const t = replies3[2] as { ok: boolean; data?: { values: number[]; checksum: number } };
    expect(t.ok).toBe(true);
    expect(t.data?.values).toEqual([3, 5, 7]);
    expect(t.data?.checksum).toBe(15);
  });

  it("duplicate init rejected", async () => {
    const { mod, selfMock } = await loadWorker();
    mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
    await waitForReply(selfMock, 1);
    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
    const replies = await waitForReply(selfMock, 2);
    expect((replies[1] as { ok: boolean }).ok).toBe(false);
  });

  it("init url error -> failed", async () => {
    const { mod, selfMock } = await loadWorker();
    mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://evil.test/x.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
    const replies = await waitForReply(selfMock, 1);
    expect((replies[0] as { ok: boolean }).ok).toBe(false);
    expect(mod.__getWorkerStateForTest()).toBe("failed");
  });

  it("init missing factory / invalid exports / ABI mismatch / throw", async () => {
    // missing factory
    {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => ({}));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      const r = await waitForReply(selfMock, 1);
      expect((r[0] as { ok: boolean }).ok).toBe(false);
    }
    // invalid exports
    {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => ({ default: async () => ({}) }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      const r = await waitForReply(selfMock, 1);
      expect((r[0] as { ok: boolean }).ok).toBe(false);
    }
    // ABI mismatch
    {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => ({ default: async () => makeMockModule({ _poc_core_abi_version: () => 999 }) }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      const r = await waitForReply(selfMock, 1);
      const first = r[0] as { ok: boolean; error?: { code: string } };
      expect(first.ok).toBe(false);
      expect(first.error?.code).toBe("ABI_MISMATCH");
    }
    // importer throws (Error/非Error両方)
    for (const boom of [new Error("import boom"), "import-string-boom"]) {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => {
        throw boom;
      });
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      const r = await waitForReply(selfMock, 1);
      expect((r[0] as { ok: boolean }).ok).toBe(false);
    }
  });

  it("getInfo not ready, ABI mismatch after ready, exception", async () => {
    // not ready
    {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "getInfo" });
      const r = await waitForReply(selfMock, 1);
      expect((r[0] as { ok: boolean }).ok).toBe(false);
    }
    // ABI mismatch on getInfo
    {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule();
      let calls = 0;
      const mutable = {
        ...m,
        _poc_core_abi_version: () => {
          calls++;
          return calls === 1 ? 1 : 999;
        },
      };
      mod.__setImporterForTest(async () => ({ default: async () => mutable }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "getInfo" });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // getInfo throws (Error/非Error両方でCORE_FAILURE整形を通す)
    for (const boom of [new Error("getInfo boom"), "getInfo-string-boom"]) {
      const { mod, selfMock } = await loadWorker();
      const good = makeMockModule();
      mod.__setImporterForTest(async () => ({ default: async () => good }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      // stored modを壊して次のabi呼び出しで投げさせる
      (good as { _poc_core_abi_version: () => number })._poc_core_abi_version = () => {
        throw boom;
      };
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "getInfo" });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
  });

  it("transform not ready + invalid payload", async () => {
    const { mod, selfMock } = await loadWorker();
    mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
    send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
    const r = await waitForReply(selfMock, 1);
    expect((r[0] as { ok: boolean }).ok).toBe(false);

    // ready then invalid
    const { mod: mod2, selfMock: s2 } = await loadWorker();
    mod2.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
    send(s2, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
    await waitForReply(s2, 1);
    send(s2, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1.5], multiplier: 1, offset: 0 } });
    const r2 = await waitForReply(s2, 2);
    expect((r2[1] as { ok: boolean }).ok).toBe(false);
    send(s2, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 3, method: "transform", payload: { values: new Array(4097).fill(1), multiplier: 1, offset: 0 } });
    const r3 = await waitForReply(s2, 3);
    expect((r3[2] as { ok: boolean }).ok).toBe(false);
  });

  it("transform OOM paths", async () => {
    // input alloc fail
    {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule({ _malloc: () => 0 });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1, 2], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // output alloc fail (first malloc ok, second 0)
    {
      const { mod, selfMock } = await loadWorker();
      let n = 0;
      const m = makeMockModule({
        _malloc: () => {
          n++;
          return n === 1 ? 16 : 0;
        },
      });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1, 2], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // checksum alloc fail
    {
      const { mod, selfMock } = await loadWorker();
      let n = 0;
      const m = makeMockModule({
        _malloc: () => {
          n++;
          if (n <= 2) return n * 16;
          return 0;
        },
      });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // empty count success (no in/out alloc)
    {
      const { mod, selfMock } = await loadWorker();
      mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(true);
    }
  });

  it("transform trap + non-zero status + free throws", async () => {
    // trap (Error/非Error両方)
    for (const boom of [new Error("trap boom"), "trap-string-boom"]) {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule({
        _poc_transform_i32: () => {
          throw boom;
        },
      });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // non-zero
    {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule({ _poc_transform_i32: () => 5 });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      expect((r[1] as { ok: boolean }).ok).toBe(false);
    }
    // free throws (finally catch)
    {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule({
        _free: () => {
          throw new Error("free boom");
        },
      });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      // reply already sent before free throws, so still ok true, but state becomes failed
      expect((r[1] as { ok: boolean }).ok).toBe(true);
      expect(mod.__getWorkerStateForTest()).toBe("failed");
    }
    // output viewの再取得に失敗すると外側catchでCORE_FAILUREになる
    {
      const { mod, selfMock } = await loadWorker();
      const m = makeMockModule();
      let heapReads = 0;
      Object.defineProperty(m, "HEAP32", {
        get() {
          heapReads++;
          if (heapReads === 2) throw new Error("view boom");
          return (makeMockModule() as unknown as { HEAP32: Int32Array }).HEAP32;
        },
      });
      mod.__setImporterForTest(async () => ({ default: async () => m }));
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: "https://example.test/wasm/poc-core.mjs", wasmUrl: "https://example.test/wasm/poc-core.wasm" });
      await waitForReply(selfMock, 1);
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 2, method: "transform", payload: { values: [1], multiplier: 1, offset: 0 } });
      const r = await waitForReply(selfMock, 2);
      const second = r[1] as { ok: boolean; error?: { code: string } };
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe("CORE_FAILURE");
    }
  });

  it("onmessage invalid protocol/id/method throws + invalid init URLs + onerror", async () => {
    const { mod, selfMock } = await loadWorker();
    mod.__setImporterForTest(async () => ({ default: async () => makeMockModule() }));
    // invalid protocol
    expect(() =>
      send(selfMock, { protocolVersion: 999, id: 1, method: "getInfo" }),
    ).toThrow();
    expect(mod.__getWorkerStateForTest()).toBe("failed");

    // reset then invalid init URLs
    mod.__resetWorkerForTest();
    selfMock.messages = [];
    expect(() =>
      send(selfMock, { protocolVersion: WORKER_PROTOCOL_VERSION, id: 1, method: "init", moduleUrl: 123, wasmUrl: "x" }),
    ).toThrow();
    expect(mod.__getWorkerStateForTest()).toBe("failed");

    // onerror
    mod.__resetWorkerForTest();
    selfMock.onerror?.({});
    expect(mod.__getWorkerStateForTest()).toBe("failed");
  });
});
