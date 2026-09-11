#ifndef POC_WIRE_H
#define POC_WIRE_H

/* 共通バイナリ電文プロトコル (Wire Format v1)。
 *
 * 全OS共通の16バイト固定ヘッダー + ペイロード。JSON/Base64 を使わず、
 * 制御プレーン (RPC/コマンド) とデータプレーン (バルク転送) を同一
 * フレーム形式で運ぶ。OS 固有トランスポート (共有メモリ / IPC / Port /
 * プロセス内直結) の上位にある共通層で、トランスポートは本ヘッダーを
 * 解釈せず不透明なバイト列として運ぶだけでよい。
 *
 * 制約 (poc_core.h と同じ):
 * - C++17、OS / Tauri / Emscripten の header を参照しない。
 * - グローバルな可変状態、所有メモリ、例外、I/O、callback を持たない。
 * - 全関数は caller 所有のバッファだけを読み書きし、pointer を保持しない。
 * - リトルエンディアン固定。アラインメントを仮定せず1バイトずつ組立てる。
 *
 * レイアウト (全て LE):
 *   offset 0: magic u16 = 0x5742 ("WB" の上位読み。wire byte は [0x42,0x57])
 *   offset 2: command u16 (1=getInfo, 2=transform)
 *   offset 4: flags u16 (bit0 ERROR, bit1 CONTINUED, bit2 COMPRESSED)
 *   offset 6: sequence u16 (要求対応付け用。0 も有効値として運ぶ)
 *   offset 8: payload_len u32 (ヘッダー直後のバイト数)
 *   offset 12: reserved u32 (送信時は必ず0。非0は INVALID)
 *
 * ペイロード (LE、パディングなし):
 *   transform 要求: u32 count + i32 multiplier + i32 offset + i32 values[count]
 *   transform 応答: u32 count + u32 checksum + i32 values[count]
 *   getInfo 要求: 空 (0 byte)
 *   getInfo 応答: u32 abi_version + u32 version_len + u8 version[version_len]
 *     (version は NUL 終端なし UTF-8。1..64 byte)
 */

#include <stddef.h>
#include <stdint.h>

#define POC_WIRE_SIZE 16u
#define POC_WIRE_MAGIC UINT16_C(0x5742)
#define POC_WIRE_VERSION UINT32_C(1)

#define POC_WIRE_CMD_GET_INFO UINT16_C(1)
#define POC_WIRE_CMD_TRANSFORM UINT16_C(2)

#define POC_WIRE_FLAG_ERROR UINT16_C(0x0001)
#define POC_WIRE_FLAG_CONTINUED UINT16_C(0x0002)
#define POC_WIRE_FLAG_COMPRESSED UINT16_C(0x0004)

#define POC_WIRE_MAX_VALUES UINT32_C(4096)
#define POC_WIRE_MAX_VERSION_LEN UINT32_C(64)
#define POC_WIRE_MAX_PAYLOAD UINT32_C(16777216) /* 16MiB: transform最大(12+4*4096=16400B)を十分含む上限 */

#define POC_WIRE_OK INT32_C(0)
#define POC_WIRE_ERR_INVALID_ARGUMENT INT32_C(1)
#define POC_WIRE_ERR_LIMIT_EXCEEDED INT32_C(2)
#define POC_WIRE_ERR_BUFFER_TOO_SMALL INT32_C(3)
#define POC_WIRE_ERR_BAD_MAGIC INT32_C(4)

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint16_t command;
  uint16_t flags;
  uint16_t sequence;
  uint32_t payload_len;
} poc_wire_header_t;

