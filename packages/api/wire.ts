/** 共通バイナリ電文プロトコル (Wire Format v1) の TypeScript 実装。
 *
 * `packages/core/include/poc_wire.h` および `packages/ffi/src/wire.rs` と
 * バイト単位で一致させる。DOM / Tauri / Worker 型に依存しないため、
 * main・Worker・Node 試験のいずれからも import できる。
 *
 * 役割分担 (制御プレーン / データプレーン分離):
 * - 本モジュールはデータプレーンのフレーム化だけを担う。RPC の method
 *   対応付け・寿命・タイマーは既存の worker-protocol / RequestState が担い、
 *   本モジュールはその内側の values 配列を JSON number[] ではなく LE バイト列
 *   として運ぶために使う。
 * - encode は検証済み入力だけを受け (不正は throw)、decode は非信頼バイト列を
 *   受けて検証結果の union を返す。decode の payload は入力内の subarray
 *   ビューで返し、コピーしない (最小コピーの原則)。
 */

export const WIRE_SIZE = 16 as const;
export const WIRE_MAGIC = 0x5742 as const;
export const WIRE_VERSION = 1 as const;

export const WIRE_CMD_GET_INFO = 1 as const;
export const WIRE_CMD_TRANSFORM = 2 as const;
export type WireCommand = typeof WIRE_CMD_GET_INFO | typeof WIRE_CMD_TRANSFORM;

export const WIRE_FLAG_ERROR = 0x0001 as const;
export const WIRE_FLAG_CONTINUED = 0x0002 as const;
export const WIRE_FLAG_COMPRESSED = 0x0004 as const;

export const WIRE_MAX_VALUES = 4096 as const;
export const WIRE_MAX_VERSION_LEN = 64 as const;
export const WIRE_MAX_PAYLOAD = 16777216 as const;

export type WireDecodeErrorCode = "WIRE_INVALID" | "WIRE_LIMIT" | "WIRE_SMALL" | "WIRE_MAGIC";

export interface WireError {
  readonly code: WireDecodeErrorCode;
  readonly message: string;
}

export interface WireHeader {
  readonly command: WireCommand;
  readonly flags: number;
  readonly sequence: number;
  readonly payloadLen: number;
}

function wireError(code: WireDecodeErrorCode, message: string): WireError {
  return { code, message };
}

/** encode 失敗時に投げる。呼び出し側のバグ (検証漏れ・容量不足) を表す。 */
export class WireEncodeError extends Error {
  readonly code: WireDecodeErrorCode;
  constructor(code: WireDecodeErrorCode, message: string) {
    super(message);
    this.name = "WireEncodeError";
    this.code = code;
  }
}

export function writeU16LE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = v & 0xff;
  out[offset + 1] = (v >>> 8) & 0xff;
}

export function writeU32LE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = v & 0xff;
  out[offset + 1] = (v >>> 8) & 0xff;
  out[offset + 2] = (v >>> 16) & 0xff;
  out[offset + 3] = (v >>> 24) & 0xff;
}

export function writeI32LE(out: Uint8Array, offset: number, v: number): void {
  writeU32LE(out, offset, v | 0);
}

export function readU16LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8)) >>> 0;
}

export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] * 0x1000000)
  ) >>> 0;
}

export function readI32LE(buf: Uint8Array, offset: number): number {
  return readU32LE(buf, offset) | 0;
}

function isWireCommand(v: number): v is WireCommand {
  return v === WIRE_CMD_GET_INFO || v === WIRE_CMD_TRANSFORM;
}

const VALID_FLAGS_MASK = WIRE_FLAG_ERROR | WIRE_FLAG_CONTINUED | WIRE_FLAG_COMPRESSED;

export function transformRequestPayloadSize(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new WireEncodeError("WIRE_INVALID", `count must be a uint32, got ${String(count)}`);
  }
  if (count > WIRE_MAX_VALUES) {
    throw new WireEncodeError("WIRE_LIMIT", `count ${count} exceeds ${WIRE_MAX_VALUES}`);
  }
  return 12 + count * 4;
}

export function transformResponsePayloadSize(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new WireEncodeError("WIRE_INVALID", `count must be a uint32, got ${String(count)}`);
  }
  if (count > WIRE_MAX_VALUES) {
    throw new WireEncodeError("WIRE_LIMIT", `count ${count} exceeds ${WIRE_MAX_VALUES}`);
  }
  return 8 + count * 4;
}

