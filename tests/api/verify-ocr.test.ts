import { describe, expect, it } from "vitest";
import { findBox, hasExpectedResult } from "../../scripts/verify-ocr.mjs";

describe("findBox", () => {
  it("returns the center of the first matching line", () => {
    const boxes = "self-test\t0.1\t0.2\t0.4\t0.2\nother\t0.5\t0.5\t0.1\t0.1";
    const found = findBox(boxes, "self");
    expect(found?.text).toBe("self-test");
    expect(found?.nx).toBeCloseTo(0.3, 10);
    expect(found?.ny).toBeCloseTo(0.7, 10);
  });

  it("skips short lines and returns null when absent", () => {
    expect(findBox("broken\t0.1\n", "x")).toBeNull();
    expect(findBox("abc\t0\t0\t1\t1", "zzz")).toBeNull();
    expect(findBox("", "a")).toBeNull();
  });

  it("skips non-finite coordinates", () => {
    expect(findBox("a\tNaN\t0\t1\t1", "a")).toBeNull();
  });
});

describe("hasExpectedResult", () => {
  it("accepts the default self-test values", () => {
    expect(hasExpectedResult("values 3,5,7 checksum=15")).toBe(true);
    expect(hasExpectedResult("values\u30003\u30015\u30017\nchecksum = 15")).toBe(true);
  });

  it("rejects lookalikes with more digits", () => {
    expect(hasExpectedResult("checksum=150")).toBe(false);
    expect(hasExpectedResult("3,5,70")).toBe(false);
    expect(hasExpectedResult("nothing here")).toBe(false);
    expect(hasExpectedResult(null)).toBe(false);
  });
});
