// 手書きの小さなWASM型。生成物なしの型検査を可能にする。
export interface CoreModule {
  _core_abi_version(): number;
  _core_version(): number;
  _core_transform_i32(
    input: number,
    count: number,
    multiplier: number,
    offset: number,
    output: number,
    outputCapacity: number,
    checksum: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number): string;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
}

export function isCoreModule(m: unknown): m is CoreModule {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o["_core_abi_version"] === "function" &&
    typeof o["_core_version"] === "function" &&
    typeof o["_core_transform_i32"] === "function" &&
    typeof o["_malloc"] === "function" &&
    typeof o["_free"] === "function" &&
    typeof o["UTF8ToString"] === "function" &&
    o["HEAP32"] instanceof Int32Array &&
    o["HEAPU32"] instanceof Uint32Array
  );
}