function checkFrameCapacity(out: Uint8Array, offset: number, frameLen: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + frameLen > out.length) {
    throw new WireEncodeError("WIRE_SMALL", `output needs ${frameLen} bytes at ${offset}`);
  }
}

/** 16バイトヘッダーを out[offset..offset+16] へ書く。 */
export function encodeHeader(
  out: Uint8Array,
  offset: number,
  command: number,
  flags: number,
  sequence: number,
  payloadLen: number,
): void {
  if (!isWireCommand(command)) {
    throw new WireEncodeError("WIRE_INVALID", `unknown command ${String(command)}`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff || (flags & ~VALID_FLAGS_MASK) !== 0) {
    throw new WireEncodeError("WIRE_INVALID", `bad flags ${String(flags)}`);
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new WireEncodeError("WIRE_INVALID", `sequence must be uint16, got ${String(sequence)}`);
  }
  if (!Number.isInteger(payloadLen) || payloadLen < 0 || payloadLen > WIRE_MAX_PAYLOAD) {
    throw new WireEncodeError(
      payloadLen > WIRE_MAX_PAYLOAD ? "WIRE_LIMIT" : "WIRE_INVALID",
      `bad payloadLen ${String(payloadLen)}`,
    );
  }
  checkFrameCapacity(out, offset, WIRE_SIZE);
  writeU16LE(out, offset + 0, WIRE_MAGIC);
  writeU16LE(out, offset + 2, command);
  writeU16LE(out, offset + 4, flags);
  writeU16LE(out, offset + 6, sequence);
  writeU32LE(out, offset + 8, payloadLen);
  writeU32LE(out, offset + 12, 0);
}

export type DecodeHeaderResult =
  | { readonly ok: true; readonly header: WireHeader }
  | { readonly ok: false; readonly error: WireError };

export function decodeHeader(
  buf: Uint8Array,
  offset = 0,
): DecodeHeaderResult {
  if (offset < 0 || buf.length < offset + WIRE_SIZE) {
    return { ok: false, error: wireError("WIRE_SMALL", "header needs 16 bytes") };
  }
  if (readU16LE(buf, offset + 0) !== WIRE_MAGIC) {
    return { ok: false, error: wireError("WIRE_MAGIC", "bad magic") };
  }
  const command = readU16LE(buf, offset + 2);
  if (!isWireCommand(command)) {
    return { ok: false, error: wireError("WIRE_INVALID", `unknown command ${command}`) };
  }
  const flags = readU16LE(buf, offset + 4);
  if ((flags & ~VALID_FLAGS_MASK) !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", `bad flags ${flags}`) };
  }
  const sequence = readU16LE(buf, offset + 6);
  const payloadLen = readU32LE(buf, offset + 8);
  if (payloadLen > WIRE_MAX_PAYLOAD) {
    return { ok: false, error: wireError("WIRE_LIMIT", `payloadLen ${payloadLen} too large`) };
  }
  if (readU32LE(buf, offset + 12) !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "reserved must be 0") };
  }
  return { ok: true, header: { command, flags, sequence, payloadLen } };
}

export type NextFrameResult =
  | { readonly ok: true; readonly header: WireHeader; readonly payload: Uint8Array; readonly frameLen: number }
  | { readonly ok: false; readonly error: WireError };

/** バッチ受信の1フレーム走査。payload は入力内の subarray ビュー (ゼロコピー)。 */
export function nextFrame(buf: Uint8Array, offset = 0): NextFrameResult {
  const h = decodeHeader(buf, offset);
  if (!h.ok) return h;
  const frameLen = WIRE_SIZE + h.header.payloadLen;
  if (buf.length < offset + frameLen) {
    return { ok: false, error: wireError("WIRE_SMALL", "frame payload truncated") };
  }
  return {
    ok: true,
    header: h.header,
    payload: buf.subarray(offset + WIRE_SIZE, offset + frameLen),
    frameLen,
  };
}

export interface ScannedFrame {
  readonly header: WireHeader;
  /** 入力バッファ内のビュー。呼び出し側で保持する場合は slice() で複写する。 */
  readonly payload: Uint8Array;
  readonly offset: number;
  readonly frameLen: number;
}

