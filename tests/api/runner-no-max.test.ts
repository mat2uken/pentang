import { describe, expect, it, vi } from "vitest";

// maximum-length自体がないfixture。runnerの欠落分岐を covering する。
vi.mock("../../tests/fixtures/golden-vectors.json", () => ({
  default: {
    valid: [
      {
        id: "basic",
        request: { values: [1, 2, 3], multiplier: 2, offset: 1 },
        expected: { values: [3, 5, 7], checksum: 15 },
      },
    ],
    generatedCases: [{ id: "other-case" }],
  },
}));

import { runSelfTest } from "../../src/self-test/runner";
import { validateTransformRequest } from "../../src/api/validation";

describe("runner without maximum-length", () => {
  it("生成ケースなしでもvalid分は成功する", async () => {
    const api = {
      getInfo: async () => ({}),
      transform: async (req: unknown) => {
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
    const r = await runSelfTest(api as never);
    expect(r.successTotal).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.failures).toEqual([]);
  });
});
