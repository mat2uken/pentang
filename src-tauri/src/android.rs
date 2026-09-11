//! Android WebMessagePort受け口 (JNI)。
//!
//! Kotlin側 `CorebinPort` (addWebMessageListener) からのみ呼ぶ。JSが
//! `window.corebin.postMessage(ArrayBuffer)` で送った生バイトを受け、
//! 共通 `process_batch` で処理して応答バイト列を返す。検証・計算の
//! 二重実装はしない (C++計算をRustへ再実装しない契約を維持)。
//!
//! スレッド方針: リスナーはWebViewメインスレッドで呼ばれる。`process_batch`
//! は数十μs級 (実測) のため同期呼び出しでframe budget内に収まる。
//! 失敗時はnullを返し、Kotlin側が空応答で速やかに失敗させる
//! (JS側はTRANSPORT_ERRORとして扱い、無応答タイムアウトにしない)。
//! エラー種別の粒度 (単発/致命) は正規経路では到達不能なため落とす。
//! 不正入力は壊れた応答として扱う (fail-closed)。

#![cfg(target_os = "android")]

use jni::{
    objects::{JByteArray, JObject},
    sys::jbyteArray,
    JNIEnv,
};

/// wire要求batch (u8) -> wire応答batch (u8)。失敗時はnull。
#[unsafe(no_mangle)]
pub extern "C" fn Java_dev_example_commoncorepoc_CorebinPort_handleBatch(
    mut env: JNIEnv<'_>,
    _this: JObject<'_>,
    input: JByteArray<'_>,
) -> jbyteArray {
    let out: Vec<u8> = match env
        .convert_byte_array(&input)
        .map_err(|e| crate::commands::AppErrorDto::new("TRANSPORT_ERROR", e.to_string()))
        .and_then(|bytes| crate::batch::process_batch(&bytes))
    {
        Ok(bytes) => bytes,
        Err(_) => return std::ptr::null_mut(),
    };
    env.byte_array_from_slice(&out)
        .map(|arr| arr.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