export type ScanFramesResult =
  | { readonly ok: true; readonly frames: ScannedFrame[] }
  | { readonly ok: false; readonly error: WireError; readonly frames: ScannedFrame[] };

/** 連結バッファを先頭から走査し、全フレームを一括消費する (ネイティブ側 unpack に対応)。 */
export function scanFrames(buf: Uint8Array): ScanFramesResult {
  const frames: ScannedFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const r = nextFrame(buf, offset);
    if (!r.ok) return { ok: false, error: r.error, frames };
    frames.push({ header: r.header, payload: r.payload, offset, frameLen: r.frameLen });
    offset += r.frameLen;
  }
  return { ok: true, frames };
}

export interface TransformRequestFields {
  readonly sequence: number;
  /** CONTINUED 以外の送信時 flags は 0。受信時は検証済みの値をそのまま使う。 */
  readonly flags?: number;
  readonly values: readonly number[];
  readonly multiplier: number;
  readonly offset: number;
}

/** transform 要求フレームを out[offset..] へ書く。戻り値はフレーム長。 */
export function encodeTransformRequest(
  out: Uint8Array,
  offset: number,
  req: TransformRequestFields,
): number {
  const flags = req.flags ?? 0;
  if ((flags & WIRE_FLAG_ERROR) !== 0 || (flags & WIRE_FLAG_COMPRESSED) !== 0) {
    throw new WireEncodeError("WIRE_INVALID", "request must not set ERROR/COMPRESSED");
  }
  if ((flags & ~WIRE_FLAG_CONTINUED) !== 0) {
    throw new WireEncodeError("WIRE_INVALID", `bad request flags ${flags}`);
  }
  const count = req.values.length;
  const payloadLen = transformRequestPayloadSize(count);
  const frameLen = WIRE_SIZE + payloadLen;
  checkFrameCapacity(out, offset, frameLen);
  encodeHeader(out, offset, WIRE_CMD_TRANSFORM, flags, req.sequence, payloadLen);
  const p = offset + WIRE_SIZE;
  writeU32LE(out, p + 0, count);
  writeI32LE(out, p + 4, req.multiplier);
  writeI32LE(out, p + 8, req.offset);
  for (let i = 0; i < count; i++) {
    writeI32LE(out, p + 12 + i * 4, req.values[i]!);
  }
  return frameLen;
}

export type DecodeTransformRequestResult =
  | {
      readonly ok: true;
      readonly sequence: number;
      readonly flags: number;
      readonly count: number;
      readonly multiplier: number;
      readonly offset: number;
      /** 入力フレーム内の LE バイト列ビュー。readI32LE で読む。 */
      readonly valuesBytes: Uint8Array;
    }
  | { readonly ok: false; readonly error: WireError };

export function decodeTransformRequest(frame: Uint8Array): DecodeTransformRequestResult {
  const r = nextFrame(frame, 0);
  if (!r.ok) return r;
  if (r.frameLen !== frame.length) {
    return { ok: false, error: wireError("WIRE_INVALID", "trailing bytes after frame") };
  }
  if (r.header.command !== WIRE_CMD_TRANSFORM) {
    return { ok: false, error: wireError("WIRE_INVALID", "not a transform frame") };
  }
  if ((r.header.flags & WIRE_FLAG_ERROR) !== 0 || (r.header.flags & WIRE_FLAG_COMPRESSED) !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "bad request flags") };
  }
  const payload = r.payload;
  if (payload.length < 12 || (payload.length - 12) % 4 !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "bad transform payload shape") };
  }
  const count = readU32LE(payload, 0);
  if (count > WIRE_MAX_VALUES) {
    return { ok: false, error: wireError("WIRE_LIMIT", `count ${count} exceeds limit`) };
  }
  if (payload.length !== 12 + count * 4) {
    return { ok: false, error: wireError("WIRE_INVALID", "count/payload length mismatch") };
  }
  return {
    ok: true,
    sequence: r.header.sequence,
    flags: r.header.flags,
    count,
    multiplier: readI32LE(payload, 4),
    offset: readI32LE(payload, 8),
    valuesBytes: payload.subarray(12),
  };
}

