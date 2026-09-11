//! repositoryの単一fixtureを参照するgolden試験。同じJSONの別コピーを持たない。
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Golden {
    #[serde(default)]
    valid: Vec<ValidCase>,
    #[serde(default, rename = "generatedCases")]
    generated: Vec<GeneratedCase>,
}

#[derive(Debug, Deserialize)]
struct ValidCase {
    id: String,
    request: Req,
    expected: Exp,
}

#[derive(Debug, Deserialize)]
struct Req {
    values: Vec<i32>,
    multiplier: i32,
    offset: i32,
}

#[derive(Debug, Deserialize)]
struct Exp {
    values: Vec<i32>,
    checksum: u32,
}

#[derive(Debug, Deserialize)]
struct GeneratedCase {
    id: String,
    #[serde(default, rename = "repeatValue")]
    repeat_value: Option<i32>,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    multiplier: Option<i32>,
    #[serde(default)]
    offset: Option<i32>,
    #[serde(default, rename = "expectedValue")]
    expected_value: Option<i32>,
    #[serde(default, rename = "expectedChecksum")]
    expected_checksum: Option<u32>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages/api/fixtures/golden-vectors.json")
}

#[test]
fn golden_vectors_match_ffi() {
    let path = fixture_path();
    assert!(path.exists(), "missing {}", path.display());
    let raw = std::fs::read_to_string(&path).expect("read fixture");
    let golden: Golden = serde_json::from_str(&raw).expect("parse fixture");

    // valid 10件
    assert_eq!(golden.valid.len(), 10, "valid must be 10");
    for case in &golden.valid {
        let r = core_ffi::transform(
            &case.request.values,
            case.request.multiplier,
            case.request.offset,
        )
        .unwrap_or_else(|e| panic!("{} failed: {e}", case.id));
        assert_eq!(r.values, case.expected.values, "{} values", case.id);
        assert_eq!(r.checksum, case.expected.checksum, "{} checksum", case.id);
        // 入力不変
        let _ = &case.request.values;
    }

    // 生成4096ケースを展開
    let max = golden
        .generated
        .iter()
        .find(|c| c.id == "maximum-length")
        .expect("maximum-length");
    let count = max.count.unwrap();
    let rep = max.repeat_value.unwrap();
    let mul = max.multiplier.unwrap();
    let off = max.offset.unwrap();
    let input = vec![rep; count];
    let r = core_ffi::transform(&input, mul, off).expect("maximum-length");
    assert_eq!(r.values.len(), count);
    assert!(r.values.iter().all(|&v| v == max.expected_value.unwrap()));
    assert_eq!(r.checksum, max.expected_checksum.unwrap());

    // too-longはLIMIT
    let too_long = golden
        .generated
        .iter()
        .find(|c| c.id == "too-long")
        .expect("too-long");
    let input2 = vec![1i32; too_long.count.unwrap()];
    let e = core_ffi::transform(&input2, 1, 0).expect_err("too-long must fail");
    assert_eq!(e.code(), "LIMIT_EXCEEDED");
}

#[test]
fn core_info_matches_header() {
    let info = core_ffi::get_info().expect("get_info");
    assert_eq!(info.abi_version, 1);
    assert_eq!(info.version, "0.1.0");
}
