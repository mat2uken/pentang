import { describe, expect, it, vi } from "vitest";
import {
  collectEnv,
  selectTransportKind,
  type TransportEnv,
} from "../../packages/backends/transport/bridge-interface";
import {
  BatchingBridge,
  PortTransport,
  SchemeBinaryTransport,
  TauriInvokeTransport,
  createBridgeTransport,
  createFastTauriTransport,
  createTauriDataTransport,
  probeSchemeBinary,
  probeSchemeUrl,
  type BinaryPort,
} from "../../packages/backends/transport/index";
import {
  TRANSPORT_CAPS,
  SerialQueue,
  TransportError,
  normalizeTransportFailure,
  toTransferableCopy,
} from "../../packages/backends/transport/bridge-interface";
import { WebView2SharedTransport, isWebView2SharedAvailable } from "../../packages/backends/transport/transport-win";
import { WebKitIpcTransport, isWebKitIpcAvailable } from "../../packages/backends/transport/transport-apple";
import { AndroidPortTransport, WebMessageTransport, getCorebinPort, isAndroidPortAvailable } from "../../packages/backends/transport/transport-android";
import { LinuxDirectTransport, isLinuxDirectAvailable } from "../../packages/backends/transport/transport-linux";
import {
  decodeGetInfoResponse,
  decodeTransformRequest,
  decodeTransformResponse,
  encodeGetInfoRequest,
  encodeTransformRequest,
  encodeTransformResponse,
  scanFrames,
  valuesToArray,
} from "../../packages/api/wire";

function baseEnv(over: Partial<TransportEnv> = {}): TransportEnv {
  return {
    hasTauri: false,
    hasWebView2Shared: false,
    hasWebKitHandler: false,
    hasAndroidPort: false,
    hasLinuxDirect: false,
    userAgent: "node-test",
    ...over,
  };
}

// 試験用 double。製品経路の計算置換ではない (transport 層の送受信検証専用)。
function refTransform(values: number[], multiplier: number, offset: number): { values: number[]; checksum: number } {
  const out = values.map((v) => {
    const r = v * multiplier + offset;
    if (r < -2147483648) return -2147483648;
    if (r > 2147483647) return 2147483647;
    return r;
  });
  let sum = 0;
  for (const v of out) sum = (sum + (v >>> 0)) >>> 0;
  return { values: out, checksum: sum };
}

function encReq(seq: number, values: number[], multiplier = 2, offset = 1): Uint8Array {
  const out = new Uint8Array(16 + 12 + values.length * 4);
  const n = encodeTransformRequest(out, 0, { sequence: seq, values, multiplier, offset });
  return out.slice(0, n);
}

// Rust schemeハンドラ相当のfake: POST bodyを処理する。
// androidLike: corebin: URL自体が到達不能 (Android WebView相当)。
function schemeEcho(opts: { androidLike?: boolean } = {}) {
  return vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: Uint8Array },
    ): Promise<{
      readonly status: number;
      readonly ok: boolean;
      arrayBuffer(): Promise<ArrayBuffer>;
      text(): Promise<string>;
    }> => {
      const respond = (body: Uint8Array, status = 200) => {
        const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        return {
          status,
          ok: status >= 200 && status < 300,
          arrayBuffer: async () => buf as ArrayBuffer,
          text: async () => new TextDecoder().decode(body),
        };
      };
      const fail = (status: number, code: string, message: string) =>
        respond(new TextEncoder().encode(JSON.stringify({ code, message })), status);
      if (opts.androidLike && url.startsWith("corebin:")) throw new Error("Failed to fetch");
      if (url.endsWith("/health")) {
        return respond(new Uint8Array(0), 204);
      }
      const reqBytes = init?.body ?? new Uint8Array(0);
      const d = decodeTransformRequest(reqBytes);
      if (!d.ok) return fail(400, "INVALID_ARGUMENT", "bad frame");
      const r = refTransform(valuesToArray(d.valuesBytes, d.count), d.multiplier, d.offset);
      const out = new Uint8Array(16 + 8 + r.values.length * 4);
      const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: r.values, checksum: r.checksum });
      return respond(out.slice(0, n));
    },
  );
}