export interface TransformResponseFields {
  readonly sequence: number;
  readonly flags?: number;
  readonly values: readonly number[];
  readonly checksum: number;
}

/** transform 応答フレームを out[offset..] へ書く。戻り値はフレーム長。 */
export function encodeTransformResponse(
  out: Uint8Array,
  offset: number,
  res: TransformResponseFields,
): number {
  const flags = res.flags ?? 0;
  if ((flags & WIRE_FLAG_COMPRESSED) !== 0) {
    throw new WireEncodeError("WIRE_INVALID", "response must not set COMPRESSED");
  }
  if ((flags & ~(WIRE_FLAG_ERROR | WIRE_FLAG_CONTINUED)) !== 0) {
    throw new WireEncodeError("WIRE_INVALID", `bad response flags ${flags}`);
  }
  if (!Number.isInteger(res.checksum) || res.checksum < 0 || res.checksum > 0xffffffff) {
    throw new WireEncodeError("WIRE_INVALID", "checksum must be uint32");
  }
  const count = res.values.length;
  const payloadLen = transformResponsePayloadSize(count);
  const frameLen = WIRE_SIZE + payloadLen;
  checkFrameCapacity(out, offset, frameLen);
  encodeHeader(out, offset, WIRE_CMD_TRANSFORM, flags, res.sequence, payloadLen);
  const p = offset + WIRE_SIZE;
  writeU32LE(out, p + 0, count);
  writeU32LE(out, p + 4, res.checksum);
  for (let i = 0; i < count; i++) {
    writeI32LE(out, p + 8 + i * 4, res.values[i]!);
  }
  return frameLen;
}

export type DecodeTransformResponseResult =
  | {
      readonly ok: true;
      readonly sequence: number;
      readonly flags: number;
      readonly count: number;
      readonly checksum: number;
      /** 入力フレーム内の LE バイト列ビュー。readI32LE で読む。 */
      readonly valuesBytes: Uint8Array;
    }
  | { readonly ok: false; readonly error: WireError };

export function decodeTransformResponse(frame: Uint8Array): DecodeTransformResponseResult {
  const r = nextFrame(frame, 0);
  if (!r.ok) return r;
  if (r.frameLen !== frame.length) {
    return { ok: false, error: wireError("WIRE_INVALID", "trailing bytes after frame") };
  }
  if (r.header.command !== WIRE_CMD_TRANSFORM) {
    return { ok: false, error: wireError("WIRE_INVALID", "not a transform frame") };
  }
  if ((r.header.flags & WIRE_FLAG_COMPRESSED) !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "bad response flags") };
  }
  const payload = r.payload;
  if (payload.length < 8 || (payload.length - 8) % 4 !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "bad transform payload shape") };
  }
  const count = readU32LE(payload, 0);
  if (count > WIRE_MAX_VALUES) {
    return { ok: false, error: wireError("WIRE_LIMIT", `count ${count} exceeds limit`) };
  }
  if (payload.length !== 8 + count * 4) {
    return { ok: false, error: wireError("WIRE_INVALID", "count/payload length mismatch") };
  }
  return {
    ok: true,
    sequence: r.header.sequence,
    flags: r.header.flags,
    count,
    checksum: readU32LE(payload, 4),
    valuesBytes: payload.subarray(8),
  };
}

/** getInfo 要求フレーム (16バイト) を書く。戻り値は常に 16。 */
export function encodeGetInfoRequest(out: Uint8Array, offset: number, sequence: number): number {
  checkFrameCapacity(out, offset, WIRE_SIZE);
  encodeHeader(out, offset, WIRE_CMD_GET_INFO, 0, sequence, 0);
  return WIRE_SIZE;
}

