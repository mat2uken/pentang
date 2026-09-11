import { describe, expect, it, vi } from "vitest";
import {
  createBackend,
  createTauriBackendForTest,
  createTauriBackendWithDeps,
} from "../../packages/backends/tauri/index";
import { base64Decode, base64Encode } from "../../packages/api/base64";
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

// 試験double: wire要求を素直に計算するfakeサーバ (製品計算の置換ではない)。
async function fakeB64Invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === "poc_get_info") return okInfo();
  if (cmd === "poc_transform_bin") {
    const dec = base64Decode(args!["data"] as string);
    if (!dec.ok) throw new Error("bad b64");
    const d = decodeTransformRequest(dec.bytes);
    if (!d.ok) throw new Error("bad frame");
    const vals = valuesToArray(d.valuesBytes, d.count).map((v) => {
      const r = v * d.multiplier + d.offset;
      return Math.max(-2147483648, Math.min(2147483647, r));
    });
    let sum = 0;
    for (const v of vals) sum = (sum + (v >>> 0)) >>> 0;
    const out = new Uint8Array(16 + 8 + vals.length * 4);
    const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: sum });
    return base64Encode(out.slice(0, n));
  }
  throw new Error(`unknown ${cmd}`);
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
  it("b64 planeで変換成功・応答検証が通る", async () => {
    const invoke = vi.fn(fakeB64Invoke);
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "b64" });
    expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("b64");
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    expect(invoke).toHaveBeenCalledWith("poc_transform_bin", expect.anything());
    await api.dispose();
  });

  it("scheme planeで変換成功・fetch先がpocbin", async () => {
    const fetchFn = echoFetch();
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn });
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    const transformCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).endsWith("/transform"),
    ) as [string, unknown];
    expect(transformCall[0]).toBe("pocbin://localhost/transform");
    // getInfoは制御プレーン (JSON invoke) のまま
    await api.getInfo();
    expect(invoke).toHaveBeenCalledWith("poc_get_info");
    await api.dispose();
  });

  it("auto: GET迂回のみの環境では単発最速のb64を選ぶ (Android相当)", async () => {
    const seen: string[] = [];
    // Rust schemeハンドラ相当: POST body / GETクエリの両方を受け付ける。
    // Android相当として pocbin: URL自体は到達不能にする。
    const androidLike = vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: Uint8Array },
      ): Promise<{
        readonly status: number;
        readonly ok: boolean;
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
      }> => {
        seen.push(url);
        if (url.startsWith("pocbin:")) throw new Error("Failed to fetch");
        const fail = (status: number, code: string, message: string) => ({
          status,
          ok: false as boolean,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => JSON.stringify({ code, message }),
        });
        let reqBytes: Uint8Array | null = null;
        if ((init?.method ?? "GET") === "GET") {
          const q = url.split("?", 2)[1] ?? "";
          const pair = q.split("&").find((p) => p.startsWith("data="));
          if (pair === undefined) return fail(400, "INVALID_ARGUMENT", "missing data");
          const std = pair.slice(5).replace(/-/g, "+").replace(/_/g, "/");
          const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
          const dec = base64Decode(padded);
          if (!dec.ok) return fail(400, "INVALID_ARGUMENT", "bad base64url");
          reqBytes = dec.bytes;
        } else {
          reqBytes = init?.body ?? new Uint8Array(0);
        }
        const d = decodeTransformRequest(reqBytes);
        if (!d.ok) return fail(400, "INVALID_ARGUMENT", "bad frame");
        const vals = valuesToArray(d.valuesBytes, d.count).map((v) => v * d.multiplier + d.offset);
        let sum = 0;
        for (const v of vals) sum = (sum + (v >>> 0)) >>> 0;
        const out = new Uint8Array(16 + 8 + vals.length * 4);
        const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: sum });
        const body = out.slice(0, n);
        const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        return {
          status: 200,
          ok: true,
          arrayBuffer: async () => buf as ArrayBuffer,
          text: async () => new TextDecoder().decode(body),
        };
      },
    );
    const invoke = vi.fn(fakeB64Invoke);
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "auto", fetchFn: androidLike });
    expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("b64");
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    expect(invoke).toHaveBeenCalledWith("poc_transform_bin", expect.anything());
    await api.dispose();
  });

  it("scheme明示: GET迂回URLにpin留めして変換する", async () => {
    const seen: string[] = [];
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
        if (url.startsWith("pocbin:")) throw new Error("Failed to fetch");
        const q = url.split("?", 2)[1] ?? "";
        const pair = q.split("&").find((p) => p.startsWith("data="));
        if (pair === undefined) {
          return { status: 400, ok: false, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "{}" };
        }
        const std = pair.slice(5).replace(/-/g, "+").replace(/_/g, "/");
        const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
        const dec = base64Decode(padded);
        if (!dec.ok) throw new Error("bad base64url");
        const d = decodeTransformRequest(dec.bytes);
        if (!d.ok) throw new Error("bad frame");
        const vals = valuesToArray(d.valuesBytes, d.count).map((v) => v * d.multiplier + d.offset);
        let sum = 0;
        for (const v of vals) sum = (sum + (v >>> 0)) >>> 0;
        const out = new Uint8Array(16 + 8 + vals.length * 4);
        const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: vals, checksum: sum });
        const body = out.slice(0, n);
        const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        return {
          status: 200,
          ok: true,
          arrayBuffer: async () => buf as ArrayBuffer,
          text: async () => new TextDecoder().decode(body),
        };
      },
    );
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke, dataPlane: "scheme", fetchFn: androidLike });
    expect((api as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("scheme");
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    // transform送信自体もGETクエリ運搬になっていること。
    const sends = seen.filter((u) => u.startsWith("http://pocbin.localhost/transform?data="));
    expect(sends.length).toBeGreaterThan(0);
    await api.dispose();
  });

  it("auto: 到達可ならscheme、不可ならjsonへfallback", async () => {
    const invoke = vi.fn(async () => okInfo());
    const api1 = await createTauriBackendWithDeps({ invoke, dataPlane: "auto", fetchFn: echoFetch() });
    expect((api1 as unknown as { resolvedDataPlane: string }).resolvedDataPlane).toBe("scheme");
    await api1.dispose();

    const invoke2 = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "poc_get_info") return okInfo();
      if (cmd === "poc_transform") {
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
      if (cmd === "poc_get_info") return okInfo();
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
});
