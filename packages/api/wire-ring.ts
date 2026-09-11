/** 共有リングバッファ + フレームバッチャー (データプレーンのバッチ転送用)。
 *
 * 背景: センサー・音声・描画コマンド等の高頻度転送で IPC を毎回呼ぶと
 * ブリッジ呼び出しオーバーヘッド (コンテキストスイッチ) で処理落ちする。
 * 送信側はフレームを溜め、閾値または周期タイミングで1回のブリッジ呼び出しに
 * まとめる。受信側は `scanFrames` / `poc_wire_next_frame` ループで一括消費する。
 *
 * - `WireRing`: WASM 線形メモリ上にも置ける Head/Tail/Capacity + データ領域。
 *   `packages/core/include/poc_wire.h` の POC_RING_* と同一レイアウト。
 *   WASM メモリの slice に attach すれば、JS 側から直接 head/tail を進められる。
 * - `FrameBatcher`: 通常ヒープ上の簡易版。完全なエンコード済みフレームを
 *   `push` で溜め、閾値到達または `flush()` で1本の連結バッファとして取り出す。
 *   周期フラッシュ (rAF / 1ms〜16ms タイマー) は呼び出し側が `flush()` を呼ぶ。
 *
 * DOM / Tauri / Worker 型に依存しない。
 */

export const RING_META_SIZE = 12 as const;
export const RING_OFF_HEAD = 0 as const;
export const RING_OFF_TAIL = 4 as const;
export const RING_OFF_CAPACITY = 8 as const;

function ringUsed(head: number, tail: number, capacity: number): number {
  if (capacity === 0) return 0;
  return head >= tail ? head - tail : capacity - (tail - head);
}

function ringFree(head: number, tail: number, capacity: number): number {
  if (capacity === 0) return 0;
  return capacity - 1 - ringUsed(head, tail, capacity);
}

function readU32(view: Uint8Array, offset: number): number {
  return (
    view[offset]! |
    (view[offset + 1]! << 8) |
    (view[offset + 2]! << 16) |
    (view[offset + 3]! * 0x1000000)
  ) >>> 0;
}

function writeU32(view: Uint8Array, offset: number, v: number): void {
  view[offset] = v & 0xff;
  view[offset + 1] = (v >>> 8) & 0xff;
  view[offset + 2] = (v >>> 16) & 0xff;
  view[offset + 3] = (v >>> 24) & 0xff;
}

export class WireRing {
  private readonly region: Uint8Array;
  private readonly data: Uint8Array;
  readonly capacity: number;

  private constructor(region: Uint8Array, capacity: number) {
    this.region = region;
    this.data = region.subarray(RING_META_SIZE);
    this.capacity = capacity;
  }

