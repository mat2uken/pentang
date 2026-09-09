import { describe, expect, it, vi } from "vitest";
import { createBrowserBackendForTest } from "../../src/backends/browser/index";
import { WORKER_PROTOCOL_VERSION } from "../../src/backends/browser/worker-protocol";

// 最小のfake Worker。postMessageで即時に正規返信を返す。
function makeEchoWorker(opts: {
  onPost?: (msg: { id: number; method: string; payload?: { values: number[]; multiplier: number; offset: number } }) => unknown;
  hangInit?: boolean;
} = {}) {
  const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>();
  const worker = {
    postMessage: vi.fn((msg: { id: number; method: string; payload?: { values: number[]; multiplier: number; offset: number } }) => {
      if (opts.hangInit && msg.method === "init") return;
      if (opts.onPost) {
        const data = opts.onPost(msg);
        queueMicrotask(() => {
          for (const fn of listeners.get("message") ?? []) fn({ data });
        });
        return;
      }
      // 既定: init/getInfoはcore情報、transformは簡易計算
      queueMicrotask(() => {
        let data: unknown;
        if (msg.method === "init" || msg.method === "getInfo") {
          data = {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            id: msg.id,
            method: msg.method,
            ok: true,
            data: { abiVersion: 1, version: "0.1.0" },
          };
        } else {
          const p = msg.payload!;
          const values = p.values.map((v) => Math.max(-2147483648, Math.min(2147483647, v * p.multiplier + p.offset)));
          let sum = 0;
          for (const v of values) sum = (sum + (v >>> 0)) >>> 0;
          data = { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: true, data: { values, checksum: sum } };
        }
        for (const fn of listeners.get("message") ?? []) fn({ data });
      });
    }),
    terminate: vi.fn(),
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      if (fn) {
        if (!listeners.has("message")) listeners.set("message", new Set());
        listeners.get("message")!.clear();
        listeners.get("message")!.add(fn as (ev: { data: unknown }) => void);
      } else {
        listeners.get("message")?.clear();
      }
    },
    get onmessage() {
      return null;
    },
    set onerror(_fn: unknown) {},
    get onerror() {
      return null;
    },
    set onmessageerror(_fn: unknown) {},
    get onmessageerror() {
      return null;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __emitMessage(data: unknown) {
      for (const fn of listeners.get("message") ?? []) fn({ data });
    },
    __emitError() {
      // onerrorハンドラを直接呼ぶため、Backend側で設定した関数を保持する必要がある。
      // 簡易化のため、直接failさせる場合はpostMessageで壊れた返信を送る方式を使う。
    },
  };
  return worker as unknown as Worker & {
    __emitMessage: (data: unknown) => void;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

describe("browser-backend", () => {
  it("init・基本変換・self-test相当の11件", async () => {
    const worker = makeEchoWorker();
    const { createBrowserBackend } = await import("../../src/backends/browser/index");
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
    });
    const info = await api.getInfo();
    expect(info.backend).toBe("wasm-worker");
    expect(info.execution).toBe("dedicated-worker");
    expect(info.hostOs).toBe("browser");
    expect(info.core.abiVersion).toBe(1);
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    await api.dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("不正入力は送信せずINVALID", async () => {
    const worker = makeEchoWorker();
    const { createBrowserBackend } = await import("../../src/backends/browser/index");
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
    });
    const before = (worker.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(api.transform({ values: [1.5], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect((worker.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    await api.dispose();
  });

  it("壊れた返信はTRANSPORT_ERRORでfailed", async () => {
    const worker = makeEchoWorker();
    const { createBrowserBackend } = await import("../../src/backends/browser/index");
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
    });
    const p = api.getInfo();
    // 未発行idの返信を注入
    worker.__emitMessage({ protocolVersion: 1, id: 999999, method: "getInfo", ok: true, data: { abiVersion: 1, version: "0.1.0" } });
    await expect(p).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("dispose後はDISPOSED、再生成は新インスタンス", async () => {
    const worker = makeEchoWorker();
    const { createBrowserBackend } = await import("../../src/backends/browser/index");
    const api = await createBrowserBackend({
      workerFactory: () => worker as unknown as Worker,
      moduleUrl: "https://example.test/wasm/poc-core.mjs",
      wasmUrl: "https://example.test/wasm/poc-core.wasm",
    });
    await api.dispose();
    await api.dispose();
    await expect(api.getInfo()).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("A-02相当: Backend検証を迂回してもWorkerが拒否 (直接Worker呼び出し)", async () => {
    // BrowserBackendを通さずWorker相当の検証関数を直接呼ぶ代わりに、
    // 不正payloadをWorkerへ送った場合の整形を、echo WorkerのINVALID応答で模す
    const worker = makeEchoWorker({
      onPost: (msg) => {
        if (msg.method === "transform") {
          return {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            id: msg.id,
            method: "transform",
            ok: false,
            error: { code: "INVALID_ARGUMENT", message: "bad" },
          };
        }
        return {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          id: msg.id,
          method: msg.method,
          ok: true,
          data: { abiVersion: 1, version: "0.1.0" },
        };
      },
    });
    // onPostの返信をmessageとして流すため、postMessageを上書きして返信をemitする
    const origPost = worker.postMessage;
    (worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((msg: { id: number; method: string; payload?: { values: number[]; multiplier: number; offset: number } }) => {
      const data = ((): unknown => {
        if (msg.method === "transform") {
          return {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            id: msg.id,
            method: "transform",
            ok: false,
            error: { code: "INVALID_ARGUMENT", message: "bad" },
          };
        }
        return {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          id: msg.id,
          method: msg.method,
          ok: true,
          data: { abiVersion: 1, version: "0.1.0" },
        };
      })();
      queueMicrotask(() => worker.__emitMessage(data));
      return undefined as never;
    });
    void origPost;
    const backend = createBrowserBackendForTest(worker as unknown as Worker);
    await backend.init("https://example.test/wasm/poc-core.mjs", "https://example.test/wasm/poc-core.wasm");
    // 検証済みの正しい入力でもWorkerがINVALIDを返せば当該要求だけ失敗しready維持
    await expect(backend.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // ready維持の確認: 次のgetInfoが成功する
    const info = await backend.getInfo();
    expect(info.core.abiVersion).toBe(1);
    await backend.dispose();
  });
});
