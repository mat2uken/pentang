// C単体試験 (C-02/C-03)。assert()に依存せず、失敗時は非0終了する。
// 対象ケースは docs/plan/12-test-case-catalog.md のcore-01〜core-10と共通期待値。
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "poc_core.h"

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

void check_status(int32_t got, int32_t want, const char* id) {
  ++g_checks;
  if (got != want) {
    ++g_failures;
    std::printf("FAIL %s: status got=%d want=%d\n", id, (int)got, (int)want);
  } else {
    std::printf("ok %s\n", id);
  }
}

bool vec_eq(const int32_t* a, const int32_t* b, uint32_t n) {
  for (uint32_t i = 0; i < n; ++i)
    if (a[i] != b[i]) return false;
  return true;
}

// 成功ケースの実行ヘルパー
void run_valid(const char* id, const int32_t* in, uint32_t n, int32_t mul,
               int32_t off, const int32_t* want, uint32_t want_sum) {
  std::vector<int32_t> out(n > 0 ? n : 1, 0x12345678);
  uint32_t sum = 0xdeadbeef;
  int32_t st = poc_transform_i32(n == 0 ? nullptr : in, n, mul, off,
                                 n == 0 ? nullptr : out.data(), n, &sum);
  char buf[128];
  std::snprintf(buf, sizeof(buf), "%s.status", id);
  check_status(st, POC_OK, buf);
  std::snprintf(buf, sizeof(buf), "%s.values", id);
  check(n == 0 || vec_eq(out.data(), want, n), buf, "values mismatch");
  std::snprintf(buf, sizeof(buf), "%s.checksum", id);
  check(sum == want_sum, buf, "checksum mismatch");
}

}  // namespace

