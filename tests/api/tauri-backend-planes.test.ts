import { describe, expect, it, vi } from "vitest";
import {
  createBackend,
  createTauriBackendForTest,
  createTauriBackendWithDeps,
} from "../../packages/backends/tauri/index";
import {
  decodeTransformRequest,
  encodeTransformResponse,
  valuesToArray,
} from "../../packages/api/wire";

function okInfo() {
  return {
    apiVersion: 1,
    backend: "tauri-native",
    hostOs: "macos",
    execution: "native-ffi",
    core: { abiVersion: 1, version: "0.1.0" },
  };
}

function fakeFetchOk(handler: (body: Uint8Array) => Uint8Array) {
  return vi.fn(
    async (
      _url: string,
      init?: { body?: Uint8Array },
    ): Promise<{
      readonly status: number;
      readonly ok: boolean;
      arrayBuffer(): Promise<ArrayBuffer>;
      text(): Promise<string>;
    }> => {
      if ((_url as string).endsWith("/health")) {
        return { status: 204, ok: true, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
      }
      const out = handler(init?.body ?? new Uint8Array(0));
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => buf as ArrayBuffer,
        text: async () => new TextDecoder().decode(out),
      };
    },
  );
}

function echoFetch() {
  // 要求frameを計算して応答frameで返すfakeサーバ。
  return fakeFetchOk((body) => {
    const d = decodeTransformRequest(body);
    if (!d.ok) throw new Error("bad frame");
    const vals = valuesToArray(d.valuesBytes, d.count).map((v) => {
      const r = v * d.multiplier + d.offset;
      return Math.max(-2147483648, Math.min(2147483647, r));
    });
    let sum = 0;
    for (const v of vals) sum = (sum + (v >>> 0)) >>> 0;
    const out = new Uint8Array(16 + 8 + vals.length * 4);
    const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: sum });
    return out.slice(0, n);
  });
}