describe("transport select (OS dispatch)", () => {
  it("collectEnv does not throw in Node and reports no hooks", () => {
    const env = collectEnv();
    expect(env.hasTauri).toBe(false);
    expect(env.hasWebView2Shared).toBe(false);
  });

  it("priority: shared > extension > webkit > android-port > tauri > worker", () => {
    expect(selectTransportKind(baseEnv())).toBe("worker-message");
    expect(selectTransportKind(baseEnv({ hasTauri: true }))).toBe("tauri-invoke");
    expect(selectTransportKind(baseEnv({ hasTauri: true, hasAndroidPort: true }))).toBe("android-port");
    expect(selectTransportKind(baseEnv({ hasTauri: true, hasWebKitHandler: true }))).toBe("webkit-ipc");
    expect(selectTransportKind(baseEnv({ hasTauri: true, hasLinuxDirect: true }))).toBe("webkit-extension");
    expect(
      selectTransportKind(
        baseEnv({ hasTauri: true, hasWebView2Shared: true, hasLinuxDirect: true }),
      ),
    ).toBe("webview2-shared");
  });

  it("OS transports use pipe first, fallback second, error without either", async () => {
    const pipeHit = vi.fn(async (b: Uint8Array) => b.slice());
    const fallback = { kind: "tauri-invoke" as const, caps: undefined as never, send: vi.fn(async (b: Uint8Array) => b.slice()) };
    const win = new WebView2SharedTransport({ pipe: pipeHit, fallback });
    expect(await win.send(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
    expect(pipeHit).toHaveBeenCalledTimes(1);
    expect(fallback.send).not.toHaveBeenCalled();

    const apple = new WebKitIpcTransport({ fallback });
    await apple.send(new Uint8Array([2]));
    expect(fallback.send).toHaveBeenCalledTimes(1);

    const bare = new AndroidPortTransport();
    await expect(bare.send(new Uint8Array([1]))).rejects.toThrow();
    const linux = new LinuxDirectTransport({ fallback });
    await expect(linux.send(new Uint8Array([3]))).resolves.toEqual(new Uint8Array([3]));
  });

  it("OS transports cover all branches and probes", async () => {
    expect(isWebView2SharedAvailable(baseEnv({ hasWebView2Shared: true }))).toBe(true);
    expect(isWebView2SharedAvailable(baseEnv())).toBe(false);
    expect(isWebKitIpcAvailable(baseEnv({ hasWebKitHandler: true }))).toBe(true);
    expect(isWebKitIpcAvailable(baseEnv())).toBe(false);
    expect(isAndroidPortAvailable(baseEnv({ hasAndroidPort: true }))).toBe(true);
    expect(isAndroidPortAvailable(baseEnv())).toBe(false);
    expect(isLinuxDirectAvailable(baseEnv({ hasLinuxDirect: true }))).toBe(true);
    expect(isLinuxDirectAvailable(baseEnv())).toBe(false);

    const pipe = vi.fn(async (b: Uint8Array) => b.slice());
    const fallback = { kind: "tauri-invoke" as const, caps: undefined as never, send: vi.fn(async (b: Uint8Array) => b.slice()) };
    // pipe優先 (apple/android/linux)。
    for (const t of [
      new WebKitIpcTransport({ pipe, fallback }),
      new AndroidPortTransport({ pipe, fallback }),
      new LinuxDirectTransport({ pipe, fallback }),
    ]) {
      pipe.mockClear();
      fallback.send.mockClear();
      await expect(t.send(new Uint8Array([9]))).resolves.toEqual(new Uint8Array([9]));
      expect(pipe).toHaveBeenCalledTimes(1);
      expect(fallback.send).not.toHaveBeenCalled();
    }
    // fallback委譲 (android)。
    {
      pipe.mockClear();
      fallback.send.mockClear();
      const t = new AndroidPortTransport({ fallback });
      await expect(t.send(new Uint8Array([1]))).resolves.toEqual(new Uint8Array([1]));
      expect(fallback.send).toHaveBeenCalledTimes(1);
    }
    // 経路なしはthrow (win/apple/linux)。
    for (const t of [
      new WebView2SharedTransport(),
      new WebKitIpcTransport(),
      new LinuxDirectTransport(),
    ]) {
      await expect(t.send(new Uint8Array([1]))).rejects.toThrow();
    }
  });
});

describe("bridge-interface helpers", () => {
  it("toTransferableCopy detaches ownership", () => {
    const src = new Uint8Array([1, 2, 3]);
    const copy = toTransferableCopy(src);
    expect(copy).not.toBe(src);
    expect([...copy]).toEqual([1, 2, 3]);
    expect(TRANSPORT_CAPS["scheme-binary"].zeroCopy).toBe(false);
  });

  it("normalizeTransportFailure preserves codes and coerces unknowns", () => {
    const keep = new TransportError("LIMIT_EXCEEDED", "too long");
    expect(normalizeTransportFailure(keep)).toBe(keep);
    const t = normalizeTransportFailure(new Error("boom"));
    expect(t.code).toBe("TRANSPORT_ERROR");
    const s = normalizeTransportFailure("plain-string-failure");
    expect(s.code).toBe("TRANSPORT_ERROR");
    expect(s.message).toContain("plain-string");
    const u = normalizeTransportFailure(42);
    expect(u.code).toBe("TRANSPORT_ERROR");
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    const c = normalizeTransportFailure(circ);
    expect(c.code).toBe("TRANSPORT_ERROR");
  });
});

describe("TauriInvokeTransport (binary facade over JSON invoke)", () => {
  it("transform frame -> invoke args -> response frame", async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      expect(cmd).toBe("core_transform");
      const req = args!["request"] as { values: number[]; multiplier: number; offset: number };
      return refTransform(req.values, req.multiplier, req.offset);
    });
    const t = new TauriInvokeTransport({ invoke });
    const resp = await t.send(encReq(11, [1, 2, 3]));
    const d = decodeTransformResponse(resp);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sequence).toBe(11);
      expect(valuesToArray(d.valuesBytes, d.count)).toEqual([3, 5, 7]);
      expect(d.checksum).toBe(15);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("getInfo frame -> core_get_info -> response frame", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      expect(cmd).toBe("core_get_info");
      return { core: { abiVersion: 1, version: "0.1.0" } };
    });
    const t = new TauriInvokeTransport({ invoke });
    const q = new Uint8Array(16);
    encodeGetInfoRequest(q, 0, 5);
    const resp = await t.send(q);
    const d = decodeGetInfoResponse(resp);
    expect(d).toEqual({ ok: true, sequence: 5, abiVersion: 1, version: "0.1.0" });
  });

  it("batch of two frames -> two invokes -> concatenated responses", async () => {
    const seen: string[] = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      seen.push(cmd);
      const req = args!["request"] as { values: number[]; multiplier: number; offset: number };
      return refTransform(req.values, req.multiplier, req.offset);
    });
    const t = new TauriInvokeTransport({ invoke });
    const batch = new Uint8Array(128);
    const n1 = encodeTransformRequest(batch, 0, { sequence: 1, values: [1], multiplier: 1, offset: 0 });
    const n2 = encodeTransformRequest(batch, n1, { sequence: 2, values: [2], multiplier: 1, offset: 0 });
    // ネイティブ呼び出し2回で応答batchを組み立てる。
    const resp = await t.send(batch.slice(0, n1 + n2));
    expect(seen).toEqual(["core_transform", "core_transform"]);
    expect(resp.length).toBe((16 + 8 + 4) * 2);
  });

  it("rejects malformed batches and replies", async () => {
    const invoke = vi.fn(async () => ({}));
    const t = new TauriInvokeTransport({ invoke });
    await expect(t.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid request batch/);
    expect(invoke).not.toHaveBeenCalled();
    await expect(t.send(encReq(1, [1]))).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects broken getInfo/transform replies", async () => {
    const badInfo = new TauriInvokeTransport({ invoke: vi.fn(async () => ({ core: { abiVersion: "x" } })) });
    const q = new Uint8Array(16);
    encodeGetInfoRequest(q, 0, 5);
    await expect(badInfo.send(q)).rejects.toThrow(/invalid getInfo reply/);
    const badVals = new TauriInvokeTransport({ invoke: vi.fn(async () => ({ checksum: 0 })) });
    await expect(badVals.send(encReq(1, [1]))).rejects.toThrow(/invalid transform reply/);
    // ERRORフラグ付き要求frameはdecodeで拒否される。
    const errFlag = new TauriInvokeTransport({ invoke: vi.fn(async () => ({})) });
    const bad = encReq(1, [1]).slice();
    bad[4]! |= 0x01;
    await expect(errFlag.send(bad)).rejects.toThrow(/invalid transform frame/);
  });
});

