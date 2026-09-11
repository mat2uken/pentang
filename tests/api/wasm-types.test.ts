import { describe, expect, it } from "vitest";
import { isCoreModule } from "../../packages/backends/browser/wasm-types";

function validModule() {
  return {
    _core_abi_version: () => 1,
    _core_version: () => 1,
    _core_transform_i32: () => 0,
    _malloc: () => 1,
    _free: () => {},
    UTF8ToString: () => "0.1.0",
    HEAP32: new Int32Array(4),
    HEAPU32: new Uint32Array(4),
  };
}

describe("wasm-types isCoreModule", () => {
  it("valid module", () => {
    expect(isCoreModule(validModule())).toBe(true);
  });

  it("invalid shapes", () => {
    expect(isCoreModule(null)).toBe(false);
    expect(isCoreModule(undefined)).toBe(false);
    expect(isCoreModule({})).toBe(false);
    expect(isCoreModule("str")).toBe(false);
    const m = validModule() as Record<string, unknown>;
    for (const k of [
      "_core_abi_version",
      "_core_version",
      "_core_transform_i32",
      "_malloc",
      "_free",
      "UTF8ToString",
    ]) {
      const copy = { ...m, [k]: 123 };
      expect(isCoreModule(copy)).toBe(false);
    }
    expect(isCoreModule({ ...m, HEAP32: new Uint8Array(4) })).toBe(false);
    expect(isCoreModule({ ...m, HEAPU32: new Int32Array(4) })).toBe(false);
    expect(isCoreModule({ ...m, HEAP32: "x", HEAPU32: new Uint32Array(4) })).toBe(false);
  });
});