  /** 新規リングを通常ヒープに確保する。capacity はデータ領域の byte 数。 */
  static create(capacityBytes: number): WireRing {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError(`ring capacity must be a positive integer, got ${String(capacityBytes)}`);
    }
    const region = new Uint8Array(RING_META_SIZE + capacityBytes);
    writeU32(region, RING_OFF_HEAD, 0);
    writeU32(region, RING_OFF_TAIL, 0);
    writeU32(region, RING_OFF_CAPACITY, capacityBytes);
    return new WireRing(region, capacityBytes);
  }

  /** 既存メモリ (WASM メモリの slice 等) をリングとして初期化する。 */
  static attach(region: Uint8Array, capacityBytes: number): WireRing {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError(`ring capacity must be a positive integer, got ${String(capacityBytes)}`);
    }
    if (region.length < RING_META_SIZE + capacityBytes) {
      throw new RangeError("ring region too small for capacity");
    }
    const view = region.subarray(0, RING_META_SIZE + capacityBytes);
    writeU32(view, RING_OFF_HEAD, 0);
    writeU32(view, RING_OFF_TAIL, 0);
    writeU32(view, RING_OFF_CAPACITY, capacityBytes);
    return new WireRing(view, capacityBytes);
  }

  /** memory growth 等で buffer が差し替わった後の再オープン。既存 head/tail を引継ぐ。 */
  static reopen(region: Uint8Array): WireRing {
    if (region.length < RING_META_SIZE + 1) {
      throw new RangeError("ring region too small");
    }
    const head = readU32(region, RING_OFF_HEAD);
    const tail = readU32(region, RING_OFF_TAIL);
    const capacity = readU32(region, RING_OFF_CAPACITY);
    if (capacity < 1 || region.length < RING_META_SIZE + capacity) {
      throw new RangeError("ring header capacity mismatch");
    }
    if (head >= capacity || tail >= capacity) {
      throw new RangeError("ring head/tail out of range");
    }
    return new WireRing(region.subarray(0, RING_META_SIZE + capacity), capacity);
  }

  /** 生領域 (transferable 送信用にメタ込みで渡す場合)。 */
  get raw(): Uint8Array {
    return this.region;
  }

  get head(): number {
    return readU32(this.region, RING_OFF_HEAD);
  }

  get tail(): number {
    return readU32(this.region, RING_OFF_TAIL);
  }

  used(): number {
    return ringUsed(this.head, this.tail, this.capacity);
  }

  free(): number {
    return ringFree(this.head, this.tail, this.capacity);
  }

  /** 完全なエンコード済みフレームを1件書く。空き不足なら何も書かず false。 */
  writeFrame(frame: Uint8Array): boolean {
    return this.write(frame);
  }

  write(bytes: Uint8Array): boolean {
    const head = this.head;
    const tail = this.tail;
    if (bytes.length > ringFree(head, tail, this.capacity)) return false;
    // ラップライトは最大2回の set (リング末尾→先頭)。部分書込なし。
    const first = Math.min(bytes.length, this.capacity - head);
    this.data.set(bytes.subarray(0, first), head);
    if (first < bytes.length) {
      this.data.set(bytes.subarray(first), 0);
    }
    writeU32(this.region, RING_OFF_HEAD, (head + bytes.length) % this.capacity);
    return true;
  }

  /** 未読領域を最大2つの subarray ビューで返す (コピーなし・ラップ対応)。 */
  readableSpans(): Uint8Array[] {
    const head = this.head;
    const tail = this.tail;
    const used = ringUsed(head, tail, this.capacity);
    if (used === 0) return [];
    if (head > tail) return [this.data.subarray(tail, head)];
    return [this.data.subarray(tail), this.data.subarray(0, head)];
  }

  /** 先頭 n バイトを消費済みにする。未読不足なら何もせず false。 */
  consume(n: number): boolean {
    if (!Number.isInteger(n) || n < 0) return false;
    const head = this.head;
    const tail = this.tail;
    if (n > ringUsed(head, tail, this.capacity)) return false;
    writeU32(this.region, RING_OFF_TAIL, (tail + n) % this.capacity);
    return true;
  }

  /** 未読全体を1本の連結バッファにまとめ、リングを空にする (flush時の1コピー)。 */
  drainCompacted(): Uint8Array {
    const spans = this.readableSpans();
    if (spans.length === 0) return new Uint8Array(0);
    let out: Uint8Array;
    if (spans.length === 1) {
      out = spans[0]!.slice();
    } else {
      out = new Uint8Array(spans[0]!.length + spans[1]!.length);
      out.set(spans[0]!, 0);
      out.set(spans[1]!, spans[0]!.length);
    }
    writeU32(this.region, RING_OFF_TAIL, this.head);
    return out;
  }

  clear(): void {
    writeU32(this.region, RING_OFF_TAIL, this.head);
  }
}

export interface FrameBatcherOptions {
  /** 蓄積 byte 数の上限。到達で push が batch を返す。既定 65536。 */
  readonly maxBytes?: number;
  /** 蓄積フレーム数の上限。到達で push が batch を返す。既定 64。 */
  readonly maxFrames?: number;
}

/** 通常ヒープ上のフレームバッチ化。Bridge 呼び出し回数を削減する。
 *
 * 使用例 (JS Glue のフラッシュ時):
 * ```ts
 * const batcher = new FrameBatcher({ maxBytes: 16384, maxFrames: 32 });
 * const ready = batcher.push(frame);          // 閾値到達で連結batchを返す
 * if (ready) await transport.send(ready);     // ネイティブ呼び出しは1回
 * // 周期フラッシュ:
 * function onTick() { const b = batcher.flush(); if (b) void transport.send(b); }
 * ```
 */
export class FrameBatcher {
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(opts: FrameBatcherOptions = {}) {
    const maxBytes = opts.maxBytes ?? 65536;
    const maxFrames = opts.maxFrames ?? 64;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError("maxFrames must be a positive integer");
    }
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  get pendingFrames(): number {
    return this.chunks.length;
  }

  /** フレームを1件蓄積する (1コピー)。閾値到達時は連結 batch を返す。 */
  push(frame: Uint8Array): Uint8Array | null {
    this.chunks.push(frame.slice());
    this.bytes += frame.length;
    if (this.bytes >= this.maxBytes || this.chunks.length >= this.maxFrames) {
      return this.flush();
    }
    return null;
  }

  /** 蓄積分を1本に連結して取り出す。空なら null。単一時は複写なしで所有権を移す。 */
  flush(): Uint8Array | null {
    if (this.chunks.length === 0) return null;
    let out: Uint8Array;
    if (this.chunks.length === 1) {
      out = this.chunks[0]!;
    } else {
      out = new Uint8Array(this.bytes);
      let o = 0;
      for (const c of this.chunks) {
        out.set(c, o);
        o += c.length;
      }
    }
    this.chunks = [];
    this.bytes = 0;
    return out;
  }
}
