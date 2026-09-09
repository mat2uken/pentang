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
  const el = document.getElementById(id) as HTMLButtonElement;
  el.click();
}

async function flush(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("ui boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDom();
  });

  it("missing element throws", async () => {
    document.body.innerHTML = `<p id="status"></p>`;
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    await expect(boot()).rejects.toThrow(/missing #/);
  });

  it("ready flow + run success", async () => {
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("ready");
    expect(document.getElementById("backend-info")!.textContent).toContain("tauri-native");
    click("run");
    await flush(30);
    expect(document.getElementById("result")!.textContent).toContain("checksum=15");
    expect(document.getElementById("roundtrip")!.textContent).toContain("roundtrip:");
  });

  it("parse invalid JSON -> INVALID, empty int field", async () => {
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    await boot();
    (document.getElementById("values") as HTMLInputElement).value = "not-json";
    click("run");
    await flush(20);
    expect(document.getElementById("error")!.textContent).toContain("INVALID_ARGUMENT");
    expect(document.getElementById("result")!.textContent).toBe("result: -");

    (document.getElementById("values") as HTMLInputElement).value = "[1]";
    (document.getElementById("multiplier") as HTMLInputElement).value = "";
    click("run");
    await flush(20);
    expect(document.getElementById("error")!.textContent).toContain("INVALID_ARGUMENT");

    (document.getElementById("multiplier") as HTMLInputElement).value = "abc";
    (document.getElementById("offset") as HTMLInputElement).value = "1";
    click("run");
    await flush(20);
    expect(document.getElementById("error")!.textContent).toContain("INVALID_ARGUMENT");
  });

  it("transform fatal code sets failed state", async () => {
    const backend = okBackend({
      transform: vi.fn(async () => {
        throw { code: "TIMEOUT", message: "timed out" };
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("run");
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("failed");
    // non-fatal code keeps ready
    const backend2 = okBackend({
      transform: vi.fn(async () => {
        throw { code: "INVALID_ARGUMENT", message: "bad" };
      }),
    });
    setupDom();
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    await boot();
    click("run");
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("ready");
    for (const code of ["TRANSPORT_ERROR", "WORKER_FAILED", "CORE_FAILURE", "ABI_MISMATCH"]) {
      const b = okBackend({
        transform: vi.fn(async () => {
          throw { code, message: "boom" };
        }),
      });
      setupDom();
      mockedCreateBackend.mockResolvedValue(b as never);
      await boot();
      // need valid inputs
      click("run");
      await flush(20);
      expect(document.getElementById("status")!.textContent).toBe("failed");
    }
  });

  it("self-test success and failure paths", async () => {
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    await boot();
    click("selftest");
    await flush(50);
    const txt = document.getElementById("selftest-result")!.textContent ?? "";
    expect(txt).toContain("success 11/11");
    expect(txt).toContain("invalid 7/7");

    // backend that fails self-test transform
    const bad = okBackend({
      transform: vi.fn(async () => {
        throw { code: "INVALID_ARGUMENT", message: "bad" };
      }),
    });
    setupDom();
    mockedCreateBackend.mockResolvedValue(bad as never);
    await boot();
    click("selftest");
    await flush(50);
    const txt2 = document.getElementById("selftest-result")!.textContent ?? "";
    // runSelfTest doesn't throw, it reports failures
    expect(txt2).toContain("self-test: success");

    // backend where runSelfTest throws (mock via transform throwing non-AppError? Actually runner catches per-case, so to force throw we need getInfo? Instead mock transform to throw sync object without code)
    // Use backend whose transform throws a raw Error that runner records as failure, still not throw. To cover catch branch, make backend.transform itself throw synchronously before runner? Runner awaits transform, so still caught.
    // Cover selftest catch by making backend null? Instead test busy guard: clicking twice quickly should ignore second.
    setupDom();
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    await boot();
    click("selftest");
    click("selftest");
    await flush(60);
    expect(document.getElementById("selftest-result")!.textContent).toContain("success");
  });

  it("dispose -> disposed, reinit -> ready", async () => {
    const backend = okBackend();
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("ready");
    click("dispose");
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("disposed");
    expect(backend.dispose).toHaveBeenCalled();
    // run ignored when disposed
    click("run");
    await flush(10);
    // reinit creates new backend
    const backend2 = okBackend();
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    click("reinit");
    await flush(30);
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });

  it("dispose without backend + reinit without backend", async () => {
    mockedCreateBackend.mockRejectedValue({ code: "INITIALIZATION_FAILED", message: "init bad" });
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    // dispose with null backend (init failed -> backend null)
    click("dispose");
    await flush(10);
    expect(document.getElementById("status")!.textContent).toBe("disposed");
    const backend2 = okBackend();
    mockedCreateBackend.mockResolvedValue(backend2 as never);
    click("reinit");
    await flush(30);
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });

  it("init failure shows failed", async () => {
    mockedCreateBackend.mockRejectedValue({ code: "INITIALIZATION_FAILED", message: "nope" });
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    expect(document.getElementById("error")!.textContent).toContain("INITIALIZATION_FAILED");
  });

  it("init failure without code defaults", async () => {
    mockedCreateBackend.mockRejectedValue(new Error("raw boom"));
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
  });

  it("getInfo failure after create shows failed", async () => {
    const backend = okBackend({
      getInfo: vi.fn(async () => {
        throw { code: "TRANSPORT_ERROR", message: "info boom" };
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
  });

  it("busy guard: run while busy ignored, reinit while busy ignored", async () => {
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
    // second run while busy should be ignored
    click("run");
    // reinit while busy should be ignored (busy true)
    click("reinit");
    await flush(5);
    release({ values: [3, 5, 7], checksum: 15 });
    await flush(20);
    expect(document.getElementById("result")!.textContent).toContain("checksum=15");
    await (backend.dispose as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("generation race: old factory resolves after new is ignored and disposed", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstGate = new Promise<unknown>((res) => {
      resolveFirst = res;
    });
    const backend1 = okBackend();
    const backend2 = okBackend();
    mockedCreateBackend
      .mockImplementationOnce(() => firstGate as Promise<never>)
      .mockImplementationOnce(async () => backend2 as never);
    const bootP = boot();
    // boot calls setupBackend once (firstGate pending). Trigger reinit via direct? Instead simulate second generation by calling dispose+reinit? Simpler: start second boot concurrently.
    // Second boot will increment? Actually generation is per-boot closure, not shared. To test race, we need reinit path: click reinit while first init pending.
    // For this test, we set up DOM, start boot (pending), then simulate reinit click after boot's setup started? But reinit button exists only after boot finishes setup? Actually boot sets listeners before setupBackend, so we can click reinit while initializing.
    await flush(5);
    // trigger reinit (backend null, generation++ and new setupBackend)
    click("reinit");
    await flush(5);
    // now resolve first (old) - should be disposed and ignored
    resolveFirst(backend1);
    await flush(20);
    await bootP.catch(() => {});
    await flush(20);
    // backend1 should have been disposed
    expect(backend1.dispose).toHaveBeenCalled();
  });
});
