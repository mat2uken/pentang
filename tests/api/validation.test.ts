import { describe, expect, it } from "vitest";
import { validateTransformRequest } from "../../src/api/validation";

describe("validation (A-01/input)", () => {
  const base = { values: [1, 2, 3], multiplier: 2, offset: 1 };

  it("input-10: -0/1.0を受理する", () => {
    const r = validateTransformRequest({
      values: [-0, 1.0],
      multiplier: 1.0,
      offset: -0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.validated.values]).toEqual([0, 1]);
      expect(r.validated.multiplier).toBe(1);
      expect(r.validated.offset).toBe(0);
    }
  });

  it("input-03: offset小数", () => {
    const r = validateTransformRequest({ ...base, offset: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
  });

  it("input-04: offset範囲外", () => {
    for (const v of [2147483648, -2147483649]) {
      const r = validateTransformRequest({ ...base, offset: v });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("input-05: values型不正", () => {
    for (const v of [null, {}, "str"]) {
      const r = validateTransformRequest({ ...base, values: v });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("input-06: multiplier型不正", () => {
    for (const v of [true, "2", null]) {
      const r = validateTransformRequest({ ...base, multiplier: v });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("input-07: 余分field", () => {
    const r = validateTransformRequest({ ...base, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
  });

  it("input-08: 必須field欠落が長さより先", () => {
    const big = new Array(4097).fill(1);
    const r = validateTransformRequest({ values: big, multiplier: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
  });

  it("input-09: 長さ検査が値より先", () => {
    const big = new Array(4097).fill(1);
    const r = validateTransformRequest({ values: big, multiplier: 0.5, offset: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("input-11: NaN/Infinity/undefined", () => {
    for (const v of [NaN, Infinity, -Infinity, undefined]) {
      const r = validateTransformRequest({ values: [v], multiplier: 1, offset: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("input-12: 疎配列を通さない", () => {
    const sparse = new Array(1);
    const r = validateTransformRequest({ values: sparse, multiplier: 1, offset: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
  });

  it("input-13: bigint/boolean/string/null", () => {
    const cases: unknown[] = [[BigInt(1)], [true], [["1"]], [[null]]];
    for (const values of cases) {
      const r = validateTransformRequest({ values, multiplier: 1, offset: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("input-14: prototype上のfieldは不可", () => {
    const proto = { values: [1], multiplier: 1, offset: 0 };
    const req = Object.create(proto);
    const r = validateTransformRequest(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGUMENT");
  });

  it("input-18: 呼出し直後のcaller変更の影響なし", () => {
    const values = [1, 2, 3];
    const req = { values, multiplier: 2, offset: 1 };
    const r = validateTransformRequest(req);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const snap = r.validated.snapshot();
      values[0] = 999;
      (req as { multiplier: number }).multiplier = 999;
      expect(snap.values).toEqual([1, 2, 3]);
      expect(snap.multiplier).toBe(2);
    }
  });
});
