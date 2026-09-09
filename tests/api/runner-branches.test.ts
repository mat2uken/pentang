import { describe, expect, it, vi } from "vitest";

describe("runner branches: throw without code + missing max", () => {
  it("throw string without code for valid + max", async () => {
    vi.resetModules();
    // use real fixture but impl throws string
    const { runSelfTest } = await import("../../src/self-test/runner");
    const api = {
      getInfo: async () => ({}),
      transform: async (req: unknown) => {
        const r = req as { values?: unknown };
        // for valid basic [1,2,3], throw string (no code)
        if (Array.isArray(r.values) && r.values.length === 3 && (r.values as number[])[0] === 1) {
          throw "string-boom";
        }
        // for max (4096), throw Error without code
        if (Array.isArray(r.values) && r.values.length === 4096) {
          throw new Error("max boom");
        }
        // for invalid cases, behave correctly via validation
        const { validateTransformRequest } = await import("../../src/api/validation");
        const v = validateTransformRequest(req as unknown);
        if (!v.ok) throw v.error;
        const s = v.validated.snapshot();
        const values = s.values.map((val) => Math.max(-2147483648, Math.min(2147483647, val * s.multiplier + s.offset)));
        let sum = 0;
        for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
        return { values, checksum: sum };
      },
      dispose: async () => {},
    };
    const res = await runSelfTest(api as never);
    // valid throw without code should be recorded with string
    expect(res.failures.some((f) => f.includes("string-boom") || f.includes("throw"))).toBe(true);
    expect(res.failures.some((f) => f.includes("maximum-length"))).toBe(true);
  });

  it("value mismatch branches (length, every, checksum)", async () => {
    const { runSelfTest } = await import("../../src/self-test/runner");
    // length mismatch for basic
    const apiLen = {
      getInfo: async () => ({}),
      transform: async (req: unknown) => {
        const { validateTransformRequest } = await import("../../src/api/validation");
        const v = validateTransformRequest(req as unknown);
        if (!v.ok) throw v.error;
        const s = v.validated.snapshot();
        // for basic, return wrong length
        if (s.values.length === 3 && s.values[0] === 1) {
          return { values: [3, 5], checksum: 8 };
        }
        const values = s.values.map((val) => Math.max(-2147483648, Math.min(2147483647, val * s.multiplier + s.offset)));
        let sum = 0;
        for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
        return { values, checksum: sum };
      },
      dispose: async () => {},
    };
    const r1 = await runSelfTest(apiLen as never);
    expect(r1.failures).toContain("basic");

    // every mismatch (same length, wrong value)
    const apiVal = {
      getInfo: async () => ({}),
      transform: async (req: unknown) => {
        const { validateTransformRequest } = await import("../../src/api/validation");
        const v = validateTransformRequest(req as unknown);
        if (!v.ok) throw v.error;
        const s = v.validated.snapshot();
        if (s.values.length === 3 && s.values[0] === 1) {
          return { values: [3, 5, 999], checksum: 1007 };
        }
        const values = s.values.map((val) => Math.max(-2147483648, Math.min(2147483647, val * s.multiplier + s.offset)));
        let sum = 0;
        for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
        return { values, checksum: sum };
      },
      dispose: async () => {},
    };
    const r2 = await runSelfTest(apiVal as never);
    expect(r2.failures).toContain("basic");

    // checksum mismatch
    const apiSum = {
      getInfo: async () => ({}),
      transform: async (req: unknown) => {
        const { validateTransformRequest } = await import("../../src/api/validation");
        const v = validateTransformRequest(req as unknown);
        if (!v.ok) throw v.error;
        const s = v.validated.snapshot();
        if (s.values.length === 3 && s.values[0] === 1) {
          return { values: [3, 5, 7], checksum: 999 };
        }
        const values = s.values.map((val) => Math.max(-2147483648, Math.min(2147483647, val * s.multiplier + s.offset)));
        let sum = 0;
        for (const val of values) sum = (sum + (val >>> 0)) >>> 0;
        return { values, checksum: sum };
      },
      dispose: async () => {},
    };
    const r3 = await runSelfTest(apiSum as never);
    expect(r3.failures).toContain("basic");
  });
});
