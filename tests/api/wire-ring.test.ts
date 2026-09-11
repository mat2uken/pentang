import { describe, expect, it } from "vitest";
import { FrameBatcher, WireRing } from "../../packages/api/wire-ring";
import {
  decodeTransformRequest,
  encodeTransformRequest,
  scanFrames,
  valuesToArray,
} from "../../packages/api/wire";

function encTransform(seq: number, values: number[]): Uint8Array {
  const out = new Uint8Array(16 + 12 + values.length * 4);
  const n = encodeTransformRequest(out, 0, { sequence: seq, values, multiplier: 1, offset: 0 });
  return out.subarray(0, n);
}

describe("WireRing (shared circular buffer)", () => {
  it("create: empty ring reports used=0, free=cap-1", () => {
    const ring = WireRing.create(64);
    expect(ring.capacity).toBe(64);
    expect(ring.used()).toBe(0);
    expect(ring.free()).toBe(63);
    expect(ring.readableSpans()).toEqual([]);
  });

  it("write/read/consume round trip preserves byte order", () => {
    const ring = WireRing.create(64);
    expect(ring.write(new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(ring.used()).toBe(4);
    const spans = ring.readableSpans();
    expect(spans.length).toBe(1);
    expect([...spans[0]!]).toEqual([1, 2, 3, 4]);
    expect(ring.consume(2)).toBe(true);
    expect(ring.used()).toBe(2);
    expect([...ring.readableSpans()[0]!]).toEqual([3, 4]);
    expect(ring.consume(2)).toBe(true);
    expect(ring.used()).toBe(0);
  });

  it("write fails without partial write when full; over-consume fails", () => {
    const ring = WireRing.create(8); // free = 7
    expect(ring.write(new Uint8Array(7))).toBe(true);
    expect(ring.write(new Uint8Array([9]))).toBe(false);
    expect(ring.used()).toBe(7);
    expect(ring.consume(8)).toBe(false);
    expect(ring.used()).toBe(7);
  });

  it("wraparound keeps FIFO order across the end of the buffer", () => {
    const ring = WireRing.create(10);
    expect(ring.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(ring.consume(6)).toBe(true); // tail=6, head=8
    // 6バイト書くと head が (8+6)%10=4 に回り込む。free=9-…: used=2 なので 6 書けるか
    expect(ring.write(new Uint8Array([9, 10, 11, 12, 13, 14]))).toBe(true);
    expect(ring.used()).toBe(8);
    const spans = ring.readableSpans();
    expect(spans.length).toBe(2);
    const drained = ring.drainCompacted();
    expect([...drained]).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    expect(ring.used()).toBe(0);
  });

  it("end-to-end: frames -> ring -> single drain -> scanFrames -> decode", () => {
    const ring = WireRing.create(1024);
    const f1 = encTransform(1, [1, 2, 3]);
    const f2 = encTransform(2, []);
    const f3 = encTransform(3, [-5, 2147483647]);
    expect(ring.writeFrame(f1)).toBe(true);
    expect(ring.writeFrame(f2)).toBe(true);
    expect(ring.writeFrame(f3)).toBe(true);
    // ネイティブブリッジ呼び出しはこの1回にまとまる。
    const batch = ring.drainCompacted();
    expect(batch.length).toBe(f1.length + f2.length + f3.length);
    const scanned = scanFrames(batch);
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.frames.length).toBe(3);
      const d1 = decodeTransformRequest(batch.subarray(0, f1.length));
      expect(d1.ok).toBe(true);
      if (d1.ok) expect(valuesToArray(d1.valuesBytes, d1.count)).toEqual([1, 2, 3]);
    }
  });

  it("attach/reopen shares layout for WASM-memory slices", () => {
    const backing = new Uint8Array(12 + 32);
    const ring = WireRing.attach(backing, 32);
    expect(ring.write(new Uint8Array([7, 7]))).toBe(true);
    // 同一メモリの別ビューから reopen すると head/tail を引き継ぐ。
    const same = new Uint8Array(backing.buffer, backing.byteOffset, backing.length);
    const reopened = WireRing.reopen(same);
    expect(reopened.used()).toBe(2);
    expect([...reopened.drainCompacted()]).toEqual([7, 7]);
    expect(() => WireRing.reopen(new Uint8Array(4))).toThrowError(RangeError);
  });

  it("create/attach reject invalid capacities and regions", () => {
    expect(() => WireRing.create(0)).toThrowError(RangeError);
    expect(() => WireRing.create(-4)).toThrowError(RangeError);
    expect(() => WireRing.create(1.5)).toThrowError(RangeError);
    expect(() => WireRing.attach(new Uint8Array(12 + 8), 0)).toThrowError(RangeError);
    expect(() => WireRing.attach(new Uint8Array(12 + 8), 32)).toThrowError(RangeError);
    // 不正ヘッダのreopenを拒否する。
    const badCap = new Uint8Array(16);
    expect(() => WireRing.reopen(badCap)).toThrowError(RangeError);
  });
});

describe("FrameBatcher (heap-side batching)", () => {
  it("push under threshold returns null; flush delivers one batch", () => {
    const b = new FrameBatcher({ maxBytes: 1024, maxFrames: 8 });
    expect(b.push(encTransform(1, [1]))).toBeNull();
    expect(b.push(encTransform(2, [2]))).toBeNull();
    expect(b.pendingFrames).toBe(2);
    const out = b.flush();
    expect(out).not.toBeNull();
    const scanned = scanFrames(out!);
    expect(scanned.ok).toBe(true);
    if (scanned.ok) expect(scanned.frames.length).toBe(2);
    expect(b.flush()).toBeNull();
  });

  it("push auto-flushes when maxFrames is reached", () => {
    const b = new FrameBatcher({ maxBytes: 1 << 20, maxFrames: 3 });
    expect(b.push(encTransform(1, [1]))).toBeNull();
    expect(b.push(encTransform(2, [2]))).toBeNull();
    const flushed = b.push(encTransform(3, [3]));
    expect(flushed).not.toBeNull();
    expect(scanFrames(flushed!).ok).toBe(true);
    expect(b.pendingFrames).toBe(0);
  });

  it("push copies the frame (later mutation does not leak into the batch)", () => {
    const b = new FrameBatcher();
    const f = encTransform(9, [5]);
    b.push(f);
    f.fill(0);
    const out = b.flush()!;
    const d = decodeTransformRequest(out);
    expect(d.ok).toBe(true);
    if (d.ok) expect(valuesToArray(d.valuesBytes, d.count)).toEqual([5]);
  });

  it("rejects invalid options and reports pending state", () => {
    expect(() => new FrameBatcher({ maxBytes: 0 })).toThrowError(RangeError);
    expect(() => new FrameBatcher({ maxBytes: -1 })).toThrowError(RangeError);
    expect(() => new FrameBatcher({ maxFrames: 0 })).toThrowError(RangeError);
    expect(() => new FrameBatcher({ maxFrames: 2.5 })).toThrowError(RangeError);
    const b = new FrameBatcher({ maxBytes: 1 << 20, maxFrames: 8 });
    expect(b.pendingBytes).toBe(0);
    expect(b.pendingFrames).toBe(0);
    const f = encTransform(1, [1, 2]);
    b.push(f);
    expect(b.pendingFrames).toBe(1);
    expect(b.pendingBytes).toBe(f.length);
  });
});