describe("tauri-backend data planes", () => {
  it("scheme planeで変換成功・fetch先がcorebin", async () => {
    const fetchFn = echoFetch();
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn });
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    const transformCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).endsWith("/transform"),
    ) as [string, unknown];
    expect(transformCall[0]).toBe("corebin://localhost/transform");
    // getInfoは制御プレーン (JSON invoke) のまま
    await api.getInfo();
    expect(invoke).toHaveBeenCalledWith("core_get_info");
    await api.dispose();
  });

  it("auto: scheme不達のAndroid相当ではjsonへfallback", async () => {
    const seen: string[] = [];
    // corebin: 自体が到達不能 (Android WebView相当)。POST probeのみ行う。
    const androidLike = vi.fn(
      async (
        url: string,
        _init?: { method?: string; body?: Uint8Array },
      ): Promise<{
        readonly status: number;
        readonly ok: boolean;
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
      }> => {
        seen.push(url);
        throw new Error("Failed to fetch");
      },
    );
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "core_get_info") return okInfo();
      if (cmd === "core_transform") {
        const req = (args as { request: { values: number[]; multiplier: number; offset: number } }).request;
        const values = req.values.map((v) => v * req.multiplier + req.offset);
        let sum = 0;
        for (const v of values) sum = (sum + (v >>> 0)) >>> 0;
        return { values, checksum: sum };
      }
      throw new Error(`unknown ${cmd}`);
    });
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "auto", fetchFn: androidLike });
    expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("json");
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    // probeはcorebin:// POSTのみで、迂回URLへは行かない。
    expect(seen).toEqual(["corebin://localhost/transform"]);
    await api.dispose();
  });

  it("scheme明示: 不達なら初期化失敗", async () => {
    const androidLike = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const invoke = vi.fn(async () => okInfo());
    const backend = createTauriBackendForTest({ invoke, dataPlane: "scheme", fetchFn: androidLike });
    await expect(backend.init()).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
  });

  it("auto: 到達可ならscheme、不可ならjsonへfallback", async () => {
    const invoke = vi.fn(async () => okInfo());
    const api1 = await createTauriBackendWithDeps({ invoke, dataPlane: "auto", fetchFn: echoFetch() });
    expect((api1 as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("scheme");
    await api1.dispose();

    const invoke2 = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "core_get_info") return okInfo();
      if (cmd === "core_transform") {
        const req = (args as { request: { values: number[] } }).request;
        return { values: req.values, checksum: 0 };
      }
      throw new Error("unexpected");
    });
    const downFetch = vi.fn(async () => {
      throw new Error("down");
    });
    const api2 = await createTauriBackendWithDeps({ invoke: invoke2, dataPlane: "auto", fetchFn: downFetch });
    expect((api2 as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("json");
    const r = await api2.transform({ values: [9], multiplier: 1, offset: 0 });
    expect([...r.values]).toEqual([9]);
    await api2.dispose();
  });

  it("schemeのLIMIT_EXCEEDEDは単発失敗でready維持", async () => {
    // probe frame (values=[0]) には正常応答し、values=[1] の要求にだけ
    // LIMITを返す現実的なサーバ振る舞い。
    const fetchFn = vi.fn(async (_url: string, init?: { body?: Uint8Array }) => {
      const ok = (body: Uint8Array) => ({
        status: 200 as number,
        ok: true as boolean,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        text: async () => new TextDecoder().decode(body),
      });
      const err = {
        status: 413 as number,
        ok: false as boolean,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify({ code: "LIMIT_EXCEEDED", message: "too long" }),
      };
      const body = init?.body ?? new Uint8Array(0);
      const d = decodeTransformRequest(body);
      if (!d.ok) return err;
      if (d.valuesBytes[0] === 1) return err;
      const vals = valuesToArray(d.valuesBytes, d.count);
      const out = new Uint8Array(16 + 8 + vals.length * 4);
      const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: 0 });
      return ok(out.slice(0, n));
    });
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(
      (api as unknown as { debugState(): { lifecycle: string } }).debugState().lifecycle,
    ).toBe("ready");
    await api.dispose();
  });

  it("schemeの壊れた応答はTRANSPORT_ERRORでfailed", async () => {
    // probe (sequence 0) には正常応答し、本番要求には壊れたバイトを返す。
    const fetchFn = vi.fn(async (_url: string, init?: { body?: Uint8Array }) => {
      const ok = (body: Uint8Array) => ({
        status: 200 as number,
        ok: true as boolean,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        text: async () => new TextDecoder().decode(body),
      });
      const body = init?.body ?? new Uint8Array(0);
      const d = decodeTransformRequest(body);
      if (d.ok && d.sequence === 0) {
        const vals = valuesToArray(d.valuesBytes, d.count);
        const out = new Uint8Array(16 + 8 + vals.length * 4);
        const n = encodeTransformResponse(out, 0, { sequence: 0, values: vals, checksum: 0 });
        return ok(out.slice(0, n));
      }
      return ok(new Uint8Array([1, 2, 3]));
    });
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("既定はjson (既存動作不変)", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "core_get_info") return okInfo();
      throw new Error("must not be called");
    });
    const backend = createTauriBackendForTest({ invoke });
    await backend.init();
    expect(backend.resolvedDataPlane).toBe("json");
    await backend.dispose();
  });

  it("応答frameのdecode失敗はTRANSPORT_ERRORでfailed", async () => {
    // headerは正しいがpayloadのcountが食い違う応答を返す。
    const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: Uint8Array }) => {
      if (url.endsWith("/health")) {
        return { status: 204, ok: true, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
      }
      const out = new Uint8Array(16 + 8);
      // command=transform, payloadLen=8, count=99 (不一致)。
      out.set([0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      out.set([99, 0, 0, 0, 0, 0, 0, 0], 16);
      void init;
      const buf = out.buffer.slice(0);
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => buf as ArrayBuffer,
        text: async () => "",
      };
    });
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });

  it("createBackendはauto既定で初期化失敗を伝える", async () => {
    // 実invokeなし・fetchなしのNode環境ではget_info自体が失敗する。
    await expect(createBackend()).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
  });

  it("port planeで変換成功・応答検証が通る", async () => {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => {
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(0);
        const d = decodeTransformRequest(bytes);
        if (!d.ok) throw new Error("bad frame");
        const vals = valuesToArray(d.valuesBytes, d.count).map((v) => v * d.multiplier + d.offset);
        let sum = 0;
        for (const v of vals) sum = (sum + (v >>> 0)) >>> 0;
        const out = new Uint8Array(16 + 8 + vals.length * 4);
        const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: sum });
        const resp = out.slice(0, n);
        queueMicrotask(() => handler?.({ data: resp.buffer as ArrayBuffer }));
      },
      addEventListener: (_t: string, l: (ev: { data: unknown }) => void) => {
        handler = l;
      },
    };
    const g = globalThis as Record<string, unknown>;
    const invoke = vi.fn(async () => okInfo());
    try {
      g["corebin"] = port;
      const api = await createTauriBackendWithDeps({ invoke, dataPlane: "port" });
      expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("port");
      const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
      expect([...r.values]).toEqual([3, 5, 7]);
      expect(r.checksum).toBe(15);
      // 生Port経路ではinvoke変換を使わない。
      expect(invoke).toHaveBeenCalledTimes(1);
      await api.dispose();
    } finally {
      delete g["corebin"];
    }
  });

  it("port明示でhook欠落なら初期化失敗", async () => {
    const invoke = vi.fn(async () => okInfo());
    const backend = createTauriBackendForTest({ invoke, dataPlane: "port" });
    await expect(backend.init()).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
  });

  it("autoは生Portを最優先する (fetch不要)", async () => {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => {
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(0);
        const d = decodeTransformRequest(bytes);
        if (!d.ok) throw new Error("bad frame");
        const out = new Uint8Array(16 + 8);
        const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: [], checksum: 0 });
        const resp = out.slice(0, n);
        queueMicrotask(() => handler?.({ data: resp.buffer as ArrayBuffer }));
      },
      addEventListener: (_t: string, l: (ev: { data: unknown }) => void) => {
        handler = l;
      },
    };
    const g = globalThis as Record<string, unknown>;
    const invoke = vi.fn(async () => okInfo());
    const downFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    try {
      g["corebin"] = port;
      const api = await createTauriBackendWithDeps({ invoke, dataPlane: "auto", fetchFn: downFetch });
      expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("port");
      const r = await api.transform({ values: [], multiplier: 1, offset: 0 });
      expect([...r.values]).toEqual([]);
      expect(r.checksum).toBe(0);
      // fetch側は一切触らない。
      expect(downFetch).not.toHaveBeenCalled();
      await api.dispose();
    } finally {
      delete g["corebin"];
    }
  });
});
