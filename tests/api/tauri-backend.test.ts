import { describe, expect, it, vi } from "vitest";
import {
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

describe("tauri-backend", () => {
  it("init成功・基本変換・入力不変", async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "core_get_info") return okInfo();
      if (cmd === "core_transform") {
        const req = (args as { request: { values: number[]; multiplier: number; offset: number } }).request;
        const values = req.values.map((v) => {
          const r = v * req.multiplier + req.offset;
          return Math.max(-2147483648, Math.min(2147483647, r));
        });
        let sum = 0;
        for (const v of values) sum = (sum + (v >>> 0)) >>> 0;
        return { values, checksum: sum };
      }
      throw new Error(`unknown ${cmd}`);
    });
    const api = await createTauriBackendWithDeps({ invoke });
    const info = await api.getInfo();
    expect(info.core.abiVersion).toBe(1);
    const r = await api.transform({ values: [1, 2, 3], multiplier: 2, offset: 1 });
    expect([...r.values]).toEqual([3, 5, 7]);
    expect(r.checksum).toBe(15);
    await api.dispose();
  });

  it("不正入力は送信せずINVALID (A-01)", async () => {
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke });
    // initで1回だけ呼ばれる
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(api.transform({ values: [1.5], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // 不正入力では通信しない
    expect(invoke).toHaveBeenCalledTimes(1);
    await api.dispose();
  });

  it("BUSY: 8保留中に9件目を拒否 (L-01)", async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((res) => {
      release = () => res(okInfo());
    });
    let calls = 0;
    const invoke = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(okInfo());
      return gate;
    });
    const backend = createTauriBackendForTest({ invoke });
    await backend.init();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      promises.push(backend.getInfo().catch((e) => e));
    }
    await expect(backend.getInfo()).rejects.toMatchObject({ code: "BUSY" });
    release();
    const results = await Promise.all(promises);
    expect(results.length).toBe(8);
    await backend.dispose();
  });

  it("TRANSPORT: 未知のstring拒否はTRANSPORT_ERRORでfailed (L-02/life-06)", async () => {
    let calls = 0;
    const invoke = vi.fn(async (cmd: string) => {
      calls++;
      if (calls === 1 && cmd === "core_get_info") return okInfo();
      throw "boom-string";
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    // 以後は保存した失敗を返す
    await expect(api.getInfo()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await api.dispose();
  });

  it("ABI不一致はABI_MISMATCHでfailed (W-03/life-10相当)", async () => {
    const bad = { ...okInfo(), core: { abiVersion: 999, version: "9.9.9" } };
    const invoke = vi.fn(async () => bad);
    const backend = createTauriBackendForTest({ invoke });
    await expect(backend.init()).rejects.toMatchObject({ code: "ABI_MISMATCH" });
  });

  it("dispose後はDISPOSED、2回dispose成功 (L-03)", async () => {
    const invoke = vi.fn(async () => okInfo());
    const api = await createTauriBackendWithDeps({ invoke });
    await api.dispose();
    await api.dispose();
    await expect(api.getInfo()).rejects.toMatchObject({ code: "DISPOSED" });
    await expect(api.transform({ values: [1], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "DISPOSED",
    });
  });

  it("応答の形不正はTRANSPORT_ERROR (A-03/life-08)", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "core_get_info") return okInfo();
      return { values: [1, 2], checksum: -1 };
    });
    const api = await createTauriBackendWithDeps({ invoke });
    await expect(api.transform({ values: [1, 2], multiplier: 1, offset: 0 })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    await api.dispose();
  });
});
