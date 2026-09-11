#include "core.h"

#include <cstddef>
#include <cstdint>
#include <limits>

namespace {

constexpr char kVersion[] = "0.1.0";

}  // namespace

uint32_t core_abi_version(void) { return CORE_ABI_VERSION; }

const char* core_version(void) { return kVersion; }

int32_t core_transform_i32(const int32_t* input, uint32_t count,
                          int32_t multiplier, int32_t offset, int32_t* output,
                          uint32_t output_capacity, uint32_t* checksum) {
  // 検査順: count上限 → checksum NULL → output_capacity不足 → count>0のinput/output NULL。
  // 全検査が終わる前に出力・checksumを書かない。エラー時は両方不変。
  if (count > CORE_MAX_VALUES) {
    return CORE_ERR_LIMIT_EXCEEDED;
  }
  if (checksum == nullptr) {
    return CORE_ERR_INVALID_ARGUMENT;
  }
  if (output_capacity < count) {
    return CORE_ERR_BUFFER_TOO_SMALL;
  }
  if (count > 0) {
    if (input == nullptr || output == nullptr) {
      return CORE_ERR_INVALID_ARGUMENT;
    }
  }

  // count==0: input/outputはNULL可。成功時checksum=0。
  if (count == 0) {
    *checksum = 0;
    return CORE_OK;
  }

  constexpr int64_t kMin = static_cast<int64_t>(std::numeric_limits<int32_t>::min());
  constexpr int64_t kMax = static_cast<int64_t>(std::numeric_limits<int32_t>::max());

  uint32_t acc = 0;
  for (uint32_t i = 0; i < count; ++i) {
    int64_t v =
        static_cast<int64_t>(input[i]) * static_cast<int64_t>(multiplier) +
        static_cast<int64_t>(offset);
    int32_t clamped;
    if (v < kMin) {
      clamped = std::numeric_limits<int32_t>::min();
    } else if (v > kMax) {
      clamped = std::numeric_limits<int32_t>::max();
    } else {
      clamped = static_cast<int32_t>(v);
    }
    output[i] = clamped;
    acc += static_cast<uint32_t>(clamped);
  }
  *checksum = acc;
  return CORE_OK;
}