describe("WebMessageTransport (raw port)", () => {
  function loopbackRawPort() {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    return {
      postMessage(message: unknown) {
        // 実portと同様、ArrayBuffer本体のみ受け付ける。batch可。
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(0);
        const scanned = scanFrames(bytes);
        if (!scanned.ok) throw new Error("bad batch");
        const parts: Uint8Array[] = [];
        let total = 0;
        for (const f of scanned.frames) {
          const d = decodeTransformRequest(bytes.subarray(f.offset, f.offset + f.frameLen));
          if (!d.ok) throw new Error("bad frame");
          const r = refTransform(valuesToArray(d.valuesBytes, d.count), d.multiplier, d.offset);
          const out = new Uint8Array(16 + 8 + r.values.length * 4);
          const n = encodeTransformResponse(out, 0, { sequence: d.sequence, values: r.values, checksum: r.checksum });
          parts.push(out.slice(0, n));
          total += n;
        }
        const resp = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          resp.set(p, o);
          o += p.length;
        }
        queueMicrotask(() => handler?.({ data: resp.buffer as ArrayBuffer }));
      },
      addEventListener(_type: string, listener: (ev: { data: unknown }) => void) {
        handler = listener;
      },
    };
  }

  it("round-trips binary frames through a raw peer", async () => {
    const t = new WebMessageTransport({ port: loopbackRawPort() });
    expect(t.kind).toBe("android-port");
    const resp = await t.send(encReq(9, [1, 2, 3]));
    const d = decodeTransformResponse(resp);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sequence).toBe(9);
      expect(valuesToArray(d.valuesBytes, d.count)).toEqual([3, 5, 7]);
      expect(d.checksum).toBe(15);
    }
  });

  it("rejects invalid submits without sending", async () => {
    const posted: unknown[] = [];
    const port = {
      postMessage: (m: unknown) => void posted.push(m),
      addEventListener: (_t: string, _l: (ev: { data: unknown }) => void) => {},
    };
    const t = new WebMessageTransport({ port });
    await expect(t.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid request batch/);
    await expect(t.send(encReq(1, [1]).slice(0, 20))).rejects.toThrow(/invalid request batch/);
    await expect(t.send(new Uint8Array(0))).rejects.toThrow(/invalid request batch/);
    expect(posted).toHaveLength(0);
  });

  it("round-trips a multi-frame batch", async () => {
    const t = new WebMessageTransport({ port: loopbackRawPort() });
    const a = encReq(11, [1]);
    const b = encReq(12, [2, 3]);
    const batch = new Uint8Array(a.length + b.length);
    batch.set(a, 0);
    batch.set(b, a.length);
    const resp = await t.send(batch);
    const scanned = scanFrames(resp);
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.frames.length).toBe(2);
      expect(scanned.frames[0]!.header.sequence).toBe(11);
      expect(scanned.frames[1]!.header.sequence).toBe(12);
    }
  });

  it("rejects non-ArrayBuffer responses and order mismatches", async () => {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    const port = {
      postMessage: (_m: unknown) => {},
      addEventListener: (_t: string, l: (ev: { data: unknown }) => void) => {
        handler = l;
      },
    };
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const t = new WebMessageTransport({ port });
    const p1 = t.send(encReq(1, [1]));
    await tick();
    handler!({ data: "not-a-buffer" });
    await expect(p1).rejects.toThrow(/must be ArrayBuffer/);
    const p2 = t.send(encReq(2, [2]));
    await tick();
    // sequence不一致 (応答なし相当の別seq)。
    handler!({ data: new Uint8Array(encReq(999, [9])).buffer as ArrayBuffer });
    await expect(p2).rejects.toThrow(/order mismatch/);
  });

  it("cleans up when postMessage throws", async () => {
    const port = {
      postMessage: () => {
        throw new Error("port dead");
      },
      addEventListener: (_t: string, _l: (ev: { data: unknown }) => void) => {},
    };
    const t = new WebMessageTransport({ port });
    await expect(t.send(encReq(1, [1]))).rejects.toThrow("port dead");
    await expect(t.send(encReq(2, [2]))).rejects.toThrow("port dead");
  });

  it("getCorebinPort detects the native hook safely", () => {
    expect(getCorebinPort()).toBe(null);
    const g = globalThis as Record<string, unknown>;
    try {
      g["corebin"] = { postMessage: () => {}, addEventListener: () => {} };
      expect(getCorebinPort()).not.toBe(null);
      g["corebin"] = { postMessage: "nope" };
      expect(getCorebinPort()).toBe(null);
      g["corebin"] = 42;
      expect(getCorebinPort()).toBe(null);
    } finally {
      delete g["corebin"];
    }
    expect(getCorebinPort()).toBe(null);
    expect(collectEnv().hasAndroidPort).toBe(false);
  });

  it("dispatcher prefers the raw port on Android", async () => {
    const g = globalThis as Record<string, unknown>;
    const port = loopbackRawPort();
    try {
      g["corebin"] = port;
      expect(collectEnv().hasAndroidPort).toBe(true);
      const t = createBridgeTransport({ env: baseEnv({ hasAndroidPort: true }) });
      expect(t.kind).toBe("android-port");
      const resp = await t.send(encReq(5, [4]));
      const d = decodeTransformResponse(resp);
      expect(d.ok).toBe(true);
      if (d.ok) expect(valuesToArray(d.valuesBytes, d.count)).toEqual([9]);
    } finally {
      delete g["corebin"];
    }
  });
});