export function encodeGetInfoResponse(
  out: Uint8Array,
  offset: number,
  sequence: number,
  abiVersion: number,
  version: string,
): number {
  const bytes = new TextEncoder().encode(version);
  if (bytes.length === 0 || bytes.length > WIRE_MAX_VERSION_LEN) {
    throw new WireEncodeError("WIRE_INVALID", `version length ${bytes.length} out of range`);
  }
  if (bytes.includes(0)) {
    throw new WireEncodeError("WIRE_INVALID", "version must not contain NUL");
  }
  if (!Number.isInteger(abiVersion) || abiVersion < 0 || abiVersion > 0xffffffff) {
    throw new WireEncodeError("WIRE_INVALID", "abiVersion must be uint32");
  }
  const payloadLen = 8 + bytes.length;
  const frameLen = WIRE_SIZE + payloadLen;
  checkFrameCapacity(out, offset, frameLen);
  encodeHeader(out, offset, WIRE_CMD_GET_INFO, 0, sequence, payloadLen);
  const p = offset + WIRE_SIZE;
  writeU32LE(out, p + 0, abiVersion);
  writeU32LE(out, p + 4, bytes.length);
  out.set(bytes, p + 8);
  return frameLen;
}

export type DecodeGetInfoResponseResult =
  | { readonly ok: true; readonly sequence: number; readonly abiVersion: number; readonly version: string }
  | { readonly ok: false; readonly error: WireError };

export function decodeGetInfoResponse(frame: Uint8Array): DecodeGetInfoResponseResult {
  const r = nextFrame(frame, 0);
  if (!r.ok) return r;
  if (r.frameLen !== frame.length) {
    return { ok: false, error: wireError("WIRE_INVALID", "trailing bytes after frame") };
  }
  if (r.header.command !== WIRE_CMD_GET_INFO) {
    return { ok: false, error: wireError("WIRE_INVALID", "not a getInfo frame") };
  }
  if ((r.header.flags & WIRE_FLAG_ERROR) !== 0) {
    return { ok: false, error: wireError("WIRE_INVALID", "error flag on getInfo response") };
  }
  const payload = r.payload;
  if (payload.length < 8) {
    return { ok: false, error: wireError("WIRE_INVALID", "bad getInfo payload shape") };
  }
  const abiVersion = readU32LE(payload, 0);
  const vlen = readU32LE(payload, 4);
  if (vlen === 0 || vlen > WIRE_MAX_VERSION_LEN || payload.length !== 8 + vlen) {
    return { ok: false, error: wireError("WIRE_INVALID", "version length mismatch") };
  }
  const vbytes = payload.subarray(8);
  if (vbytes.includes(0)) {
    return { ok: false, error: wireError("WIRE_INVALID", "version must not contain NUL") };
  }
  let version: string;
  try {
    version = new TextDecoder("utf-8", { fatal: true }).decode(vbytes);
  } catch {
    return { ok: false, error: wireError("WIRE_INVALID", "version is not valid UTF-8") };
  }
  return { ok: true, sequence: r.header.sequence, abiVersion, version };
}

// ---- WASM ⇄ JS ゼロコピーヘルパー (最小コピーの原則) ----

/** WASM 線形メモリの [ptr, ptr+len) へのビュー生成。コピーしない。
 * memory growth で buffer が差し替わるため、呼び出しごとに取得する。 */
export function wasmView(
  memory: { readonly buffer: ArrayBufferLike },
  ptr: number,
  len: number,
): Uint8Array {
  if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0) {
    throw new WireEncodeError("WIRE_INVALID", `bad wasm range ptr=${String(ptr)} len=${String(len)}`);
  }
  if (ptr + len > memory.buffer.byteLength) {
    throw new WireEncodeError("WIRE_SMALL", "wasm range out of bounds");
  }
  return new Uint8Array(memory.buffer, ptr, len);
}

/** 受信バイト列を WASM 受信領域へ1回だけ転送 (ダイレクト書込)。
 * heapU8 は確保直後に取得した最新のビューを使う。 */
export function writeIntoWasm(heapU8: Uint8Array, writePtr: number, src: Uint8Array): void {
  if (!Number.isInteger(writePtr) || writePtr < 0 || writePtr + src.length > heapU8.length) {
    throw new WireEncodeError("WIRE_SMALL", "wasm write out of bounds");
  }
  heapU8.set(src, writePtr);
}

/** LE バイト列ビューから int32 配列を実体化する (検証・応答返却用に1回だけ複写)。 */
export function valuesToArray(valuesBytes: Uint8Array, count: number): number[] {
  if (valuesBytes.length !== count * 4) {
    throw new WireEncodeError("WIRE_INVALID", "values byte length mismatch");
  }
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = readI32LE(valuesBytes, i * 4);
  }
  return out;
}
