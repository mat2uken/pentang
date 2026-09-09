import { describe, expect, it } from "vitest";
import {
  appError,
  isAppError,
  isAppErrorCode,
  normalizeInvokeRejection,
  transportError,
} from "../../src/api/errors";

describe("errors", () => {
  it("isAppErrorCode: known/unknown", () => {
    for (const c of [
      "INVALID_ARGUMENT",
      "LIMIT_EXCEEDED",
      "INITIALIZATION_FAILED",
      "ABI_MISMATCH",
      "CORE_FAILURE",
      "OUT_OF_MEMORY",
      "TRANSPORT_ERROR",
      "WORKER_FAILED",
      "TIMEOUT",
      "BUSY",
      "DISPOSED",
    ]) {
      expect(isAppErrorCode(c)).toBe(true);
    }
    expect(isAppErrorCode("UNKNOWN")).toBe(false);
    expect(isAppErrorCode(123)).toBe(false);
    expect(isAppErrorCode(null)).toBe(false);
    expect(isAppErrorCode(undefined)).toBe(false);
  });

  it("isAppError: shape check", () => {
    expect(isAppError({ code: "TIMEOUT", message: "t" })).toBe(true);
    expect(isAppError({ code: "TIMEOUT" })).toBe(false);
    expect(isAppError({ code: "BAD", message: "x" })).toBe(false);
    expect(isAppError({ code: "TIMEOUT", message: 123 })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("str")).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });

  it("appError/transportError", () => {
    expect(appError("BUSY", "b")).toEqual({ code: "BUSY", message: "b" });
    expect(transportError("t")).toEqual({ code: "TRANSPORT_ERROR", message: "t" });
  });

  it("normalizeInvokeRejection: AppError passthrough copy", () => {
    const e = { code: "BUSY", message: "busy" } as const;
    const n = normalizeInvokeRejection(e);
    expect(n).toEqual({ code: "BUSY", message: "busy" });
    // copy, not same reference
    expect(n).not.toBe(e);
  });

  it("normalizeInvokeRejection: string/Error/unknown/circular", () => {
    const s = normalizeInvokeRejection("boom-string");
    expect(s.code).toBe("TRANSPORT_ERROR");
    expect(s.message).toContain("boom-string");

    const err = normalizeInvokeRejection(new Error("oops-long-message"));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain("oops-long-message");

    const obj = normalizeInvokeRejection({ foo: 1 });
    expect(obj.code).toBe("TRANSPORT_ERROR");

    const num = normalizeInvokeRejection(42);
    expect(num.code).toBe("TRANSPORT_ERROR");

    const undef = normalizeInvokeRejection(undefined);
    expect(undef.code).toBe("TRANSPORT_ERROR");

    // JSON.stringify throws (circular + toJSON throws) path
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    // JSON.stringify(circular) throws, but our code catches via try/catch? Actually JSON.stringify circular throws,
    // so it goes to catch branch.
    const circ = normalizeInvokeRejection(circular);
    expect(circ.code).toBe("TRANSPORT_ERROR");

    const badToJSON = {
      toJSON() {
        throw new Error("toJSON fail");
      },
    };
    const bad = normalizeInvokeRejection(badToJSON);
    expect(bad.code).toBe("TRANSPORT_ERROR");
  });
});