describe("PortTransport (transferable peer)", () => {
  function loopbackPeer(compute: (req: Uint8Array) => Uint8Array): BinaryPort {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    return {
      postMessage(message: unknown) {
        const env = message as { id: number; buffer: ArrayBuffer };
        const req = new Uint8Array(env.buffer);
        const resp = compute(req);
        // 非同期応答 (所有権移転の体裁)。
        queueMicrotask(() => {
          handler?.({ data: { coreBinary: 1, id: env.id, buffer: resp.buffer as ArrayBuffer } });
        });
      },
      addEventListener(_type: "message", listener: (ev: { data: unknown }) => void) {
        handler = listener;
      },
    };
  }

  it("request/response round trip through a binary peer", async () => {
    const { decodeTransformRequest: decReq, encodeTransformResponse: encResp } =
      await import("../../packages/api/wire");
    const port = loopbackPeer((req) => {
      const d = decReq(req);
      if (!d.ok) throw new Error("bad req");
      const r = refTransform(valuesToArray(d.valuesBytes, d.count), d.multiplier, d.offset);
      const out = new Uint8Array(16 + 8 + r.values.length * 4);
      const n = encResp(out, 0, { sequence: d.sequence, values: r.values, checksum: r.checksum });
      return out.slice(0, n);
    });
    const t = new PortTransport({ port });
    const resp = await t.send(encReq(7, [1, 2, 3]));
    const d = decodeTransformResponse(resp);
    expect(d.ok).toBe(true);
    if (d.ok) expect(valuesToArray(d.valuesBytes, d.count)).toEqual([3, 5, 7]);
  });

  it("rejects invalid envelopes and order mismatches", async () => {
    let handler: ((ev: { data: unknown }) => void) | null = null;
    const port: BinaryPort = {
      postMessage: () => {},
      addEventListener: (_type: "message", listener: (ev: { data: unknown }) => void) => {
        handler = listener;
      },
    };
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const t = new PortTransport({ port });
    // 不正envelopeは待機中のpendingを拒否する。
    const p1 = t.send(encReq(1, [1]));
    await tick();
    handler!({ data: { garbage: true } });
    await expect(p1).rejects.toThrow(/invalid envelope/);
    // 順序不一致も待機中のpendingを拒否する (id=2が先頭のため9999は不一致)。
    const p2 = t.send(encReq(2, [2]));
    await tick();
    handler!({ data: { coreBinary: 1, id: 9999, buffer: new ArrayBuffer(8) } });
    await expect(p2).rejects.toThrow(/order mismatch/);
    // 正常応答は解決する。
    const p3 = t.send(encReq(3, [3]));
    await tick();
    handler!({ data: { coreBinary: 1, id: 3, buffer: new ArrayBuffer(8) } });
    const resp = await p3;
    expect(resp).toBeInstanceOf(Uint8Array);
  });

  it("cleans up when postMessage throws", async () => {
    const port: BinaryPort = {
      postMessage: () => {
        throw new Error("port dead");
      },
      addEventListener: () => {},
    };
    const t = new PortTransport({ port });
    await expect(t.send(encReq(1, [1]))).rejects.toThrow("port dead");
    // 片付け後も次は送れる。
    await expect(t.send(encReq(2, [2]))).rejects.toThrow("port dead");
  });
});

