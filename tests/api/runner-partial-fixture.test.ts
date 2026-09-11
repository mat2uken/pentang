import { describe, expect, it, vi } from "vitest";

// fixture欠落・部分欠落の分岐を covering する。製品fixtureとは別名でmockする。
vi.mock("../../packages/api/fixtures/golden-vectors.json", () => ({
  default: {
    valid: [
      {
        id: "basic",
        request: { values: [1, 2, 3], multiplier: 2, offset: 1 },
        expected: { values: [3, 5, 7], checksum: 15 },
      },
    ],
    // maximum-lengthなし + multiplier/offset/expected欠落の生成ケース
    generatedCases: [
      { id: "other-case" },
      { id: "maximum-length", count: 4, repeatValue: 1 },
    ],
  },
}));

import { runSelfTest } from "../../apps/demo/self-test/runner";
import { validateTransformRequest } from "../../packages/api/validation";

describe("runner missing/partial fixture", () => {
  it("maximum-lengthなし・部分fieldでも動作する", async () => {
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
    // valid 1件 + maximum-length相当 (count=4, repeat=1)。
    // expectedValue/Checksum欠落時はwant=0のため不一致となり failures に入る (分岐 covering)。
    const r = await runSelfTest(api as never);
    expect(r.successTotal).toBe(2);
    expect(r.successCount).toBe(1);
    expect(r.failures).toEqual(["maximum-length"]);
  });
});
