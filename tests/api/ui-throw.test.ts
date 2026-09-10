// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@backend", () => ({
  createBackend: vi.fn(),
}));

vi.mock("../../apps/demo/self-test/runner", () => ({
  runSelfTest: vi.fn(),
}));

import { createBackend } from "@backend";
import { runSelfTest } from "../../apps/demo/self-test/runner";
import { boot } from "../../apps/demo/ui";
import { validateTransformRequest } from "../../packages/api/validation";

const mockedCreateBackend = createBackend as unknown as ReturnType<typeof vi.fn>;
const mockedRunSelfTest = runSelfTest as unknown as ReturnType<typeof vi.fn>;

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

describe("ui throw branches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDom();
    mockedRunSelfTest.mockResolvedValue({
      successCount: 11,
      successTotal: 11,
      invalidPassed: 7,
      invalidTotal: 7,
      failures: [],
    });
  });

  it("create rejects null/undefined -> INITIALIZATION_FAILED", async () => {
    mockedCreateBackend.mockRejectedValue(null);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    expect(document.getElementById("error")!.textContent).toContain("INITIALIZATION_FAILED");

    setupDom();
    mockedCreateBackend.mockRejectedValue(undefined);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
  });

  it("getInfo rejects null -> failed", async () => {
    const backend = okBackend({
      getInfo: vi.fn(async () => {
        throw null;
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    expect(document.getElementById("status")!.textContent).toBe("failed");
    expect(document.getElementById("error")!.textContent).toContain("INITIALIZATION_FAILED");
  });

  it("transform rejects null -> TRANSPORT_ERROR shown", async () => {
    const backend = okBackend({
      transform: vi.fn(async () => {
        throw null;
      }),
    });
    mockedCreateBackend.mockResolvedValue(backend as never);
    await boot();
    click("run");
    await flush(20);
    expect(document.getElementById("error")!.textContent).toContain("TRANSPORT_ERROR");
    expect(document.getElementById("status")!.textContent).toBe("ready");
  });

  it("runSelfTest throws -> failed text", async () => {
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    mockedRunSelfTest.mockRejectedValue(new Error("runner boom"));
    await boot();
    click("selftest");
    await flush(20);
    expect(document.getElementById("selftest-result")!.textContent).toContain("failed");
  });

  it("runSelfTest rejects after dispose -> ignored", async () => {
    mockedCreateBackend.mockResolvedValue(okBackend() as never);
    let rejectRunner!: (e: unknown) => void;
    mockedRunSelfTest.mockImplementation(
      () =>
        new Promise<never>((_, rej) => {
          rejectRunner = rej;
        }),
    );
    await boot();
    click("selftest");
    await flush(5);
    click("dispose");
    await flush(5);
    rejectRunner(new Error("late boom"));
    await flush(20);
    expect(document.getElementById("status")!.textContent).toBe("disposed");
  });
});
