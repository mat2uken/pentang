import { describe, expect, it } from "vitest";
import { isPocCoreModule } from "../../packages/backends/browser/wasm-types";

function validModule() {
  return {
    _poc_core_abi_version: () => 1,
    _poc_core_version: () => 1,
    _poc_transform_i32: () => 0,
    _malloc: () => 1,
    _free: () => {},
    UTF8ToString: () => "0.1.0",
    HEAP32: new Int32Array(4),
    HEAPU32: new Uint32Array(4),
  };
}

describe("wasm-types isPocCoreModule", () => {
  it("valid module", () => {
    expect(isPocCoreModule(validModule())).toBe(true);
  });

  it("invalid shapes", () => {
    expect(isPocCoreModule(null)).toBe(false);
    expect(isPocCoreModule(undefined)).toBe(false);
    expect(isPocCoreModule({})).toBe(false);
    expect(isPocCoreModule("str")).toBe(false);
    const m = validModule() as Record<string, unknown>;
    for (const k of [
      "_poc_core_abi_version",
      "_poc_core_version",
      "_poc_transform_i32",
      "_malloc",
      "_free",
      "UTF8ToString",
    ]) {
      const copy = { ...m, [k]: 123 };
      expect(isPocCoreModule(copy)).toBe(false);
    }
    expect(isPocCoreModule({ ...m, HEAP32: new Uint8Array(4) })).toBe(false);
    expect(isPocCoreModule({ ...m, HEAPU32: new Int32Array(4) })).toBe(false);
    expect(isPocCoreModule({ ...m, HEAP32: "x", HEAPU32: new Uint32Array(4) })).toBe(false);
  });
});
