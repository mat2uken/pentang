//! IPC DTO、validation、エラー変換。C++計算をRustへ再実装しない。
use serde::{Deserialize, Serialize};

// 公開field名はcamelCaseへ揃え、snake_caseをwireへ出さない。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfoDto {
    pub abi_version: u32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfoDto {
    pub api_version: u32,
    pub backend: String,
    pub host_os: String,
    pub execution: String,
    pub core: CoreInfoDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransformResultDto {
    pub values: Vec<i32>,
    pub checksum: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppErrorDto {
    pub code: String,
    pub message: String,
}

impl AppErrorDto {
    pub fn new(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            message,
        }
    }

    fn invalid(msg: String) -> Self {
        Self::new("INVALID_ARGUMENT", msg)
    }

    fn limit(msg: String) -> Self {
        Self::new("LIMIT_EXCEEDED", msg)
    }
}

pub const APPLICATION_API_VERSION: u32 = 1;
pub const MAX_VALUES: usize = 4096;
const INT32_MIN_I64: i64 = i32::MIN as i64;
const INT32_MAX_I64: i64 = i32::MAX as i64;

fn host_os() -> String {
    // 未対応OSを別OS名へ偽装せず、呼び出し側で初期化失敗にできるよう実値を返す。
    // Tauriが対応する主要OSのみ写像し、それ以外はstdのOS名をそのまま返す。
    #[cfg(target_os = "macos")]
    return "macos".to_string();
    #[cfg(target_os = "windows")]
    return "windows".to_string();
    #[cfg(target_os = "ios")]
    return "ios".to_string();
    #[cfg(target_os = "android")]
    return "android".to_string();
    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "ios",
        target_os = "android"
    )))]
    return std::env::consts::OS.to_string();
}

// JSON数値をint32として解釈する。1.0/-0は値として受理し、内部表現だけを理由に拒否しない。
fn as_int32(v: &serde_json::Value) -> Option<i32> {
    match v {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if (INT32_MIN_I64..=INT32_MAX_I64).contains(&i) {
                    return Some(i as i32);
                } else {
                    return None;
                }
            }
            // u64分岐は置かない。i64に収まる整数はas_i64で先に受理/拒否が決まり、
            // as_u64に届くのはi64に収まらない巨大値だけでint32範囲外が確定するため。
            // (巨大u64はf64経路でも範囲外で拒否される)
            if let Some(f) = n.as_f64() {
                if !f.is_finite() {
                    return None;
                }
                // -0.0は0として受理
                if f == 0.0 {
                    return Some(0);
                }
                if f.fract() != 0.0 {
                    return None;
                }
                if f < INT32_MIN_I64 as f64 || f > INT32_MAX_I64 as f64 {
                    return None;
                }
                return Some(f as i32);
            }
            None
        }
        _ => None,
    }
}

// request: serde_json::Valueで受けて明示的に検査する。
// 検査順は docs/plan/04-contracts.md に合わせる:
// 必須field存在→values配列→長さ→各要素/multiplier/offsetのint32性。
// 未知fieldはINVALID_ARGUMENT。疎配列はJSON化時点でnull等になるためINVALID。
// serde_json::Mapは所有fieldのみ持つため、所有検査はcontains_keyで十分。
pub fn validate_transform_request(
    request: &serde_json::Value,
) -> Result<(Vec<i32>, i32, i32), AppErrorDto> {
    // 2. requestはnullでないobjectかつarrayではない。必須fieldを持ち、未知fieldは拒否。
    // serde_jsonのis_objectはarray・null・数値等をすべて偽にする。
    if !request.is_object() {
        return Err(AppErrorDto::invalid(
            "request must be a plain object".to_string(),
        ));
    }
    let obj = request.as_object().expect("object");
    for key in ["values", "multiplier", "offset"] {
        if !obj.contains_key(key) {
            return Err(AppErrorDto::invalid(format!("missing field: {key}")));
        }
    }
    for key in obj.keys() {
        if key != "values" && key != "multiplier" && key != "offset" {
            return Err(AppErrorDto::invalid(format!("unknown field: {key}")));
        }
    }
    // 自身の必須fieldを要求 (prototype汚染等のJS側はTSで検査し、ここでは所有fieldのみ見る。
    // serde_json::Mapは所有fieldのみなので、この時点で満たす)。

    // 3. valuesは通常のArray。長さ4096超はLIMIT_EXCEEDED。
    let arr = obj["values"].as_array().ok_or_else(|| {
        AppErrorDto::invalid("values must be an array".to_string())
    })?;
    if arr.len() > MAX_VALUES {
        return Err(AppErrorDto::limit(format!(
            "values length {} exceeds {}",
            arr.len(),
            MAX_VALUES
        )));
    }
    // 4. 全indexが自身の要素として存在し、要素・multiplier・offsetがint32であること。
    // JSON配列は密であり、欠落はnull等として現れるためas_int32で拒否する。
    let mut values: Vec<i32> = Vec::with_capacity(arr.len());
    for (i, el) in arr.iter().enumerate() {
        match as_int32(el) {
            Some(v) => values.push(v),
            None => {
                return Err(AppErrorDto::invalid(format!(
                    "values[{i}] must be an int32 integer"
                )))
            }
        }
    }
    let multiplier = match as_int32(&obj["multiplier"]) {
        Some(v) => v,
        None => {
            return Err(AppErrorDto::invalid(
                "multiplier must be an int32 integer".to_string(),
            ))
        }
    };
    let offset = match as_int32(&obj["offset"]) {
        Some(v) => v,
        None => {
            return Err(AppErrorDto::invalid(
                "offset must be an int32 integer".to_string(),
            ))
        }
    };
    Ok((values, multiplier, offset))
}