describe("BatchingBridge (submit coalescing)", () => {
  it("coalesces submits below threshold into a single send; matches by seq", async () => {
    const sent: Uint8Array[] = [];
    const transport = {
      kind: "tauri-invoke" as const,
      caps: undefined as never,
      send: vi.fn(async (batch: Uint8Array) => {
        sent.push(batch.slice());
        // 応答を逆順で返しても sequence 対応で正しく解決される。
        const { scanFrames: scan, decodeTransformRequest: dec, encodeTransformResponse: enc } =
          await import("../../packages/api/wire");
        const s = scan(batch);
        if (!s.ok) throw new Error("bad batch");
        const parts: Uint8Array[] = [];
        for (let i = s.frames.length - 1; i >= 0; i--) {
          const f = s.frames[i]!;
          const dd = dec(batch.subarray(f.offset, f.offset + f.frameLen));
          if (!dd.ok) throw new Error("bad frame");
          const r = refTransform(valuesToArray(dd.valuesBytes, dd.count), dd.multiplier, dd.offset);
          const ob = new Uint8Array(16 + 8 + r.values.length * 4);
          const n = enc(ob, 0, { sequence: dd.sequence, values: r.values, checksum: r.checksum });
          parts.push(ob.slice(0, n));
        }
        const total = parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        return out;
      }),
    };
    const bridge = new BatchingBridge(transport, { maxBytes: 1 << 20, maxFrames: 100 });
    const p1 = bridge.submit(encReq(21, [1]));
    const p2 = bridge.submit(encReq(22, [2]));
    const p3 = bridge.submit(encReq(23, [3]));
    expect(bridge.pendingCount).toBe(3);
    await bridge.flushNow();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const d1 = decodeTransformResponse(r1);
    const d2 = decodeTransformResponse(r2);
    const d3 = decodeTransformResponse(r3);
    expect(d1.ok && d1.sequence).toBe(21);
    expect(d2.ok && d2.sequence).toBe(22);
    expect(d3.ok && d3.sequence).toBe(23);
    if (d1.ok) expect(valuesToArray(d1.valuesBytes, d1.count)).toEqual([3]);
  });

  it("auto-flushes when maxFrames is reached", async () => {
    const { scanFrames: scan, decodeTransformRequest: dec, encodeTransformResponse: enc } =
      await import("../../packages/api/wire");
    const transport = {
      kind: "tauri-invoke" as const,
      caps: undefined as never,
      send: vi.fn(async (batch: Uint8Array) => {
        const s = scan(batch);
        if (!s.ok) throw new Error("bad batch");
        const parts: Uint8Array[] = [];
        for (const f of s.frames) {
          const dd = dec(batch.subarray(f.offset, f.offset + f.frameLen));
          if (!dd.ok) throw new Error("bad frame");
          const r = refTransform(valuesToArray(dd.valuesBytes, dd.count), dd.multiplier, dd.offset);
          const ob = new Uint8Array(16 + 8 + r.values.length * 4);
          const n = enc(ob, 0, { sequence: dd.sequence, values: r.values, checksum: r.checksum });
          parts.push(ob.slice(0, n));
        }
        const total = parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        return out;
      }),
    };
    const bridge = new BatchingBridge(transport, { maxFrames: 2 });
    const p1 = bridge.submit(encReq(1, [1]));
    const p2 = bridge.submit(encReq(2, [2]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const d1 = decodeTransformResponse(r1);
    const d2 = decodeTransformResponse(r2);
    expect(d1.ok).toBe(true);
    expect(d2.ok).toBe(true);
    if (d1.ok) expect(valuesToArray(d1.valuesBytes, d1.count)).toEqual([3]);
    if (d2.ok) expect(valuesToArray(d2.valuesBytes, d2.count)).toEqual([5]);
    bridge.close();
  });

  it("rejects invalid submits and closed bridges", async () => {
    const transport = {
      kind: "tauri-invoke" as const,
      caps: undefined as never,
      send: vi.fn(async (batch: Uint8Array) => batch.slice()),
    };
    const bridge = new BatchingBridge(transport);
    await expect(bridge.submit(new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid frame/);
    // 完全なheaderだがpayload不足のframeは拒否する。
    const truncated = encReq(1, [1, 2]).slice(0, 20);
    await expect(bridge.submit(truncated)).rejects.toThrow();
    expect(transport.send).not.toHaveBeenCalled();
    // flushNow on empty does nothing.
    await bridge.flushNow();
    expect(transport.send).not.toHaveBeenCalled();
    bridge.close();
    await expect(bridge.submit(encReq(1, [1]))).rejects.toThrow(/bridge closed/);
    // 二重closeは無害。
    bridge.close();
  });

  it("propagates transport failures and response mismatches", async () => {
    const failing = {
      kind: "tauri-invoke" as const,
      caps: undefined as never,
      send: vi.fn(async (_batch: Uint8Array) => {
        throw new Error("downstream down");
      }),
    };
    const b1 = new BatchingBridge(failing, { maxFrames: 2 });
    const p1 = b1.submit(encReq(1, [1]));
    const p2 = b1.submit(encReq(2, [2]));
    await expect(p1).rejects.toThrow("downstream down");
    await expect(p2).rejects.toThrow("downstream down");
    b1.close();

    // 応答batch不正・seq欠落。
    const badShapes = [
      new Uint8Array([9, 9, 9]),
      encReq(999, [1]),
    ];
    for (const bad of badShapes) {
      const t = {
        kind: "tauri-invoke" as const,
        caps: undefined as never,
        send: vi.fn(async (_batch: Uint8Array) => bad.slice()),
      };
      const b = new BatchingBridge(t, { maxFrames: 1 });
      await expect(b.submit(encReq(41, [1]))).rejects.toThrow();
      b.close();
    }
  });

  it("flushes on interval timer", async () => {
    vi.useFakeTimers();
    try {
      const transport = {
        kind: "tauri-invoke" as const,
        caps: undefined as never,
        send: vi.fn(async (batch: Uint8Array) => batch.slice()),
      };
      const bridge = new BatchingBridge(transport, { maxFrames: 100, flushIntervalMs: 50 });
      const p = bridge.submit(encReq(1, [1]));
      expect(transport.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60);
      await p;
      expect(transport.send).toHaveBeenCalledTimes(1);
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createBridgeTransport", () => {
  it("selects tauri-invoke inside Tauri, worker-message needs a port", () => {
    const invoke = vi.fn(async () => ({}));
    const t = createBridgeTransport({ env: baseEnv({ hasTauri: true }), invoke });
    expect(t.kind).toBe("tauri-invoke");
    expect(() => createBridgeTransport({ env: baseEnv() })).toThrow();
  });

  it("selects webview2-shared when the hook and pipe exist", () => {
    const pipe = vi.fn(async (b: Uint8Array) => b.slice());
    const t = createBridgeTransport({
      env: baseEnv({ hasTauri: true, hasWebView2Shared: true }),
      sharedPipe: pipe,
    });
    expect(t.kind).toBe("webview2-shared");
  });

  it("tauriDataPlane selects scheme/json explicitly", () => {
    const invoke = vi.fn(async () => "");
    expect(createTauriDataTransport({ invoke, tauriDataPlane: "scheme" }).kind).toBe(
      "scheme-binary",
    );
    expect(createTauriDataTransport({ invoke }).kind).toBe("tauri-invoke");
    // dispatcher経由でも反映される。
    expect(
      createBridgeTransport({
        env: baseEnv({ hasTauri: true }),
        invoke,
        tauriDataPlane: "scheme",
      }).kind,
    ).toBe("scheme-binary");
  });

  it("dispatches each OS transport by env hooks", () => {
    const pipe = vi.fn(async (b: Uint8Array) => b.slice());
    expect(
      createBridgeTransport({ env: baseEnv({ hasLinuxDirect: true }), linuxPipe: pipe }).kind,
    ).toBe("webkit-extension");
    expect(
      createBridgeTransport({ env: baseEnv({ hasWebKitHandler: true }), webkitPipe: pipe }).kind,
    ).toBe("webkit-ipc");
    expect(
      createBridgeTransport({ env: baseEnv({ hasAndroidPort: true }), androidPipe: pipe }).kind,
    ).toBe("android-port");
    const port = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
    };
    expect(createBridgeTransport({ env: baseEnv(), port }).kind).toBe("worker-message");
    expect(() => createBridgeTransport({ env: baseEnv(), port: undefined })).toThrow();
  });
});


describe("SchemeBinaryTransport", () => {
  function fakeFetch(handler: (body: Uint8Array) => { status: number; body: Uint8Array }) {
    return vi.fn(
      async (_url: string, init?: { body?: Uint8Array }): Promise<{
        readonly status: number;
        readonly ok: boolean;
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
      }> => {
        const r = handler(init?.body ?? new Uint8Array(0));
        const buf = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          arrayBuffer: async () => buf as ArrayBuffer,
          text: async () => new TextDecoder().decode(r.body),
        };
      },
    );
  }

  it("posts raw bytes and returns raw bytes", async () => {
    const fetchFn = fakeFetch((body) => ({ status: 200, body: body.slice() }));
    const t = new SchemeBinaryTransport({ fetchFn });
    expect(t.kind).toBe("scheme-binary");
    const req = encReq(8, [1, 2]);
    const resp = await t.send(req);
    expect([...resp]).toEqual([...req]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { body?: Uint8Array }];
    expect(url).toBe("corebin://localhost/transform");
    // 正確なviewは複写なしで渡す (所有権はflight中呼び出し側が保持)。
    expect(init.body).toBe(req);
    // 部分viewは範囲外保持を避けて複写する。
    const big = new Uint8Array(64);
    big.set(req, 8);
    const sub = big.subarray(8, 8 + req.length);
    await t.send(sub);
    const [, init2] = fetchFn.mock.calls[1] as [string, { body?: Uint8Array }];
    expect(init2.body).not.toBe(sub);
    expect([...init2.body!]).toEqual([...req]);
  });

  it("maps JSON error bodies to coded errors", async () => {
    const fetchFn = fakeFetch(
      () =>
        ({
          status: 413,
          body: new TextEncoder().encode(JSON.stringify({ code: "LIMIT_EXCEEDED", message: "too long" })),
        }) as { status: number; body: Uint8Array },
    );
    const t = new SchemeBinaryTransport({ fetchFn });
    const err = await t.send(encReq(1, [1])).catch((e) => e);
    expect(err.code).toBe("LIMIT_EXCEEDED");
    expect(String(err.message)).toContain("too long");
  });

  it("probeSchemeBinary reflects health check", async () => {
    expect(await probeSchemeBinary(fakeFetch(() => ({ status: 204, body: new Uint8Array(0) })))).toBe(true);
    expect(await probeSchemeBinary(fakeFetch(() => ({ status: 404, body: new Uint8Array(0) })))).toBe(false);
    expect(await probeSchemeBinary(async () => {
      throw new Error("down");
    })).toBe(false);
    expect(await probeSchemeBinary(undefined)).toBe(false);
  });

  it("probeSchemeUrl validates POST round trip", async () => {
    expect(await probeSchemeUrl(schemeEcho())).toBe("corebin://localhost/transform");
    // POST body不達 (空batch 400)・custom scheme不達・fetch失敗はすべてnull。
    const emptyPost = vi.fn(async () => ({
      status: 400,
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => JSON.stringify({ code: "INVALID_ARGUMENT", message: "empty" }),
    }));
    expect(await probeSchemeUrl(emptyPost)).toBe(null);
    expect(await probeSchemeUrl(schemeEcho({ androidLike: true }))).toBe(null);
    expect(await probeSchemeUrl(async () => {
      throw new Error("down");
    })).toBe(null);
    expect(await probeSchemeUrl(undefined)).toBe(null);
  });

  it("fetch rejection surfaces as TRANSPORT_ERROR", async () => {
    const t = new SchemeBinaryTransport({
      fetchFn: async () => {
        throw new Error("boom");
      },
    });
    await expect(t.send(encReq(1, [1]))).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });
});

describe("createFastTauriTransport (measured preference with fallback)", () => {
  const okFetch = schemeEcho();
  const downFetch = async () => {
    throw new Error("down");
  };

  it("prefers scheme when reachable", async () => {
    const t = await createFastTauriTransport({ fetchFn: okFetch });
    expect(t.kind).toBe("scheme-binary");
  });

  it("falls back to json", async () => {
    const invoke = vi.fn(async () => "");
    const t = await createFastTauriTransport({ fetchFn: downFetch, invoke });
    expect(t.kind).toBe("tauri-invoke");
    const json = await createFastTauriTransport({
      fetchFn: downFetch,
      invoke,
      tauriDataPlane: "json",
    });
    expect(json.kind).toBe("tauri-invoke");
  });

  it("explicit tauriDataPlane wins over probing", async () => {
    const invoke = vi.fn(async () => "");
    const t = await createFastTauriTransport({ fetchFn: okFetch, invoke, tauriDataPlane: "scheme" });
    expect(t.kind).toBe("scheme-binary");
  });

  it("scheme-unreachable Android falls back to json", async () => {
    const invoke = vi.fn(async () => "");
    const t = await createFastTauriTransport({ fetchFn: schemeEcho({ androidLike: true }), invoke });
    expect(t.kind).toBe("tauri-invoke");
  });
});

describe("SerialQueue", () => {
  it("runs tasks in enqueue order", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const gates = [0, 1, 2].map(() => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return { gate, release };
    });
    const runs = [0, 1, 2].map((i) =>
      q.enqueue(async () => {
        order.push(i);
        await gates[i]!.gate;
        return i;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0]);
    gates[0]!.release();
    expect(await runs[0]).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    gates[1]!.release();
    gates[2]!.release();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(order).toEqual([0, 1, 2]);
  });

  it("continues the chain after a rejection, preserving outcome", async () => {
    const q = new SerialQueue();
    const second = vi.fn(async () => "ok");
    const first = q.enqueue(async () => {
      throw new Error("boom");
    });
    const out = q.enqueue(second);
    await expect(first).rejects.toThrow("boom");
    await expect(out).resolves.toBe("ok");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("converts a synchronous task throw into rejection and continues", async () => {
    const q = new SerialQueue();
    const bad = q.enqueue(() => {
      throw new Error("sync");
    });
    const good = q.enqueue(async () => 7);
    await expect(bad).rejects.toThrow("sync");
    await expect(good).resolves.toBe(7);
  });
});
