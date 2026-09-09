import { describe, expect, it } from "vitest";
import {
  checkResultLength,
  isSingleFailure,
  toErrorCode,
} from "../../src/backends/pipeline";

describe("pipeline shared helpers", () => {
  it("isSingleFailure: 単発/致命の分類", () => {
    for (const c of ["INVALID_ARGUMENT", "LIMIT_EXCEEDED", "BUSY", "OUT_OF_MEMORY"]) {
      expect(isSingleFailure(c)).toBe(true);
    }
    for (const c of ["TIMEOUT", "TRANSPORT_ERROR", "CORE_FAILURE", "DISPOSED", "ABI_MISMATCH", "INITIALIZATION_FAILED", "WORKER_FAILED", "UNKNOWN", 1, null, undefined]) {
      expect(isSingleFailure(c)).toBe(false);
    }
  });

  it("toErrorCode: 既知は通過・未知はfallback", () => {
    expect(toErrorCode("TIMEOUT", "TRANSPORT_ERROR")).toBe("TIMEOUT");
    expect(toErrorCode("bogus", "TRANSPORT_ERROR")).toBe("TRANSPORT_ERROR");
    expect(toErrorCode(undefined, "CORE_FAILURE")).toBe("CORE_FAILURE");
    expect(toErrorCode(42, "BUSY")).toBe("BUSY");
  });

  it("checkResultLength: 一致はnull・不一致はTRANSPORT_ERROR", () => {
    expect(checkResultLength(3, 3)).toBeNull();
    expect(checkResultLength(0, 0)).toBeNull();
    const e = checkResultLength(2, 3);
    expect(e?.code).toBe("TRANSPORT_ERROR");
  });
});