pub fn build_runtime_info() -> Result<RuntimeInfoDto, AppErrorDto> {
    let info = core_ffi::get_info()
        .map_err(|e| AppErrorDto::new("CORE_FAILURE", format!("ffi get_info failed: {e}")))?;
    Ok(RuntimeInfoDto {
        api_version: APPLICATION_API_VERSION,
        backend: "tauri-native".to_string(),
        host_os: host_os(),
        execution: "native-ffi".to_string(),
        core: CoreInfoDto {
            abi_version: info.abi_version,
            version: info.version,
        },
    })
}

// Tauri commands。Result<成功DTO, AppError>を返す。
#[tauri::command]
pub fn core_get_info() -> Result<RuntimeInfoDto, AppErrorDto> {
    build_runtime_info()
}

#[tauri::command]
pub fn core_transform(request: serde_json::Value) -> Result<TransformResultDto, AppErrorDto> {
    let (values, multiplier, offset) = validate_transform_request(&request)?;
    let r = core_ffi::transform(&values, multiplier, offset).map_err(|e| {
        match e {
            core_ffi::CoreError::LimitExceeded(m) => AppErrorDto::limit(m),
            core_ffi::CoreError::OutOfMemory(m) => {
                AppErrorDto::new("OUT_OF_MEMORY", m)
            }
            core_ffi::CoreError::CoreFailure(m) => {
                AppErrorDto::new("CORE_FAILURE", m)
            }
        }
    })?;
    Ok(TransformResultDto {
        values: r.values,
        checksum: r.checksum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_basic_passes() {
        let req = json!({"values": [1,2,3], "multiplier": 2, "offset": 1});
        let (v, m, o) = validate_transform_request(&req).expect("valid");
        assert_eq!(v, vec![1, 2, 3]);
        assert_eq!(m, 2);
        assert_eq!(o, 1);
    }

    #[test]
    fn unknown_field_rejected() {
        let req = json!({"values": [1], "multiplier": 1, "offset": 0, "extra": 1});
        let e = validate_transform_request(&req).expect_err("extra");
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn missing_field_before_length() {
        // offset欠落 + values長4097 → 必須field検査が先でINVALID
        let big = vec![1; 4097];
        let req = json!({"values": big, "multiplier": 1});
        let e = validate_transform_request(&req).expect_err("missing");
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn length_before_value() {
        // values長4097 + multiplier小数 → 長さ検査が先でLIMIT
        let big = vec![1; 4097];
        let req = json!({"values": big, "multiplier": 0.5, "offset": 0});
        let e = validate_transform_request(&req).expect_err("long");
        assert_eq!(e.code, "LIMIT_EXCEEDED");
    }

    #[test]
    fn float_one_and_minus_zero_accepted() {
        let req = json!({"values": [-0.0, 1.0], "multiplier": 1.0, "offset": -0.0});
        let (v, m, o) = validate_transform_request(&req).expect("accept");
        assert_eq!(v, vec![0, 1]);
        assert_eq!(m, 1);
        assert_eq!(o, 0);
    }

    #[test]
    fn fractional_offset_rejected() {
        let req = json!({"values": [1], "multiplier": 1, "offset": 0.5});
        let e = validate_transform_request(&req).expect_err("fraction");
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn out_of_range_rejected() {
        for v in [2147483648i64, -2147483649i64] {
            let req = json!({"values": [1], "multiplier": 1, "offset": v});
            let e = validate_transform_request(&req).expect_err("range");
            assert_eq!(e.code, "INVALID_ARGUMENT");
        }
    }

    #[test]
    fn sparse_like_null_rejected() {
        let req = json!({"values": [1, null], "multiplier": 1, "offset": 0});
        let e = validate_transform_request(&req).expect_err("null");
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn serialization_is_camel_case() {
        let info = build_runtime_info().expect("info");
        let s = serde_json::to_string(&info).expect("json");
        assert!(s.contains("apiVersion"), "missing apiVersion: {s}");
        assert!(s.contains("hostOs"), "missing hostOs: {s}");
        assert!(s.contains("abiVersion"), "missing abiVersion: {s}");
        assert!(!s.contains("api_version"), "snake_case leaked: {s}");
        assert!(!s.contains("host_os"), "snake_case leaked: {s}");
    }

    #[test]
    fn transform_end_to_end_basic() {
        let req = json!({"values": [1,2,3], "multiplier": 2, "offset": 1});
        let r = core_transform(req).expect("transform");
        assert_eq!(r.values, vec![3, 5, 7]);
        assert_eq!(r.checksum, 15);
    }
}
