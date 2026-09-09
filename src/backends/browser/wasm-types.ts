// 手書きの小さなWASM型。生成物なしの型検査を可能にする。
export interface PocCoreModule {
  _poc_core_abi_version(): number;
  _poc_core_version(): number;
  _poc_transform_i32(
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

export type PocCoreFactory = (
  opts?: { locateFile?: (path: string) => string },
) => Promise<PocCoreModule>;

export function isPocCoreModule(m: unknown): m is PocCoreModule {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o["_poc_core_abi_version"] === "function" &&
    typeof o["_poc_core_version"] === "function" &&
    typeof o["_poc_transform_i32"] === "function" &&
    typeof o["_malloc"] === "function" &&
    typeof o["_free"] === "function" &&
    typeof o["UTF8ToString"] === "function" &&
    o["HEAP32"] instanceof Int32Array &&
    o["HEAPU32"] instanceof Uint32Array
  );
}
