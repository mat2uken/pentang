//! バイナリデータプレーンの共通処理。
//! wireフレームの連結batchを受けて1フレームずつ処理し、応答フレームの連結を返す。
//! `poc_transform_bin` invokeコマンドと `pocbin:` schemeハンドラの両方から使う
//! single source of truth。C++計算をRustへ再実装しない。
//!
//! メモリ方針: 応答は件数が確定してからではなく1フレームずつ追記する (Vecの
//! 指数成長に任せ、件数ぶんの事前走査＝入力2走査を避ける)。要求valuesと
//! 計算出力はFFI境界でi32連続領域が要るため各1回の複写は不可避で、以下に集約する。

use crate::commands::AppErrorDto;
use poc_core_ffi::wire;

fn wire_err_to_app(e: wire::WireError) -> AppErrorDto {
    match e {
        // 長さ超過だけLIMIT。それ以外のwire不正 (magic・形・断片) はINVALID。
        wire::WireError::LimitExceeded => AppErrorDto::new(
            "LIMIT_EXCEEDED",
            "wire frame exceeds limits".to_string(),
        ),
        other => AppErrorDto::new(
            "INVALID_ARGUMENT",
            format!("invalid wire frame: {other}"),
        ),
    }
}

fn core_err_to_app(e: poc_core_ffi::CoreError) -> AppErrorDto {
    match e {
        poc_core_ffi::CoreError::LimitExceeded(m) => AppErrorDto::new("LIMIT_EXCEEDED", m),
        poc_core_ffi::CoreError::OutOfMemory(m) => AppErrorDto::new("OUT_OF_MEMORY", m),
        poc_core_ffi::CoreError::CoreFailure(m) => AppErrorDto::new("CORE_FAILURE", m),
    }
}

/// wire要求batchを処理する。空batchはINVALID。成功時は応答batchの生バイト。
pub fn process_batch(input: &[u8]) -> Result<Vec<u8>, AppErrorDto> {
    if input.is_empty() {
        return Err(AppErrorDto::new(
            "INVALID_ARGUMENT",
            "empty batch".to_string(),
        ));
    }
    let mut out: Vec<u8> = Vec::new();
    let mut off = 0;
    while off < input.len() {
        // 先頭フレームの検査と切出し。断片はここでINVALIDになる。
        let (header, _payload, frame_len) =
            wire::next_frame(&input[off..]).map_err(wire_err_to_app)?;
        let frame = &input[off..off + frame_len];
        match header.command {
            wire::CMD_TRANSFORM => append_transform(frame, &mut out)?,
            wire::CMD_GET_INFO => append_get_info(frame, &mut out)?,
            // next_frame通過時点でcommandはtransform/getInfoのいずれか。未知値は来ない。
            _ => {
                return Err(AppErrorDto::new(
                    "INVALID_ARGUMENT",
                    "unknown command".to_string(),
                ))
            }
        }
        off += frame_len;
    }
    Ok(out)
}

fn append_transform(frame: &[u8], out: &mut Vec<u8>) -> Result<(), AppErrorDto> {
    let d = wire::decode_transform_request(frame).map_err(wire_err_to_app)?;
    // FFIは連続i32領域を要求するためここで1回だけ実体化する。
    let values = d.to_vec();
    let r = poc_core_ffi::transform(&values, d.multiplier, d.offset).map_err(core_err_to_app)?;
    let need = wire::WIRE_SIZE + 8 + r.values.len() * 4;
    let start = out.len();
    // SAFETY: 直後のencodeがneed全バイト (header+count+checksum+values) を
    // 上書きするためゼロ初期化しない。失敗時はtruncateで巻き戻す。
    #[allow(clippy::uninit_vec)]
    unsafe {
        out.reserve(need);
        out.set_len(start + need);
    }
    if let Err(e) =
        wire::encode_transform_response(&mut out[start..], d.sequence, 0, &r.values, r.checksum)
    {
        out.truncate(start);
        return Err(wire_err_to_app(e));
    }
    Ok(())
}

