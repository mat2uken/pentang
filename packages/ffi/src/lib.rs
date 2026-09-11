//! Tauri非依存のsafe FFI。unsafeなC ABI宣言はprivateに封じる。
//! C++側の予期しないstatusはCORE_FAILUREとして扱う。

pub mod wire;

use std::ffi::CStr;
use std::os::raw::c_char;

const MAX_VALUES: usize = 4096;

// C ABI宣言はprivateにまとめる (Rust 2024の `unsafe extern "C"` に合わせる)
mod ffi {
    use std::os::raw::{c_char, c_int};

    unsafe extern "C" {
        pub fn poc_core_abi_version() -> u32;
        pub fn poc_core_version() -> *const c_char;
        pub fn poc_transform_i32(
            input: *const c_int,
            count: u32,
            multiplier: c_int,
            offset: c_int,
            output: *mut c_int,
            output_capacity: u32,
            checksum: *mut u32,
        ) -> c_int;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreInfo {
    pub abi_version: u32,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformResult {
    pub values: Vec<i32>,
    pub checksum: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    LimitExceeded(String),
    OutOfMemory(String),
    CoreFailure(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::LimitExceeded(_) => "LIMIT_EXCEEDED",
            CoreError::OutOfMemory(_) => "OUT_OF_MEMORY",
            CoreError::CoreFailure(_) => "CORE_FAILURE",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            CoreError::LimitExceeded(m)
            | CoreError::OutOfMemory(m)
            | CoreError::CoreFailure(m) => m,
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for CoreError {}

pub fn get_info() -> Result<CoreInfo, CoreError> {
    // SAFETY: C関数はグローバル状態を持たず、callerのメモリを保持しない。
    // 版文字列は静的UTF-8で、解放せずコピーする。
    let abi = unsafe { ffi::poc_core_abi_version() };
    let ptr = unsafe { ffi::poc_core_version() };
    if ptr.is_null() {
        return Err(CoreError::CoreFailure(
            "poc_core_version returned null".to_string(),
        ));
    }
    // SAFETY: NUL終端であることがC headerの契約。UTF-8不正は契約違反として失敗させる。
    // lossy変換で黙って化けさせるより、CORE_FAILUREで検知できる方を採る。
    let version = unsafe {
        CStr::from_ptr(ptr as *const c_char)
            .to_str()
            .map_err(|_| CoreError::CoreFailure("poc_core_version is not valid UTF-8".to_string()))?
            .to_owned()
    };
    Ok(CoreInfo {
        abi_version: abi,
        version,
    })
}

pub fn transform(
    input: &[i32],
    multiplier: i32,
    offset: i32,
) -> Result<TransformResult, CoreError> {
    if input.len() > MAX_VALUES {
        return Err(CoreError::LimitExceeded(format!(
            "values length {} exceeds {}",
            input.len(),
            MAX_VALUES
        )));
    }
    let count = input.len() as u32;
    // 出力Vecはtry_reserve_exactで確保失敗を捕捉し、resizeで初期化してからpointerを渡す。
    // 未初期化の要素を安全なsliceとして扱わない。
    let mut output: Vec<i32> = Vec::new();
    if count > 0 {
        output
            .try_reserve_exact(input.len())
            .map_err(|_| {
                CoreError::OutOfMemory("output allocation failed".to_string())
            })?;
        output.resize(input.len(), 0);
    }
    let mut checksum: u32 = 0;

    // count==0ではinput/outputにNULLを渡せる。checksumは有効な1要素が必要。
    let (in_ptr, out_ptr) = if count == 0 {
        (std::ptr::null(), std::ptr::null_mut())
    } else {
        (input.as_ptr(), output.as_mut_ptr())
    };

    // SAFETY: callerは実際に有効な整列領域を用意し、input/output/checksumを重ねない。
    // Cはpointerを保持しない。全検査後に呼び出す。
    let status = unsafe {
        ffi::poc_transform_i32(
            in_ptr,
            count,
            multiplier,
            offset,
            out_ptr,
            count,
            &mut checksum as *mut u32,
        )
    };
    if status == 0 {
        Ok(TransformResult {
            values: output,
            checksum,
        })
    } else {
        // 検証済み引数でCが非0を返した場合はwrapper不具合としてCORE_FAILURE。
        // callerの入力不正はこの層より前 (TS/Rust command) で拒否する。
        Err(CoreError::CoreFailure(format!(
            "poc_transform_i32 unexpected status={status}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_matches_core() {
        let info = get_info().expect("get_info");
        assert_eq!(info.abi_version, 1);
        assert_eq!(info.version, "0.1.0");
    }

    #[test]
    fn empty_transform() {
        let r = transform(&[], 1, 0).expect("empty");
        assert_eq!(r.values, Vec::<i32>::new());
        assert_eq!(r.checksum, 0);
    }

    #[test]
    fn too_long_is_limit() {
        let v = vec![1i32; 4097];
        let e = transform(&v, 1, 0).expect_err("must fail");
        assert_eq!(e.code(), "LIMIT_EXCEEDED");
    }

    #[test]
    fn input_not_mutated_output_independent() {
        let input = vec![1, 2, 3];
        let r = transform(&input, 2, 1).expect("basic");
        assert_eq!(input, vec![1, 2, 3]);
        assert_eq!(r.values, vec![3, 5, 7]);
        assert_eq!(r.checksum, 15);
    }
}
