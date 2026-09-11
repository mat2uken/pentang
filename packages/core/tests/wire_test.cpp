// wire 単体試験。core_wire.h の header-only 実装を検査する。
// assert()に依存せず、失敗時は非0終了する (core_test.cpp と同じ形式)。
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "core_wire.h"

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool cond, const char* id, const char* msg) {
  ++g_checks;
  if (!cond) {
    ++g_failures;
    std::printf("FAIL %s: %s\n", id, msg);
  } else {
    std::printf("ok %s\n", id);
  }
}

bool bytes_eq(const uint8_t* a, const uint8_t* b, size_t n) {
  for (size_t i = 0; i < n; ++i)
    if (a[i] != b[i]) return false;
  return true;
}

}  // namespace

int main() {
  // header の固定バイト列 (seq=7, payload=12): TS/Rust 試験と同一値を固定する。
  {
    uint8_t out[16];
    int32_t st = core_wire_encode_header(out, sizeof(out),
                                        CORE_WIRE_CMD_TRANSFORM, 0, 7, 12);
    check(st == CORE_WIRE_OK, "wire.header.status", "encode failed");
    const uint8_t want[16] = {0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x07, 0x00,
                              0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
    check(bytes_eq(out, want, 16), "wire.header.bytes", "header bytes mismatch");
    core_wire_header_t h;
    st = core_wire_decode_header(out, sizeof(out), &h);
    check(st == CORE_WIRE_OK, "wire.header.decode", "decode failed");
    check(h.command == CORE_WIRE_CMD_TRANSFORM && h.flags == 0 &&
              h.sequence == 7 && h.payload_len == 12,
          "wire.header.fields", "header fields mismatch");
  }
  // 不正 magic は BAD_MAGIC。
  {
    uint8_t out[16];
    core_wire_encode_header(out, sizeof(out), CORE_WIRE_CMD_GET_INFO, 0, 1, 0);
    out[0] ^= 0xFFu;
    core_wire_header_t h;
    int32_t st = core_wire_decode_header(out, sizeof(out), &h);
    check(st == CORE_WIRE_ERR_BAD_MAGIC, "wire.magic.status", "must be BAD_MAGIC");
  }
  // reserved 非0は INVALID。
  {
    uint8_t out[16];
    core_wire_encode_header(out, sizeof(out), CORE_WIRE_CMD_GET_INFO, 0, 1, 0);
    out[12] = 1;
    core_wire_header_t h;
    int32_t st = core_wire_decode_header(out, sizeof(out), &h);
    check(st == CORE_WIRE_ERR_INVALID_ARGUMENT, "wire.reserved.status",
          "reserved!=0 must be INVALID");
  }
  // transform 要求の往復 (basic: [1,2,3], mult=2, off=1, seq=9)。
  // 先頭40バイトの完全一致で TS/Rust とバイト互換を固定する。
  {
    const int32_t vals[3] = {1, 2, 3};
    uint8_t out[64];
    uint32_t frame_len = 0;
    int32_t st = core_wire_encode_transform_request(
        out, sizeof(out), 9, 0, vals, 3, 2, 1, &frame_len);
    check(st == CORE_WIRE_OK, "wire.treq.status", "encode failed");
    check(frame_len == 40, "wire.treq.len", "frame must be 40 bytes");
    const uint8_t want[40] = {
        0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x09, 0x00,
        0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00};
    check(bytes_eq(out, want, 40), "wire.treq.bytes", "request bytes mismatch");
    uint16_t seq = 0;
    const int32_t* v = NULL;
    uint32_t count = 0;
    int32_t mul = 0, off = 0;
    st = core_wire_decode_transform_request(out, frame_len, &seq, &v, &count,
                                           &mul, &off);
    check(st == CORE_WIRE_OK, "wire.treq.decode", "decode failed");
    check(seq == 9 && count == 3 && mul == 2 && off == 1,
          "wire.treq.fields", "fields mismatch");
    check(v != NULL && v[0] == 1 && v[1] == 2 && v[2] == 3,
          "wire.treq.values", "values mismatch (LE view)");
  }
  // transform 要求の empty (count=0, フレーム28バイト)。
  {
    uint8_t out[32];
    uint32_t frame_len = 0;
    int32_t st = core_wire_encode_transform_request(out, sizeof(out), 1, 0,
                                                   NULL, 0, 1, 0, &frame_len);
    check(st == CORE_WIRE_OK, "wire.tempty.status", "encode failed");
    check(frame_len == 28, "wire.tempty.len", "frame must be 28 bytes");
    uint16_t seq = 0;
    const int32_t* v = (const int32_t*)0x1;
    uint32_t count = 99;
    int32_t mul = 0, off = 0;
    st = core_wire_decode_transform_request(out, frame_len, &seq, &v, &count,
                                           &mul, &off);
    check(st == CORE_WIRE_OK, "wire.tempty.decode", "decode failed");
    check(count == 0 && v == NULL, "wire.tempty.values", "empty must be NULL/0");
  }
  // count 上限超過は LIMIT。
  {
    uint8_t out[32];
    uint32_t frame_len = 0;
    int32_t st = core_wire_encode_transform_request(out, sizeof(out), 1, 0,
                                                   NULL, 4097, 1, 0, &frame_len);
    check(st == CORE_WIRE_ERR_LIMIT_EXCEEDED, "wire.tlimit.status",
          "must be LIMIT");
  }
  // transform 応答の往復 ([3,5,7], checksum=15, seq=4)。
  {
    const int32_t vals[3] = {3, 5, 7};
    uint8_t out[64];
    uint32_t frame_len = 0;
    int32_t st = core_wire_encode_transform_response(out, sizeof(out), 4, 0,
                                                    vals, 3, 15, &frame_len);
    check(st == CORE_WIRE_OK, "wire.tresp.status", "encode failed");
    check(frame_len == 36, "wire.tresp.len", "frame must be 36 bytes");
    uint16_t seq = 0, flags = 0;
    const int32_t* v = NULL;
    uint32_t count = 0, sum = 0;
    st = core_wire_decode_transform_response(out, frame_len, &seq, &flags, &v,
                                            &count, &sum);
    check(st == CORE_WIRE_OK, "wire.tresp.decode", "decode failed");
    check(seq == 4 && count == 3 && sum == 15, "wire.tresp.fields",
          "fields mismatch");
    check(v != NULL && v[0] == 3 && v[1] == 5 && v[2] == 7,
          "wire.tresp.values", "values mismatch");
  }
  // getInfo 要求 (16バイト) と応答 ("0.1.0", 29バイト) の往復。
  {
    uint8_t q[16];
    uint32_t qlen = 0;
    int32_t st = core_wire_encode_get_info_request(q, sizeof(q), 3, &qlen);
    check(st == CORE_WIRE_OK && qlen == 16, "wire.greq", "getInfo req failed");
    uint8_t r[32];
    uint32_t rlen = 0;
    const uint8_t ver[5] = {'0', '.', '1', '.', '0'};
    st = core_wire_encode_get_info_response(r, sizeof(r), 3, 1, ver, 5, &rlen);
    check(st == CORE_WIRE_OK && rlen == 29, "wire.gresp.status",
          "getInfo resp failed");
    core_wire_header_t h;
    const uint8_t* payload = NULL;
    uint32_t consumed = 0;
    st = core_wire_next_frame(r, rlen, &h, &payload, &consumed);
    check(st == CORE_WIRE_OK && consumed == 29 &&
              h.command == CORE_WIRE_CMD_GET_INFO,
          "wire.gresp.frame", "frame scan failed");
    check(payload[0] == 1 && payload[4] == 5 &&
              std::memcmp(payload + 8, "0.1.0", 5) == 0,
          "wire.gresp.payload", "payload mismatch");
  }
  // バッチ走査: 2フレーム連結を next_frame ループで一括消費する。
  {
    uint8_t buf[128];
    const int32_t v1[1] = {1};
    const int32_t v2[2] = {2, 3};
    uint32_t l1 = 0, l2 = 0;
    core_wire_encode_transform_request(buf, sizeof(buf), 1, 0, v1, 1, 1, 0, &l1);
    core_wire_encode_transform_request(buf + l1, sizeof(buf) - l1, 2, 0, v2, 2,
                                      1, 0, &l2);
    size_t total = (size_t)l1 + l2;
    size_t off = 0;
    int seen = 0;
    uint16_t last_seq = 0;
    while (off < total) {
      core_wire_header_t h;
      const uint8_t* payload = NULL;
      uint32_t flen = 0;
      int32_t st =
          core_wire_next_frame(buf + off, total - off, &h, &payload, &flen);
      check(st == CORE_WIRE_OK, "wire.batch.step", "batch step failed");
      if (st != CORE_WIRE_OK) break;
      last_seq = h.sequence;
      off += flen;
      ++seen;
    }
    check(seen == 2 && last_seq == 2 && off == total, "wire.batch.consume",
          "batch consume mismatch");
    // 末尾断片は BUFFER_TOO_SMALL (第2フレームの末尾1バイト欠け・先頭1バイト)。
    {
      core_wire_header_t h;
      const uint8_t* payload = NULL;
      uint32_t flen = 0;
      int32_t st =
          core_wire_next_frame(buf + l1, (size_t)l2 - 1, &h, &payload, &flen);
      check(st == CORE_WIRE_ERR_BUFFER_TOO_SMALL, "wire.batch.trunc",
            "truncated tail must be SMALL");
      st = core_wire_next_frame(buf + off - 1, 1, &h, &payload, &flen);
      check(st == CORE_WIRE_ERR_BUFFER_TOO_SMALL, "wire.batch.trunc-head",
            "truncated head must be SMALL");
    }
  }

  // 共有リングバッファの used/free 計算 (TS/Rust と同一意味)。
  {
    check(core_ring_used(0, 0, 64) == 0, "wire.ring.empty-used",
          "empty used must be 0");
    check(core_ring_free(0, 0, 64) == 63, "wire.ring.empty-free",
          "empty free must be cap-1");
    check(core_ring_used(10, 4, 64) == 6, "wire.ring.used",
          "used mismatch");
    check(core_ring_used(2, 60, 64) == 6, "wire.ring.wrap-used",
          "wrapped used mismatch");
    check(core_ring_free(2, 60, 64) == 57, "wire.ring.wrap-free",
          "wrapped free mismatch");
    check(core_ring_check(0, 0, 64) == CORE_WIRE_OK, "wire.ring.check-ok",
          "valid ring rejected");
    check(core_ring_check(64, 0, 64) == CORE_WIRE_ERR_INVALID_ARGUMENT,
          "wire.ring.check-head", "head>=cap must be INVALID");
    check(core_ring_check(0, 0, 0) == CORE_WIRE_ERR_INVALID_ARGUMENT,
          "wire.ring.check-cap", "cap==0 must be INVALID");
  }

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
