#ifndef POC_CORE_H
#define POC_CORE_H

#include <stdint.h>

#define POC_CORE_ABI_VERSION UINT32_C(1)
#define POC_CORE_MAX_VALUES UINT32_C(4096)

#define POC_OK INT32_C(0)
#define POC_ERR_INVALID_ARGUMENT INT32_C(1)
#define POC_ERR_LIMIT_EXCEEDED INT32_C(2)
#define POC_ERR_BUFFER_TOO_SMALL INT32_C(3)

#ifdef __cplusplus
extern "C" {
#endif

uint32_t poc_core_abi_version(void);

/* NUL終端UTF-8、プロセス/モジュールの寿命中有効。callerは解放しない。
 * v1 の実装値は "0.1.0"。Rust/TypeScriptへの受渡しは文字列をコピーする。 */
const char* poc_core_version(void);

/*
 * 一般契約:
 * - C++17で実装し、OS / Tauri / Emscripten のheaderを参照しない。
 * - グローバルな可変状態、所有メモリ、例外、I/O、callbackを持たない。
 * - input/outputは別領域。count > 0なら適切に整列した有効な領域を渡す。
 * - callerはinputにcount個、outputにoutput_capacity個の領域を用意する。
 *   生pointerが実際に有効か、関数側から一般的に検証できるわけではない。
 * - checksumは必ず有効な1個のuint32_tへのpointer。
 * - count == 0ならinput/outputはNULL可。成功時checksum=0。
 * - すべての引数チェックを計算前に行う。エラー時、出力は変更しない。
 *
 * 検証順: count上限 → checksum NULL → output_capacity不足
 *         → count > 0のinput/output NULL。
 *
 * 計算: int64_t(input[i]) * int64_t(multiplier) + int64_t(offset)
 * をINT32_MIN..INT32_MAXにclampしてoutput[i]へ書く。
 * checksumはuint32_t(output[i])をuint32_tで加算(mod 2^32)。
 */
int32_t poc_transform_i32(
    const int32_t* input,
    uint32_t count,
    int32_t multiplier,
    int32_t offset,
    int32_t* output,
    uint32_t output_capacity,
    uint32_t* checksum);

#ifdef __cplusplus
}
#endif
#endif