fn append_get_info(frame: &[u8], out: &mut Vec<u8>) -> Result<(), AppErrorDto> {
    let h = wire::decode_header(frame).map_err(wire_err_to_app)?;
    if h.payload_len != 0 {
        return Err(AppErrorDto::new(
            "INVALID_ARGUMENT",
            "getInfo request must be empty".to_string(),
        ));
    }
    let info = poc_core_ffi::get_info().map_err(core_err_to_app)?;
    let version = info.version.as_bytes();
    let need = wire::WIRE_SIZE + 8 + version.len();
    let start = out.len();
    // SAFETY: append_transformと同理由 (encodeが全バイト上書き・失敗時truncate)。
    #[allow(clippy::uninit_vec)]
    unsafe {
        out.reserve(need);
        out.set_len(start + need);
    }
    if let Err(e) =
        wire::encode_get_info_response(&mut out[start..], h.sequence, info.abi_version, version)
    {
        out.truncate(start);
        return Err(wire_err_to_app(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    /// 計数アロケータ (bench時の確保量計測用。testビルドのみ有効)。
    struct CountingAlloc;
    static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

    unsafe impl GlobalAlloc for CountingAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
    }

    #[global_allocator]
    static GLOBAL_ALLOC: CountingAlloc = CountingAlloc;

    fn reset_alloc() {
        ALLOCATED.store(0, Ordering::Relaxed);
    }

    fn read_alloc() -> usize {
        ALLOCATED.load(Ordering::Relaxed)
    }

    fn req_frame(seq: u16, values: &[i32], mul: i32, off: i32) -> Vec<u8> {
        let need = wire::WIRE_SIZE + 12 + values.len() * 4;
        let mut buf = vec![0u8; need];
        let n = wire::encode_transform_request(&mut buf, seq, 0, values, mul, off).expect("enc");
        buf.truncate(n);
        buf
    }

    #[test]
    fn single_transform_round_trip() {
        let out = process_batch(&req_frame(9, &[1, 2, 3], 2, 1)).expect("batch");
        let d = wire::decode_transform_response(&out).expect("dec");
        assert_eq!(d.sequence, 9);
        assert_eq!(d.checksum, 15);
        assert_eq!(d.to_vec(), vec![3, 5, 7]);
    }

    #[test]
    fn multi_frame_batch_preserves_order() {
        let mut batch = req_frame(1, &[1], 1, 0);
        batch.extend_from_slice(&req_frame(2, &[2, 3], 2, 1));
        let out = process_batch(&batch).expect("batch");
        // 応答を順走査して2件を確認する。
        let (h1, _, f1) = wire::next_frame(&out).expect("f1");
        assert_eq!(h1.sequence, 1);
        let rest = &out[f1..];
        let (h2, _, f2) = wire::next_frame(rest).expect("f2");
        assert_eq!(h2.sequence, 2);
        assert_eq!(f1 + f2, out.len());
        let d2 = wire::decode_transform_response(rest).expect("dec2");
        assert_eq!(d2.to_vec(), vec![5, 7]);
    }

    #[test]
    fn get_info_frame_returns_version() {
        let mut q = vec![0u8; wire::WIRE_SIZE];
        let n = wire::encode_get_info_request(&mut q, 4).expect("enc");
        q.truncate(n);
        let out = process_batch(&q).expect("batch");
        let d = wire::decode_get_info_response(&out).expect("dec");
        assert_eq!(d.sequence, 4);
        assert_eq!(d.abi_version, 1);
        assert_eq!(d.version_bytes, b"0.1.0");
    }

    #[test]
    fn empty_and_garbage_rejected() {
        assert_eq!(
            process_batch(&[]).expect_err("empty").code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            process_batch(&[0u8; 8]).expect_err("short").code,
            "INVALID_ARGUMENT"
        );
        let mut bad = req_frame(1, &[1], 1, 0);
        bad[0] ^= 0xff;
        assert_eq!(
            process_batch(&bad).expect_err("magic").code,
            "INVALID_ARGUMENT"
        );
        // 末尾断片。
        let mut batch = req_frame(1, &[1, 2], 1, 0);
        batch.extend_from_slice(&req_frame(2, &[3], 1, 0)[..10]);
        assert_eq!(
            process_batch(&batch).expect_err("trunc").code,
            "INVALID_ARGUMENT"
        );
    }

    // ハンドラ層ベンチ: JSON既存経路 vs wire vs b64 の Rust 側コスト。
    // `cargo test --release -p poc-app --lib bench_ipc_paths -- --nocapture` で実行。
    // PENTANG_BENCH_OUT にパスを渡すとJSONも保存する。
    #[test]
    fn bench_ipc_paths() {
        use base64::Engine as _;
        use serde_json::json;

        fn values(n: usize) -> Vec<i32> {
            (0..n)
                .map(|i| match i % 8 {
                    0 => i32::MAX,
                    1 => i32::MIN,
                    2 => -(i as i32),
                    3 => 0,
                    _ => (i as i32).wrapping_mul(7919) % 100000,
                })
                .collect()
        }

        fn timeit<F: FnMut()>(mut f: F, iters: usize) -> f64 {
            for _ in 0..5.min(iters) {
                f();
            }
            let t0 = Instant::now();
            for _ in 0..iters {
                f();
            }
            t0.elapsed().as_secs_f64() * 1e6 / iters as f64
        }

        let mut rows = Vec::new();
        for &n in &[3usize, 256, 1024, 4096] {
            let iters = if n <= 3 { 2000 } else if n <= 256 { 800 } else if n <= 1024 { 200 } else { 60 };
            let v = values(n);
            // JSON要求を事前構築 (handler計測では毎回cloneして渡す)。
            let json_req = json!({"values": v.clone(), "multiplier": 2, "offset": 1});
            let json_req_str = serde_json::to_string(&json_req).unwrap();
            let wire_req = {
                let need = wire::WIRE_SIZE + 12 + n * 4;
                let mut buf = vec![0u8; need];
                let m = wire::encode_transform_request(&mut buf, 1, 0, &v, 2, 1).unwrap();
                buf.truncate(m);
                buf
            };
            let b64_req =
                base64::engine::general_purpose::STANDARD.encode(&wire_req);

            // 正当性の相互確認 (3経路の計算一致)。
            let r_json = crate::commands::poc_transform(json_req.clone()).expect("json");
            let r_b64 = crate::commands::poc_transform_bin(b64_req.clone()).expect("b64");
            let r_wire = process_batch(&wire_req).expect("wire");
            let d_wire = wire::decode_transform_response(&r_wire).expect("dec");
            let b64_resp_bytes =
                base64::engine::general_purpose::STANDARD.decode(&r_b64).unwrap();
            let d_b64 = wire::decode_transform_response(&b64_resp_bytes).expect("dec64");
            assert_eq!(r_json.values, d_wire.to_vec());
            assert_eq!(r_json.checksum, d_wire.checksum);
            assert_eq!(r_json.values, d_b64.to_vec());

            let json_us = timeit(
                || {
                    let r = crate::commands::poc_transform(json_req.clone()).unwrap();
                    let _ = serde_json::to_string(&r).unwrap();
                },
                iters,
            );
            // 確保量: 同一opをQC回回して総確保量を割る (解放は数えない=一時的到達量)。
            fn alloc_per_op(iters: usize, mut f: impl FnMut()) -> f64 {
                reset_alloc();
                for _ in 0..iters {
                    f();
                }
                read_alloc() as f64 / iters as f64
            }
            let json_alloc = alloc_per_op(iters, || {
                let r = crate::commands::poc_transform(json_req.clone()).unwrap();
                let _ = serde_json::to_string(&r).unwrap();
            });
            let wire_alloc = alloc_per_op(iters, || {
                let _ = process_batch(&wire_req).unwrap();
            });
            let b64_alloc = alloc_per_op(iters, || {
                let _ = crate::commands::poc_transform_bin(b64_req.clone()).unwrap();
            });
            let wire_us = timeit(
                || {
                    let _ = process_batch(&wire_req).unwrap();
                },
                iters,
            );
            let b64_us = timeit(
                || {
                    let _ = crate::commands::poc_transform_bin(b64_req.clone()).unwrap();
                },
                iters,
            );
            // 内訳: JSON validateのみ / wire decodeのみ。
            let json_validate_us = timeit(
                || {
                    let _ = crate::commands::validate_transform_request(&json_req).unwrap();
                },
                iters,
            );
            let wire_decode_us = timeit(
                || {
                    let d = wire::decode_transform_request(&wire_req).unwrap();
                    let _ = d.to_vec();
                },
                iters,
            );
            rows.push(serde_json::json!({
                "n": n,
                "iters": iters,
                "reqBytes": {"json": json_req_str.len(), "wire": wire_req.len(), "b64": b64_req.len()},
                "handlerUs": {"json": json_us, "wire": wire_us, "b64": b64_us},
                "decodeUs": {"jsonValidate": json_validate_us, "wireDecode": wire_decode_us},
                "allocBytesPerOp": {"json": json_alloc, "wire": wire_alloc, "b64": b64_alloc},
            }));
        }
        println!("| N | req bytes json/wire/b64 | handler μs json | wire | b64 | decode内訳 json/wire μs | alloc/op B json/wire/b64 |");
        println!("|---|---|---|---|---|---|---|");
        for r in &rows {
            println!(
                "| {} | {}/{}/{} | {:.2} | {:.2} | {:.2} | {:.2}/{:.2} | {:.0}/{:.0}/{:.0} |",
                r["n"],
                r["reqBytes"]["json"],
                r["reqBytes"]["wire"],
                r["reqBytes"]["b64"],
                r["handlerUs"]["json"],
                r["handlerUs"]["wire"],
                r["handlerUs"]["b64"],
                r["decodeUs"]["jsonValidate"],
                r["decodeUs"]["wireDecode"],
                r["allocBytesPerOp"]["json"],
                r["allocBytesPerOp"]["wire"],
                r["allocBytesPerOp"]["b64"],
            );
        }
        if let Ok(path) = std::env::var("PENTANG_BENCH_OUT") {
            let doc = serde_json::json!({
                "tool": "batch::bench_ipc_paths",
                "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
                "rows": rows,
            });
            std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n")
                .expect("write bench json");
            println!("saved: {path}");
        }
    }
}
