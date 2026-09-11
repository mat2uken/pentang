import { describe, expect, it } from "vitest";
import {
  WIRE_FLAG_CONTINUED,
  WIRE_MAX_VALUES,
  WireEncodeError,
  decodeGetInfoResponse,
  decodeHeader,
  decodeTransformRequest,
  decodeTransformResponse,
  encodeGetInfoRequest,
  encodeGetInfoResponse,
  encodeHeader,
  encodeTransformRequest,
  encodeTransformResponse,
  nextFrame,
  readI32LE,
  scanFrames,
  valuesToArray,
  wasmView,
  writeIntoWasm,
} from "../../packages/api/wire";

describe("wire codec (binary frame v1)", () => {
  it("header fixed bytes match C++/Rust (seq=7, payload=12)", () => {
    const out = new Uint8Array(16);
    encodeHeader(out, 0, 2, 0, 7, 12);
    expect([...out]).toEqual([
      0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x07, 0x00,
      0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const d = decodeHeader(out);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.header).toEqual({ command: 2, flags: 0, sequence: 7, payloadLen: 12 });
    }
  });

  it("transform request full 40-byte vector (basic [1,2,3] mult=2 off=1 seq=9)", () => {
    const out = new Uint8Array(64);
    const n = encodeTransformRequest(out, 0, {
      sequence: 9,
      values: [1, 2, 3],
      multiplier: 2,
      offset: 1,
    });
    expect(n).toBe(40);
    expect([...out.subarray(0, n)]).toEqual([
      0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x09, 0x00,
      0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
    ]);
    const d = decodeTransformRequest(out.subarray(0, n));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sequence).toBe(9);
      expect(d.count).toBe(3);
      expect(d.multiplier).toBe(2);
      expect(d.offset).toBe(1);
      expect(valuesToArray(d.valuesBytes, d.count)).toEqual([1, 2, 3]);
    }
  });

  it("transform request empty is 28 bytes", () => {
    const out = new Uint8Array(32);
    const n = encodeTransformRequest(out, 0, { sequence: 1, values: [], multiplier: 1, offset: 0 });
    expect(n).toBe(28);
    const d = decodeTransformRequest(out.subarray(0, n));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.count).toBe(0);
      expect(d.valuesBytes.length).toBe(0);
    }
  });

  it("transform request preserves int32 extremes (identity vector)", () => {
    const values = [0, 1, -1, 2147483647, -2147483648];
    const out = new Uint8Array(64);
    const n = encodeTransformRequest(out, 0, { sequence: 2, values, multiplier: 1, offset: 0 });
    expect(n).toBe(16 + 12 + 20);
    const d = decodeTransformRequest(out.subarray(0, n));
    expect(d.ok).toBe(true);
    if (d.ok) expect(valuesToArray(d.valuesBytes, d.count)).toEqual(values);
  });

  it("transform response round trip ([3,5,7] checksum=15 seq=4)", () => {
    const out = new Uint8Array(64);
    const n = encodeTransformResponse(out, 0, { sequence: 4, values: [3, 5, 7], checksum: 15 });
    expect(n).toBe(36);
    const d = decodeTransformResponse(out.subarray(0, n));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sequence).toBe(4);
      expect(d.count).toBe(3);
      expect(d.checksum).toBe(15);
      expect(valuesToArray(d.valuesBytes, d.count)).toEqual([3, 5, 7]);
    }
  });

  it("getInfo request is 16 bytes; response round trip (0.1.0)", () => {
    const q = new Uint8Array(16);
    expect(encodeGetInfoRequest(q, 0, 3)).toBe(16);
    const r = new Uint8Array(32);
    const n = encodeGetInfoResponse(r, 0, 3, 1, "0.1.0");
    expect(n).toBe(29);
    const d = decodeGetInfoResponse(r.subarray(0, n));
    expect(d).toEqual({ ok: true, sequence: 3, abiVersion: 1, version: "0.1.0" });
  });

  it("rejects bad magic / reserved / truncated / trailing / count mismatch", () => {
    const good = new Uint8Array(64);
    const n = encodeTransformRequest(good, 0, { sequence: 1, values: [1], multiplier: 1, offset: 0 });
    const frame = good.subarray(0, n);

    const badMagic = frame.slice();
    badMagic[0] ^= 0xff;
    expect(decodeTransformRequest(badMagic)).toMatchObject({ ok: false });
    const badMagicHeader = decodeHeader(badMagic);
    expect(badMagicHeader.ok).toBe(false);
    if (!badMagicHeader.ok) expect(badMagicHeader.error.code).toBe("WIRE_MAGIC");

    const badReserved = frame.slice();
    badReserved[12] = 1;
    expect(decodeTransformRequest(badReserved)).toMatchObject({ ok: false });

    expect(decodeTransformRequest(frame.subarray(0, n - 1))).toMatchObject({ ok: false });

    const trailing = new Uint8Array(n + 1);
    trailing.set(frame, 0);
    expect(decodeTransformRequest(trailing)).toMatchObject({ ok: false });

    // count フィールドと payload 長の不整合
    const mismatched = frame.slice();
    mismatched[16] = 2; // count 1 -> 2 相当の下位バイト書き換え
    expect(decodeTransformRequest(mismatched)).toMatchObject({ ok: false });
  });

  it("encode rejects over-limit counts and small buffers", () => {
    const big = new Array(WIRE_MAX_VALUES + 1).fill(1);
    expect(() =>
      encodeTransformRequest(new Uint8Array(16), 0, { sequence: 1, values: big, multiplier: 1, offset: 0 }),
    ).toThrowError(WireEncodeError);
    try {
      encodeTransformRequest(new Uint8Array(16), 0, { sequence: 1, values: big, multiplier: 1, offset: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as WireEncodeError).code).toBe("WIRE_LIMIT");
    }
    expect(() =>
      encodeTransformRequest(new Uint8Array(10), 0, { sequence: 1, values: [1], multiplier: 1, offset: 0 }),
    ).toThrowError(WireEncodeError);
  });

  it("scanFrames consumes a batch; truncated tail reports error with prefix frames", () => {
    const buf = new Uint8Array(128);
    const n1 = encodeTransformRequest(buf, 0, { sequence: 1, values: [1], multiplier: 1, offset: 0 });
    const n2 = encodeTransformRequest(buf, n1, { sequence: 2, values: [2, 3], multiplier: 1, offset: 0 });
    const total = n1 + n2;
    const full = scanFrames(buf.subarray(0, total));
    expect(full.ok).toBe(true);
    const first = nextFrame(buf, 0);
    expect(first.ok).toBe(true);
    if (full.ok) {
      expect(full.frames.length).toBe(2);
      expect(full.frames[0]!.header.sequence).toBe(1);
      expect(full.frames[1]!.header.sequence).toBe(2);
      // payload は入力内ビュー (コピーなし)。先頭フレームの値を直接読める。
      expect(readI32LE(full.frames[0]!.payload, 12)).toBe(1);
    }
    const cut = scanFrames(buf.subarray(0, total - 1));
    expect(cut.ok).toBe(false);
    if (!cut.ok) {
      expect(cut.error.code).toBe("WIRE_SMALL");
      expect(cut.frames.length).toBe(1);
    }
  });

  it("CONTINUED flag round trips; ERROR/COMPRESSED rejected on requests", () => {
    const out = new Uint8Array(64);
    const n = encodeTransformRequest(out, 0, {
      sequence: 5,
      flags: WIRE_FLAG_CONTINUED,
      values: [9],
      multiplier: 1,
      offset: 0,
    });
    const d = decodeTransformRequest(out.subarray(0, n));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.flags).toBe(WIRE_FLAG_CONTINUED);
    expect(() =>
      encodeTransformRequest(new Uint8Array(64), 0, { sequence: 1, flags: 0x0001, values: [1], multiplier: 1, offset: 0 }),
    ).toThrowError(WireEncodeError);
  });

  it("wasm zero-copy helpers: view shares memory, write does a single bulk set", () => {
    const memory = { buffer: new ArrayBuffer(64) };
    const heap = new Uint8Array(memory.buffer);
    const src = new Uint8Array([0x42, 0x57, 0x02, 0x00]);
    writeIntoWasm(heap, 8, src);
    const view = wasmView(memory, 8, 4);
    expect([...view]).toEqual([0x42, 0x57, 0x02, 0x00]);
    // ビュー経由の書込は同一メモリに反映される (コピーなしの証拠)。
    view[0] = 0xff;
    expect(new Uint8Array(memory.buffer)[8]).toBe(0xff);
    expect(() => wasmView(memory, 63, 2)).toThrowError(WireEncodeError);
  });

  it("wasm helpers reject invalid ranges", () => {
    const memory = { buffer: new ArrayBuffer(64) };
    const heap = new Uint8Array(memory.buffer);
    expect(() => wasmView(memory, -1, 4)).toThrowError(WireEncodeError);
    expect(() => wasmView(memory, 0, -1)).toThrowError(WireEncodeError);
    expect(() => wasmView(memory, 60, 8)).toThrowError(WireEncodeError);
    expect(() => writeIntoWasm(heap, -1, new Uint8Array([1]))).toThrowError(WireEncodeError);
    expect(() => writeIntoWasm(heap, 64, new Uint8Array([1]))).toThrowError(WireEncodeError);
    expect(() => valuesToArray(new Uint8Array(3), 1)).toThrowError(WireEncodeError);
    expect(valuesToArray(new Uint8Array(0), 0)).toEqual([]);
  });
});
