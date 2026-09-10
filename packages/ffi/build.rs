use std::path::PathBuf;

fn main() {
    // CARGO_MANIFEST_DIR からsource/headerの絶対pathを組み立てる
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = PathBuf::from(&manifest_dir).join("..").join("..");
    let src = root.join("packages/core/src/core.cpp");
    let include = root.join("packages/core/include");

    assert!(src.exists(), "missing {}", src.display());
    assert!(include.exists(), "missing {}", include.display());

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", include.join("poc_core.h").display());
    // TARGET / OUT_DIR はccが利用する。verboseログでcompiler引数を確認する。
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:warning=poc-core-ffi target={target}");
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .file(&src)
        .include(&include)
        .compile("poc_core");
}
