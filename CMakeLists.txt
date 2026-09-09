cmake_minimum_required(VERSION 3.20)
project(poc_core_test CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 単体試験用のみ。製品のC++リンク経路はcc (crates/poc-core-ffi/build.rs)に一本化する。
add_executable(core_test
  cpp/tests/core_test.cpp
  cpp/src/core.cpp
)
target_include_directories(core_test PRIVATE cpp/include)

# NDEBUGでも検査が消えない実装 (assert不使用) のため、特別な定義は不要。
# Debug/Releaseは呼び出し側で明示する。

enable_testing()
add_test(NAME core_test COMMAND core_test)
