import { describe, expect, it } from "vitest";
import {
  validateRuntimeInfo,
  validateTransformRequest,
  validateTransformResult,
} from "../../src/api/validation";

describe("validation result/runtime (A-03/C-01)", () => {
  it("validateTransformResult: ok + freeze", () => {
    const r = validateTransformResult({ values: [3, 5, 7], checksum: 15 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.result.values]).toEqual([3, 5, 7]);
      expect(r.result.checksum).toBe(15);
      expect(Object.isFrozen(r.result.values)).toBe(true);
    }
  });

  it("validateTransformResult: rejects", () => {
    expect(validateTransformResult(null).ok).toBe(false);
    expect(validateTransformResult([]).ok).toBe(false);
    expect(validateTransformResult({}).ok).toBe(false);
    expect(validateTransformResult({ values: "x", checksum: 1 }).ok).toBe(false);
    expect(validateTransformResult({ values: [1.5], checksum: 1 }).ok).toBe(false);
    // sparse
    const sparse = new Array(1);
    expect(validateTransformResult({ values: sparse, checksum: 0 }).ok).toBe(false);
    expect(validateTransformResult({ values: [1], checksum: -1 }).ok).toBe(false);
    expect(validateTransformResult({ values: [1], checksum: 4294967296 }).ok).toBe(false);
    expect(validateTransformResult({ values: [1], checksum: 1.5 }).ok).toBe(false);
    expect(validateTransformResult({ values: [2147483648], checksum: 0 }).ok).toBe(false);
    // codes are TRANSPORT_ERROR
    const bad = validateTransformResult({ values: [1], checksum: -1 });
    if (!bad.ok) expect(bad.error.code).toBe("TRANSPORT_ERROR");
  });

  it("validateTransformRequest: extra invalid shapes", () => {
    expect(validateTransformRequest(null).ok).toBe(false);
    expect(validateTransformRequest([]).ok).toBe(false);
    expect(validateTransformRequest("s").ok).toBe(false);
    expect(validateTransformRequest({ values: [1], multiplier: 1, offset: 1, extra: 1 }).ok).toBe(false);
    // missing fields
    expect(validateTransformRequest({ multiplier: 1, offset: 0 }).ok).toBe(false);
    expect(validateTransformRequest({ values: [1], offset: 0 }).ok).toBe(false);
    // values not array, too long
    expect(validateTransformRequest({ values: 123, multiplier: 1, offset: 0 }).ok).toBe(false);
    const tooLong = validateTransformRequest({ values: new Array(4097).fill(0), multiplier: 1, offset: 0 });
    if (!tooLong.ok) expect(tooLong.error.code).toBe("LIMIT_EXCEEDED");
    // multiplier/offset invalid
    expect(validateTransformRequest({ values: [1], multiplier: 1.5, offset: 0 }).ok).toBe(false);
    expect(validateTransformRequest({ values: [1], multiplier: 1, offset: "x" }).ok).toBe(false);
    expect(validateTransformRequest({ values: [2147483648], multiplier: 1, offset: 0 }).ok).toBe(false);
    // empty ok
    const empty = validateTransformRequest({ values: [], multiplier: 1, offset: 0 });
    expect(empty.ok).toBe(true);
    // max length ok
    const max = validateTransformRequest({ values: new Array(4096).fill(1), multiplier: 1, offset: 0 });
    expect(max.ok).toBe(true);
  });

  it("validateRuntimeInfo: ok tauri/wasm", () => {
    const tauri = validateRuntimeInfo({
      apiVersion: 1,
      backend: "tauri-native",
      hostOs: "macos",
      execution: "native-ffi",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(tauri.ok).toBe(true);

    const wasm = validateRuntimeInfo({
      apiVersion: 1,
      backend: "wasm-worker",
      hostOs: "browser",
      execution: "dedicated-worker",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(wasm.ok).toBe(true);
  });

  it("validateRuntimeInfo: rejects + ABI_MISMATCH", () => {
    expect(validateRuntimeInfo(null).ok).toBe(false);
    expect(validateRuntimeInfo([]).ok).toBe(false);
    expect(validateRuntimeInfo({}).ok).toBe(false);
    // apiVersion
    expect(
      validateRuntimeInfo({
        apiVersion: 2,
        backend: "tauri-native",
        hostOs: "macos",
        execution: "native-ffi",
        core: { abiVersion: 1, version: "0.1.0" },
      }).ok,
    ).toBe(false);
    // backend/host/execution combos
    const badCombo1 = validateRuntimeInfo({
      apiVersion: 1,
      backend: "tauri-native",
      hostOs: "macos",
      execution: "dedicated-worker",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(badCombo1.ok).toBe(false);

    const badCombo2 = validateRuntimeInfo({
      apiVersion: 1,
      backend: "tauri-native",
      hostOs: "browser",
      execution: "native-ffi",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(badCombo2.ok).toBe(false);

    const badCombo3 = validateRuntimeInfo({
      apiVersion: 1,
      backend: "wasm-worker",
      hostOs: "browser",
      execution: "native-ffi",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(badCombo3.ok).toBe(false);

    const badCombo4 = validateRuntimeInfo({
      apiVersion: 1,
      backend: "wasm-worker",
      hostOs: "macos",
      execution: "dedicated-worker",
      core: { abiVersion: 1, version: "0.1.0" },
    });
    expect(badCombo4.ok).toBe(false);

    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "bad",
        hostOs: "macos",
        execution: "native-ffi",
        core: { abiVersion: 1, version: "0.1.0" },
      }).ok,
    ).toBe(false);
    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "tauri-native",
        hostOs: "bad",
        execution: "native-ffi",
        core: { abiVersion: 1, version: "0.1.0" },
      }).ok,
    ).toBe(false);
    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "tauri-native",
        hostOs: "macos",
        execution: "bad",
        core: { abiVersion: 1, version: "0.1.0" },
      }).ok,
    ).toBe(false);

    // core missing/invalid
    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "tauri-native",
        hostOs: "macos",
        execution: "native-ffi",
      }).ok,
    ).toBe(false);
    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "tauri-native",
        hostOs: "macos",
        execution: "native-ffi",
        core: { abiVersion: "1", version: "0.1.0" },
      }).ok,
    ).toBe(false);
    expect(
      validateRuntimeInfo({
        apiVersion: 1,
        backend: "tauri-native",
        hostOs: "macos",
        execution: "native-ffi",
        core: { abiVersion: 1, version: "" },
      }).ok,
    ).toBe(false);

    // ABI mismatch code
    const mismatch = validateRuntimeInfo({
      apiVersion: 1,
      backend: "tauri-native",
      hostOs: "macos",
      execution: "native-ffi",
      core: { abiVersion: 999, version: "9.9.9" },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("ABI_MISMATCH");
  });
});
