import { describe, expect, it, vi } from "vitest";
import { runSelfTest } from "../../apps/poc-demo/self-test/runner";
import type { ApplicationApi } from "../../packages/api/application-api";
import { validateTransformRequest } from "../../packages/api/validation";

function makeApi(opts: {
  transformImpl?: (req: { values: readonly number[]; multiplier: number; offset: number }) => Promise<{ values: number[]; checksum: number }>;
} = {}): ApplicationApi {
  const impl =
    opts.transformImpl ??
    (async (req: { values: readonly number[]; multiplier: number; offset: number }) => {
      // mimic real backend validation first
      const v = validateTransformRequest(req as unknown);
      if (!v.ok) throw v.error;
      const snap = v.validated.snapshot();
      const values = snap.values.map((val) => {
        const r = val * snap.multiplier + snap.offset;
        return Math.max(-2147483648, Math.min(2147483647, r));
      });
      let sum = 0;
      for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
      return { values: [...values], checksum: sum };
    });
  return {
    getInfo: vi.fn(async () => ({
      apiVersion: 1 as const,
      backend: "tauri-native" as const,
      hostOs: "macos" as const,
      execution: "native-ffi" as const,
      core: { abiVersion: 1, version: "0.1.0" },
    })),
    transform: vi.fn(impl as never),
    dispose: vi.fn(async () => {}),
  };
}

describe("self-test runner", () => {
  it("all pass with correct impl", async () => {
    const api = makeApi();
    const r = await runSelfTest(api);
    expect(r.successCount).toBe(r.successTotal);
    expect(r.successTotal).toBe(11);
    expect(r.invalidPassed).toBe(r.invalidTotal);
    expect(r.invalidTotal).toBe(7);
    expect(r.failures).toEqual([]);
  });

  it("detects value mismatch", async () => {
    const api = makeApi({
      transformImpl: async () => ({ values: [0], checksum: 0 }),
    });
    const r = await runSelfTest(api);
    expect(r.successCount).toBeLessThan(r.successTotal);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("detects throw with code", async () => {
    const api = makeApi({
      transformImpl: async () => {
        throw { code: "CORE_FAILURE", message: "boom" };
      },
    });
    const r = await runSelfTest(api);
    expect(r.failures.some((f) => f.includes("CORE_FAILURE") || f.includes("throw"))).toBe(true);
  });

  it("maximum-length mismatch and invalid case success-path", async () => {
    // transform returns wrong length for max case but correct for others:
    // use impl that truncates 4096 to 4095
    const base = makeApi();
    const orig = base.transform;
    const api: ApplicationApi = {
      ...base,
      transform: (async (req: never) => {
        const r = await (orig as (x: never) => Promise<{ values: number[]; checksum: number }>)(req);
        const rr = req as unknown as { values: unknown[] };
        if (Array.isArray(rr.values) && rr.values.length === 4096) {
          return { values: r.values.slice(0, 4095), checksum: r.checksum };
        }
        return r;
      }) as ApplicationApi["transform"],
    };
    const r = await runSelfTest(api);
    expect(r.failures).toContain("maximum-length");
  });

  it("invalid cases: success instead of reject is failure", async () => {
    const api = makeApi({
      transformImpl: async (req) => {
        // accept everything, even invalid
        const values = [...req.values] as number[];
        return { values, checksum: 0 };
      },
    });
    const r = await runSelfTest(api);
    // invalid should not pass because impl doesn't reject
    expect(r.invalidPassed).toBeLessThan(r.invalidTotal);
    expect(r.failures.some((f) => f.includes("expected-"))).toBe(true);
  });

  it("invalid cases: wrong code is failure", async () => {
    const api = makeApi({
      transformImpl: async (req) => {
        // always throw INVALID even for LIMIT case
        const rr = req as unknown as { values: unknown[] };
        if (Array.isArray(rr.values) && rr.values.length > 4096) {
          throw { code: "INVALID_ARGUMENT", message: "wrong code" };
        }
        const vals = req.values as number[];
        for (const v of vals) {
          if (typeof v !== "number" || !Number.isInteger(v)) throw { code: "INVALID_ARGUMENT", message: "bad" };
        }
        // missing field etc handled by caller? Here we simulate backend validation:
        throw { code: "INVALID_ARGUMENT", message: "bad" };
      },
    });
    // For too-long, want LIMIT_EXCEEDED but got INVALID -> failure entry
    const r = await runSelfTest(api);
    // too-long case will be reported as want-LIMIT-got-INVALID
    expect(r.failures.some((f) => f.includes("too-long"))).toBe(true);
  });
});