static inline void poc_wire_write_u16le(uint8_t* out, uint16_t v) {
  out[0] = (uint8_t)(v & 0xFFu);
  out[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static inline void poc_wire_write_u32le(uint8_t* out, uint32_t v) {
  out[0] = (uint8_t)(v & 0xFFu);
  out[1] = (uint8_t)((v >> 8) & 0xFFu);
  out[2] = (uint8_t)((v >> 16) & 0xFFu);
  out[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static inline uint16_t poc_wire_read_u16le(const uint8_t* p) {
  return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static inline uint32_t poc_wire_read_u32le(const uint8_t* p) {
  return (uint32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                    ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
}

/* フレーム全体長 = 16 + payload_len。加算オーバーフロー時は0を返す。 */
static inline uint32_t poc_wire_frame_size(uint32_t payload_len) {
  if (payload_len > POC_WIRE_MAX_PAYLOAD) {
    return 0;
  }
  return POC_WIRE_SIZE + payload_len;
}

/* transform 要求ペイロード長 = 12 + 4*count。count 上限検査付き。 */
static inline int32_t poc_wire_transform_request_payload_size(
    uint32_t count, uint32_t* out_size) {
  if (out_size == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  *out_size = 12u + count * 4u;
  return POC_WIRE_OK;
}

/* transform 応答ペイロード長 = 8 + 4*count。 */
static inline int32_t poc_wire_transform_response_payload_size(
    uint32_t count, uint32_t* out_size) {
  if (out_size == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  *out_size = 8u + count * 4u;
  return POC_WIRE_OK;
}

static inline int32_t poc_wire_encode_header(uint8_t* out, size_t out_capacity,
                                             uint16_t command, uint16_t flags,
                                             uint16_t sequence,
                                             uint32_t payload_len) {
  if (out == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (command != POC_WIRE_CMD_GET_INFO && command != POC_WIRE_CMD_TRANSFORM) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  /* 予約ビット付き flags は送らない (将来拡張の取違え防止)。 */
  if ((flags & (uint16_t) ~(POC_WIRE_FLAG_ERROR | POC_WIRE_FLAG_CONTINUED |
                            POC_WIRE_FLAG_COMPRESSED)) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (payload_len > POC_WIRE_MAX_PAYLOAD) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (out_capacity < POC_WIRE_SIZE) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  poc_wire_write_u16le(out + 0, POC_WIRE_MAGIC);
  poc_wire_write_u16le(out + 2, command);
  poc_wire_write_u16le(out + 4, flags);
  poc_wire_write_u16le(out + 6, sequence);
  poc_wire_write_u32le(out + 8, payload_len);
  poc_wire_write_u32le(out + 12, 0);
  return POC_WIRE_OK;
}

/* 先頭16バイトを検査してヘッダーを読む。payload の有無は検査しない。 */
static inline int32_t poc_wire_decode_header(const uint8_t* buf, size_t buf_len,
                                             poc_wire_header_t* out) {
  if (buf == NULL || out == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (buf_len < POC_WIRE_SIZE) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  if (poc_wire_read_u16le(buf + 0) != POC_WIRE_MAGIC) {
    return POC_WIRE_ERR_BAD_MAGIC;
  }
  uint16_t command = poc_wire_read_u16le(buf + 2);
  if (command != POC_WIRE_CMD_GET_INFO && command != POC_WIRE_CMD_TRANSFORM) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint16_t flags = poc_wire_read_u16le(buf + 4);
  if ((flags & (uint16_t) ~(POC_WIRE_FLAG_ERROR | POC_WIRE_FLAG_CONTINUED |
                            POC_WIRE_FLAG_COMPRESSED)) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (poc_wire_read_u32le(buf + 12) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint32_t payload_len = poc_wire_read_u32le(buf + 8);
  if (payload_len > POC_WIRE_MAX_PAYLOAD) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  out->command = command;
  out->flags = flags;
  out->sequence = poc_wire_read_u16le(buf + 6);
  out->payload_len = payload_len;
  return POC_WIRE_OK;
}

/* バッチ受信の1フレーム走査。buf 先頭の完全な1フレームを検証し、
 * payload へのポインタ (入力buf内・ゼロコピー) とフレーム長を返す。
 * 末尾断片 (header不足・payload不足) は BUFFER_TOO_SMALL。
 * ネイティブ側は本関数でループし、ヘッダーを見ながら一括消費する。 */
static inline int32_t poc_wire_next_frame(const uint8_t* buf, size_t buf_len,
                                          poc_wire_header_t* header_out,
                                          const uint8_t** payload_out,
                                          uint32_t* frame_len_out) {
  if (buf == NULL || header_out == NULL || payload_out == NULL ||
      frame_len_out == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  poc_wire_header_t h;
  int32_t st = poc_wire_decode_header(buf, buf_len, &h);
  if (st != POC_WIRE_OK) {
    return st;
  }
  uint32_t frame_len = poc_wire_frame_size(h.payload_len);
  if (frame_len == 0) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (buf_len < frame_len) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  *header_out = h;
  *payload_out = buf + POC_WIRE_SIZE;
  *frame_len_out = frame_len;
  return POC_WIRE_OK;
}

/* transform 要求フレームを1本エンコードする (header + payload 一括)。
 * values は count>0 のとき有効な整列領域。count==0 では NULL 可。 */
static inline int32_t poc_wire_encode_transform_request(
    uint8_t* out, size_t out_capacity, uint16_t sequence, uint16_t flags,
    const int32_t* values, uint32_t count, int32_t multiplier, int32_t offset,
    uint32_t* out_frame_len) {
  if (out == NULL || out_frame_len == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (count > 0 && values == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  /* ERROR フラグ付きの要求は送らない。COMPRESSED は本 PoC で未対応。 */
  if ((flags & POC_WIRE_FLAG_ERROR) != 0 ||
      (flags & POC_WIRE_FLAG_COMPRESSED) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if ((flags & (uint16_t) ~(POC_WIRE_FLAG_CONTINUED)) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint32_t payload_len = 12u + count * 4u;
  uint32_t frame_len = POC_WIRE_SIZE + payload_len;
  if (out_capacity < frame_len) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  int32_t st = poc_wire_encode_header(out, out_capacity,
                                      POC_WIRE_CMD_TRANSFORM, flags, sequence,
                                      payload_len);
  if (st != POC_WIRE_OK) {
    return st;
  }
  uint8_t* p = out + POC_WIRE_SIZE;
  poc_wire_write_u32le(p + 0, count);
  poc_wire_write_u32le(p + 4, (uint32_t)multiplier);
  poc_wire_write_u32le(p + 8, (uint32_t)offset);
  for (uint32_t i = 0; i < count; ++i) {
    poc_wire_write_u32le(p + 12 + i * 4u, (uint32_t)values[i]);
  }
  *out_frame_len = frame_len;
  return POC_WIRE_OK;
}

/* transform 要求フレームを検証し、values へのビュー (入力buf内) を返す。
 * コピーしない。command 不一致・ERROR 付きは INVALID。 */
static inline int32_t poc_wire_decode_transform_request(
    const uint8_t* frame, size_t frame_len, uint16_t* sequence_out,
    const int32_t** values_out, uint32_t* count_out, int32_t* multiplier_out,
    int32_t* offset_out) {
  if (frame == NULL || sequence_out == NULL || values_out == NULL ||
      count_out == NULL || multiplier_out == NULL || offset_out == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  poc_wire_header_t h;
  const uint8_t* payload;
  uint32_t consumed;
  int32_t st = poc_wire_next_frame(frame, frame_len, &h, &payload, &consumed);
  if (st != POC_WIRE_OK) {
    return st;
  }
  if (consumed != frame_len) {
    /* 余剰連結はバッチとして扱い、単体デコードでは拒否する。 */
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (h.command != POC_WIRE_CMD_TRANSFORM) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if ((h.flags & POC_WIRE_FLAG_ERROR) != 0 ||
      (h.flags & POC_WIRE_FLAG_COMPRESSED) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (h.payload_len < 12u || ((h.payload_len - 12u) % 4u) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint32_t count = poc_wire_read_u32le(payload + 0);
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (h.payload_len != 12u + count * 4u) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  *sequence_out = h.sequence;
  *count_out = count;
  *multiplier_out = (int32_t)poc_wire_read_u32le(payload + 4);
  *offset_out = (int32_t)poc_wire_read_u32le(payload + 8);
  *values_out =
      count == 0 ? NULL : (const int32_t*)(const void*)(payload + 12);
  return POC_WIRE_OK;
}

/* transform 応答フレームを1本エンコードする。 */
static inline int32_t poc_wire_encode_transform_response(
    uint8_t* out, size_t out_capacity, uint16_t sequence, uint16_t flags,
    const int32_t* values, uint32_t count, uint32_t checksum,
    uint32_t* out_frame_len) {
  if (out == NULL || out_frame_len == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (count > 0 && values == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if ((flags & POC_WIRE_FLAG_COMPRESSED) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if ((flags & (uint16_t) ~(POC_WIRE_FLAG_ERROR | POC_WIRE_FLAG_CONTINUED)) !=
      0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint32_t payload_len = 8u + count * 4u;
  uint32_t frame_len = POC_WIRE_SIZE + payload_len;
  if (out_capacity < frame_len) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  int32_t st = poc_wire_encode_header(out, out_capacity,
                                      POC_WIRE_CMD_TRANSFORM, flags, sequence,
                                      payload_len);
  if (st != POC_WIRE_OK) {
    return st;
  }
  uint8_t* p = out + POC_WIRE_SIZE;
  poc_wire_write_u32le(p + 0, count);
  poc_wire_write_u32le(p + 4, checksum);
  for (uint32_t i = 0; i < count; ++i) {
    poc_wire_write_u32le(p + 8 + i * 4u, (uint32_t)values[i]);
  }
  *out_frame_len = frame_len;
  return POC_WIRE_OK;
}

/* transform 応答フレームを検証し、values ビュー (入力buf内) を返す。 */
static inline int32_t poc_wire_decode_transform_response(
    const uint8_t* frame, size_t frame_len, uint16_t* sequence_out,
    uint16_t* flags_out, const int32_t** values_out, uint32_t* count_out,
    uint32_t* checksum_out) {
  if (frame == NULL || sequence_out == NULL || flags_out == NULL ||
      values_out == NULL || count_out == NULL || checksum_out == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  poc_wire_header_t h;
  const uint8_t* payload;
  uint32_t consumed;
  int32_t st = poc_wire_next_frame(frame, frame_len, &h, &payload, &consumed);
  if (st != POC_WIRE_OK) {
    return st;
  }
  if (consumed != frame_len) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (h.command != POC_WIRE_CMD_TRANSFORM) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if ((h.flags & POC_WIRE_FLAG_COMPRESSED) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (h.payload_len < 8u || ((h.payload_len - 8u) % 4u) != 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  uint32_t count = poc_wire_read_u32le(payload + 0);
  if (count > POC_WIRE_MAX_VALUES) {
    return POC_WIRE_ERR_LIMIT_EXCEEDED;
  }
  if (h.payload_len != 8u + count * 4u) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  *sequence_out = h.sequence;
  *flags_out = h.flags;
  *count_out = count;
  *checksum_out = poc_wire_read_u32le(payload + 4);
  *values_out =
      count == 0 ? NULL : (const int32_t*)(const void*)(payload + 8);
  return POC_WIRE_OK;
}

/* getInfo 要求フレーム (payload 0) をエンコードする。 */
static inline int32_t poc_wire_encode_get_info_request(uint8_t* out,
                                                       size_t out_capacity,
                                                       uint16_t sequence,
                                                       uint32_t* out_frame_len) {
  if (out == NULL || out_frame_len == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (out_capacity < POC_WIRE_SIZE) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  int32_t st = poc_wire_encode_header(out, out_capacity,
                                      POC_WIRE_CMD_GET_INFO, 0, sequence, 0);
  if (st != POC_WIRE_OK) {
    return st;
  }
  *out_frame_len = POC_WIRE_SIZE;
  return POC_WIRE_OK;
}

/* getInfo 応答フレームをエンコードする。version は NUL 終端なし byte 列。 */
static inline int32_t poc_wire_encode_get_info_response(
    uint8_t* out, size_t out_capacity, uint16_t sequence,
    uint32_t abi_version, const uint8_t* version_bytes, uint32_t version_len,
    uint32_t* out_frame_len) {
  if (out == NULL || out_frame_len == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (version_len == 0 || version_len > POC_WIRE_MAX_VERSION_LEN) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (version_bytes == NULL) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  for (uint32_t i = 0; i < version_len; ++i) {
    if (version_bytes[i] == 0) {
      return POC_WIRE_ERR_INVALID_ARGUMENT;
    }
  }
  uint32_t payload_len = 8u + version_len;
  uint32_t frame_len = POC_WIRE_SIZE + payload_len;
  if (out_capacity < frame_len) {
    return POC_WIRE_ERR_BUFFER_TOO_SMALL;
  }
  int32_t st = poc_wire_encode_header(out, out_capacity,
                                      POC_WIRE_CMD_GET_INFO, 0, sequence,
                                      payload_len);
  if (st != POC_WIRE_OK) {
    return st;
  }
  uint8_t* p = out + POC_WIRE_SIZE;
  poc_wire_write_u32le(p + 0, abi_version);
  poc_wire_write_u32le(p + 4, version_len);
  for (uint32_t i = 0; i < version_len; ++i) {
    p[8 + i] = version_bytes[i];
  }
  *out_frame_len = frame_len;
  return POC_WIRE_OK;
}

#ifdef __cplusplus
}
#endif

/* 共有リングバッファのレイアウト (WASM 線形メモリ内にも配置できる)。
 *
 *   offset 0: head u32 (次に書く位置。データ領域先頭からの byte offset)
 *   offset 4: tail u32 (次に読む位置。同上)
 *   offset 8: capacity u32 (データ領域の byte 数)
 *   offset 12..: data[capacity]
 *
 * 空は head==tail。満杯判定のため1バイトを常に空けておき、
 * used = (head - tail + cap) % cap、free = cap - 1 - used。
 * head/tail は JS 側から直接操作でき、WASM 側の生産者とも共有できる。
 * フレーム境界は本層では付けず、呼び出し側が完全なフレーム単位で
 * write し、受信側は poc_wire_next_frame ループで消費する。
 */
#define POC_RING_META_SIZE 12u
#define POC_RING_OFF_HEAD 0u
#define POC_RING_OFF_TAIL 4u
#define POC_RING_OFF_CAPACITY 8u

#ifdef __cplusplus
extern "C" {
#endif

static inline int32_t poc_ring_check(uint32_t head, uint32_t tail,
                                     uint32_t capacity) {
  if (capacity == 0) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  if (head >= capacity || tail >= capacity) {
    return POC_WIRE_ERR_INVALID_ARGUMENT;
  }
  return POC_WIRE_OK;
}

static inline uint32_t poc_ring_used(uint32_t head, uint32_t tail,
                                     uint32_t capacity) {
  if (capacity == 0) {
    return 0;
  }
  return head >= tail ? head - tail : capacity - (tail - head);
}

static inline uint32_t poc_ring_free(uint32_t head, uint32_t tail,
                                     uint32_t capacity) {
  if (capacity == 0) {
    return 0;
  }
  return capacity - 1u - poc_ring_used(head, tail, capacity);
}

#ifdef __cplusplus
}
#endif
#endif
