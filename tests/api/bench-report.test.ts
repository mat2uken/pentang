import { describe, expect, it, vi, afterEach } from "vitest";
import { postReport, resolveReportTarget } from "../../apps/poc-demo/self-test/bench-runner";
import type { BenchReport } from "../../apps/poc-demo/self-test/bench-runner";

function dummyReport(): BenchReport {
  return {
    tool: "webview-bench",
    userAgent: "test",
    timestamp: "2026-01-01T00:00:00Z",
    timerQuantumMs: 0,
    schemeReachable: true,
    schemeUrl: "pocbin://localhost/transform",
    schemeMethod: "POST",
    cases: [],
    agreement: true,
  };
}

describe("bench report target", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("query ?report= wins", () => {
    expect(resolveReportTarget("?bench=1&report=http://h:1/b")).toBe("http://h:1/b");
  });

  it("empty query value falls through", () => {
    expect(resolveReportTarget("?report=")).toBe(null);
  });

  it("no target without query", () => {
    // VITE_BENCH_REPORT_URL 未設定の通常ビルドではnull。
    expect(resolveReportTarget("?bench=1")).toBe(null);
    expect(resolveReportTarget("")).toBe(null);
  });

  it("postReport posts JSON and returns ok flag", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postReport("http://h:1/b", dummyReport())).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: unknown }];
    expect(url).toBe("http://h:1/b");
    expect(JSON.parse(init.body as string).tool).toBe("webview-bench");
  });

  it("postReport swallows network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    expect(await postReport("http://h:1/b", dummyReport())).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await postReport("http://h:1/b", dummyReport())).toBe(false);
  });
});
