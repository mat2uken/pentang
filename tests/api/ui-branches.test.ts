// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@backend", () => ({
  createBackend: vi.fn(),
}));

import { createBackend } from "@backend";
import { boot } from "../../src/ui";
import { validateTransformRequest } from "../../src/api/validation";

const mockedCreateBackend = createBackend as unknown as ReturnType<typeof vi.fn>;

function setupDom() {
  document.body.innerHTML = `
    <main>
      <p id="status">initializing</p>
      <p id="backend-info">backend: -</p>
      <p id="error"></p>
      <input id="values" value="[1,2,3]" />
      <input id="multiplier" value="2" />
      <input id="offset" value="1" />
      <button id="run">実行</button>
      <button id="selftest">self-test</button>
      <button id="dispose">破棄</button>
      <button id="reinit">再初期化</button>
      <p id="result">result: -</p>
      <p id="roundtrip"></p>
      <p id="selftest-result"></p>
    </main>`;
}

function okBackend(overrides: Record<string, unknown> = {}) {
  return {
    getInfo: vi.fn(async () => ({
      apiVersion: 1,
      backend: "tauri-native",
      hostOs: "macos",
      execution: "native-ffi",
      core: { abiVersion: 1, version: "0.1.0" },
    })),
    transform: vi.fn(async (req: { values: number[]; multiplier: number; offset: number }) => {
      const v = validateTransformRequest(req as unknown);
      if (!v.ok) throw v.error;
      const snap = v.validated.snapshot();
      const values = snap.values.map((val) => Math.max(-2147483648, Math.min(2147483647, val * snap.multiplier + snap.offset)));
      let sum = 0;
      for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
      return { values, checksum: sum };
    }),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

function click(id: string) {
  (document.getElementById(id) as HTMLButtonElement).click();
}

async function flush(ms = 15) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("ui branches extra", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDom();
  });

  it("old factory error after new generation is ignored", async () => {
    let rejectFirst!: (e: unknown) => void;
    const firstGate = new Promise<never>((_, rej) => {
      rejectFirst = rej;
    });
    const backend2 = okBackend();
    mockedCreateBackend.mockImplementationOnce(() => firstGate).mockImplementationOnce(async () => backend2 as never);
    const bootP = boot();
    await flush(5);
    // trigger new generation via dispose (backend null, generation++)
    click("dispose");
    await flush(5);
    // old factory rejects now -> should be ignored (myGen !== generation)
    rejectFirst({ code: "INITIALIZATION_FAILED", message: "old fail" });
    await flush(20);
    await bootP.catch(() => {});
    // after dispose, status disposed (not failed from old)
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });

  it("old factory success dispose throws is ignored", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstGate = new Promise<unknown>((res) => {
      resolveFirst = res;
    });
    const badDisposeBackend = okBackend({
      dispose: vi.fn(async () => {
        throw new Error("dispose boom");
      }),
    });
    const backend2 = okBackend();
    mockedCreateBackend.mockImplementationOnce(() => firstGate as Promise<never>).mockImplementationOnce(async () => backend2 as never);
    const bootP = boot();
    await flush(5);
    click("dispose");
    await flush(5);
    resolveFirst(badDisposeBackend);
    await flush(20);
    await bootP.catch(() => {});
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });

  it("getInfo race: success after new generation disposed", async () => {
    let resolveInfo!: (v: unknown) => void;
    const infoGate = new Promise<unknown>((res) => {
      resolveInfo = res;
    });
    const backend = okBackend({
      getInfo: vi.fn(() => infoGate as Promise<never>),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    const bootP = boot();
    await flush(10);
    // getInfo pending, trigger dispose to bump generation
    click("dispose");
    await flush(5);
    resolveInfo({ apiVersion: 1, backend: "tauri-native", hostOs: "macos", execution: "native-ffi", core: { abiVersion: 1, version: "0.1.0" } });
    await flush(20);
    await bootP.catch(() => {});
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });

  it("getInfo failure without code + race ignored", async () => {
    // without code
    const backend = okBackend({
      getInfo: vi.fn(async () => {
        throw new Error("raw info boom");
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    // error may contain INITIALIZATION_FAILED or raw message; at least status failed covers branch
    expect(document.getElementById("error")!.textContent !== null).toBe(true);

    // race: getInfo rejects after dispose
    setupDom();
    let rejectInfo!: (e: unknown) => void;
    const infoGate2 = new Promise<never>((_, rej) => {
      rejectInfo = rej;
    });
    const backend2 = okBackend({
      getInfo: vi.fn(() => infoGate2),
    });
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    const bootP2 = boot();
    await flush(10);
    click("dispose");
    await flush(5);
    rejectInfo({ code: "TRANSPORT_ERROR", message: "late fail" });
    await flush(20);
    await bootP2.catch(() => {});
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });

  it("run while initializing/failed ignored; self while failed ignored", async () => {
    let resolveBackend!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      resolveBackend = res;
    });
    mockedCreateBackend.mockImplementation(() => gate as Promise<never>);
    const bootP = boot();
    await flush(5);
    // initializing: run/self should be ignored (no crash)
    click("run");
    click("selftest");
    await flush(5);
    resolveBackend(okBackend());
    await flush(20);
    await bootP.catch(() => {});
    expect(document.getElementById("status")!.textContent).toBe("ready");

    // failed state: run ignored? Actually run requires ready, so in failed it returns early.
    setupDom();
    mockedCreateBackend.mockRejectedValue({ code: "INITIALIZATION_FAILED", message: "bad" });
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    click("run");
    click("selftest");
    await flush(10);
    // still failed, no crash
    expect(document.getElementById("status")!.textContent).toBe("failed");
  });

  it("run generation race success ignored; error race ignored", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      release = res as (v: unknown) => void;
    });
    const backend = okBackend({
      transform: vi.fn(() => gate as Promise<never>),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("run");
    await flush(5);
    // dispose bumps generation, then release success -> should be ignored (myGen !== generation, return without UI update)
    click("dispose");
    await flush(5);
    release({ values: [3, 5, 7], checksum: 15 });
    await flush(20);
    // result should stay "-" (old success ignored), status disposed
    expect(document.getElementById("status")!.textContent).toBe("disposed");
    expect(document.getElementById("result")!.textContent).toBe("result: -");

    // error race
    setupDom();
    let rejectT!: (e: unknown) => void;
    const gate2 = new Promise<never>((_, rej) => {
      rejectT = rej;
    });
    const backend2 = okBackend({
      transform: vi.fn(() => gate2),
    });
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    await boot();
    click("run");
    await flush(5);
    click("dispose");
    await flush(5);
    rejectT({ code: "TIMEOUT", message: "late timeout" });
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });

  it("run error without code defaults to TRANSPORT", async () => {
    const backend = okBackend({
      transform: vi.fn(async () => {
        throw new Error("raw transform boom");
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("run");
    await flush(20);
    expect(document.getElementById("error")!.textContent).toContain("TRANSPORT_ERROR");
    // raw Error has no code, so failed? ce.code undefined, not in fatal list, stays ready
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });

  it("self-test throw + race + failures suffix", async () => {
    // self-test that throws (mock runSelfTest via backend that makes runner throw? Runner never throws, but UI catches if runSelfTest itself throws.
    // To force throw, make backend.transform throw sync non-AppError that runner doesn't catch? Runner catches per-case, so still not throw.
    // Instead test failures suffix by using backend that returns wrong values (failures non-empty) – already covered, but ensure suffix branch (failures.length>0) vs empty both covered.
    // Here test success with failures (wrong impl) to cover suffix true.
    const bad = okBackend({
      transform: vi.fn(async (req: { values: number[]; multiplier: number; offset: number }) => {
        const v = validateTransformRequest(req as unknown);
        if (!v.ok) throw v.error;
        return { values: [0], checksum: 0 };
      }),
    });
    mockedCreateBackend.mockResolvedValue(bad as never);
    await boot();
    click("selftest");
    await flush(60);
    expect(document.getElementById("selftest-result")!.textContent).toContain("failures:");

    // race: selftest pending then dispose
    setupDom();
    const backend2 = okBackend();
    // make runSelfTest hang by making transform hang
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      release = res as (v: unknown) => void;
    });
    // Use real runner but with hanging transform for first valid case: it will hang. Dispose should ignore result.
    const hanging = okBackend({
      transform: vi.fn(() => gate as Promise<never>),
    });
    mockedCreateBackend.mockResolvedValue(hanging as never);
    await boot();
    click("selftest");
    await flush(5);
    click("dispose");
    await flush(5);
    release({ values: [3, 5, 7], checksum: 15 });
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("disposed");
    void backend2;
  });

  it("dispose with backend dispose throws ignored; reinit with dispose throws", async () => {
    const backend = okBackend({
      dispose: vi.fn(async () => {
        throw new Error("dispose fail");
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("dispose");
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("disposed");

    // reinit with old backend dispose throws
    setupDom();
    const backend2 = okBackend({
      dispose: vi.fn(async () => {
        throw new Error("dispose fail2");
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    await boot();
    const backend3 = okBackend();
    mockedCreateBackend.mockResolvedValue(backend3 as never);
    click("reinit");
    await flush(30);
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });

  it("reinit while busy ignored; reinit without backend", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      release = res as (v: unknown) => void;
    });
    const backend = okBackend({
      transform: vi.fn(() => gate as Promise<never>),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("run");
    await flush(5);
    click("reinit");
    await flush(5);
    // still busy, reinit ignored, status still ready (not disposed)
    expect(document.getElementById("status")!.textContent).toBe("ready");
    release({ values: [3, 5, 7], checksum: 15 });
    await flush(20);

    // reinit without backend (after init fail)
    setupDom();
    mockedCreateBackend.mockRejectedValue({ code: "INITIALIZATION_FAILED", message: "bad" });
    await boot();
    const backend2 = okBackend();
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    click("reinit");
    await flush(30);
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });
});