int main() {
  // ABI/version
  check(poc_core_abi_version() == 1, "abi", "abiVersion must be 1");
  {
    const char* v = poc_core_version();
    check(v != nullptr, "version.nonnull", "version null");
    check(v != nullptr && std::strcmp(v, "0.1.0") == 0, "version.value",
          "version must be 0.1.0");
  }

  // core-01: count=0、input/output=NULL、cap=0、checksum有効 → OK, checksum=0
  {
    uint32_t sum = 0xdeadbeef;
    int32_t st = poc_transform_i32(nullptr, 0, 1, 2, nullptr, 0, &sum);
    check_status(st, POC_OK, "core-01.status");
    check(sum == 0, "core-01.checksum", "checksum must be 0");
  }
  // core-02: count=1、input=NULL → INVALID
  {
    int32_t out = 0x11111111;
    uint32_t sum = 0x22222222;
    int32_t st = poc_transform_i32(nullptr, 1, 1, 0, &out, 1, &sum);
    check_status(st, POC_ERR_INVALID_ARGUMENT, "core-02.status");
    check(out == 0x11111111, "core-02.output-unchanged", "output changed");
    check(sum == 0x22222222, "core-02.checksum-unchanged", "checksum changed");
  }
  // core-03: count=1、output=NULL → INVALID
  {
    int32_t in = 5;
    uint32_t sum = 0x22222222;
    int32_t st = poc_transform_i32(&in, 1, 1, 0, nullptr, 1, &sum);
    check_status(st, POC_ERR_INVALID_ARGUMENT, "core-03.status");
    check(sum == 0x22222222, "core-03.checksum-unchanged", "checksum changed");
  }
  // core-04: checksum=NULL → INVALID
  {
    int32_t in = 5;
    int32_t out = 0x11111111;
    int32_t st = poc_transform_i32(&in, 1, 1, 0, &out, 1, nullptr);
    check_status(st, POC_ERR_INVALID_ARGUMENT, "core-04.status");
    check(out == 0x11111111, "core-04.output-unchanged", "output changed");
  }
  // core-05: cap=0 → BUFFER_TOO_SMALL
  {
    int32_t in = 5;
    int32_t out = 0x11111111;
    uint32_t sum = 0x22222222;
    int32_t st = poc_transform_i32(&in, 1, 1, 0, &out, 0, &sum);
    check_status(st, POC_ERR_BUFFER_TOO_SMALL, "core-05.status");
    check(out == 0x11111111, "core-05.output-unchanged", "output changed");
    check(sum == 0x22222222, "core-05.checksum-unchanged", "checksum changed");
  }
  // core-06: count=4097 → LIMIT (pointerを読む前に終了)
  {
    uint32_t sum = 0x22222222;
    int32_t st = poc_transform_i32(nullptr, 4097, 1, 0, nullptr, 0, &sum);
    check_status(st, POC_ERR_LIMIT_EXCEEDED, "core-06.status");
    check(sum == 0x22222222, "core-06.checksum-unchanged", "checksum changed");
  }
  // core-07: checksum=NULL + cap=0 → INVALIDが先 (capacityより先)
  {
    int32_t in = 5;
    int32_t out = 0x11111111;
    int32_t st = poc_transform_i32(&in, 1, 1, 0, &out, 0, nullptr);
    check_status(st, POC_ERR_INVALID_ARGUMENT, "core-07.status");
    check(out == 0x11111111, "core-07.output-unchanged", "output changed");
  }
  // core-08: input/output=NULL + cap=0 → BUFFER_TOO_SMALLが先
  {
    uint32_t sum = 0x22222222;
    int32_t st = poc_transform_i32(nullptr, 1, 1, 0, nullptr, 0, &sum);
    check_status(st, POC_ERR_BUFFER_TOO_SMALL, "core-08.status");
    check(sum == 0x22222222, "core-08.checksum-unchanged", "checksum changed");
  }
  // core-09: count=0、checksum=NULL → INVALID
  {
    int32_t st = poc_transform_i32(nullptr, 0, 1, 0, nullptr, 0, nullptr);
    check_status(st, POC_ERR_INVALID_ARGUMENT, "core-09.status");
  }

  // core-10: sentinel不変。成功/失敗の入出力の前後にsentinel。
  {
    int32_t in_vals[3] = {1, 2, 3};
    // 成功時の領域外不変
    int32_t buf[5] = {0x7a7a7a7a, 0, 0, 0, 0x7a7a7a7a};
    uint32_t sum = 0;
    int32_t st = poc_transform_i32(in_vals, 3, 2, 1, &buf[1], 3, &sum);
    check_status(st, POC_OK, "core-10.ok.status");
    check(buf[0] == 0x7a7a7a7a && buf[4] == 0x7a7a7a7a, "core-10.ok.sentinel",
          "sentinel changed");
    // 失敗時は出力と既存checksumも不変
    int32_t out2[3] = {0x11111111, 0x22222222, 0x33333333};
    uint32_t sum2 = 0x44444444;
    int32_t in2 = 9;
    st = poc_transform_i32(&in2, 1, 1, 0, out2, 0, &sum2);
    check_status(st, POC_ERR_BUFFER_TOO_SMALL, "core-10.err.status");
    check(out2[0] == 0x11111111 && out2[1] == 0x22222222 &&
              out2[2] == 0x33333333,
          "core-10.err.output", "output changed on error");
    check(sum2 == 0x44444444, "core-10.err.checksum",
          "checksum changed on error");
  }

  // 共通期待値 (golden valid 10件)
  {
    const int32_t in[] = {1, 2, 3};
    const int32_t want[] = {3, 5, 7};
    run_valid("valid.basic", in, 3, 2, 1, want, 15);
  }
  {
    const int32_t in[] = {-3, 0, 7};
    const int32_t want[] = {11, 5, -9};
    run_valid("valid.signed", in, 3, -2, 5, want, 7);
  }
  {
    run_valid("valid.empty", nullptr, 0, 1, 0, nullptr, 0);
  }
  {
    const int32_t in[] = {0, 1, -1, 2147483647, INT32_MIN};
    const int32_t want[] = {0, 1, -1, 2147483647, INT32_MIN};
    run_valid("valid.identity", in, 5, 1, 0, want, 4294967295u);
  }
  {
    const int32_t in[] = {2147483647, 1073741824};
    const int32_t want[] = {2147483647, 2147483647};
    run_valid("valid.saturate-positive", in, 2, 2, 100, want, 4294967294u);
  }
  {
    const int32_t in[] = {INT32_MIN, -1073741824};
    const int32_t want[] = {INT32_MIN, INT32_MIN};
    run_valid("valid.saturate-negative", in, 2, 2, -100, want, 0u);
  }
  {
    const int32_t in[] = {INT32_MIN, 2147483647};
    const int32_t want[] = {2147483647, -2147483647};
    run_valid("valid.negate-min", in, 2, -1, 0, want, 0u);
  }
  {
    const int32_t in[] = {100, -100};
    const int32_t want[] = {-1, -1};
    run_valid("valid.zero-gain", in, 2, 0, -1, want, 4294967294u);
  }
  {
    const int32_t in[] = {2147483647, INT32_MIN};
    const int32_t want[] = {2147483647, INT32_MIN};
    run_valid("valid.large-product", in, 2, 2147483647, INT32_MIN, want,
              4294967295u);
  }
  {
    const int32_t in[] = {INT32_MIN, 2147483647};
    const int32_t want[] = {2147483647, INT32_MIN};
    run_valid("valid.min-product", in, 2, INT32_MIN, 2147483647, want,
              4294967295u);
  }
  // maximum-length: 4096件
  {
    std::vector<int32_t> in(4096, 1);
    std::vector<int32_t> want(4096, 3);
    std::vector<int32_t> out(4096, 0);
    uint32_t sum = 0;
    int32_t st =
        poc_transform_i32(in.data(), 4096, 2, 1, out.data(), 4096, &sum);
    check_status(st, POC_OK, "valid.maximum-length.status");
    check(vec_eq(out.data(), want.data(), 4096), "valid.maximum-length.values",
          "values mismatch");
    check(sum == 12288, "valid.maximum-length.checksum", "checksum mismatch");
  }
  // too-long相当: C側はLIMIT
  {
    uint32_t sum = 0xdeadbeef;
    int32_t st = poc_transform_i32(nullptr, 4097, 1, 0, nullptr, 0, &sum);
    check_status(st, POC_ERR_LIMIT_EXCEEDED, "invalid.too-long.status");
  }

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
