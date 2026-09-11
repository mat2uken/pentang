use std::env;
use std::fs;
use std::path::PathBuf;

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn explicit_compiler_is_configured(target: &str) -> bool {
    // cc-rs supports both a target-specific CXX_<target> variable and the
    // generic CXX override. Leave either one untouched so CI/toolchain users
    // retain control over their compiler wrapper.
    [format!("CXX_{target}"), "CXX".to_string()]
        .iter()
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
}

fn host_tags() -> &'static [&'static str] {
    match env::consts::OS {
        "macos" => &["darwin-arm64", "darwin-x86_64"],
        "linux" => &["linux-x86_64", "linux-aarch64"],
        "windows" => &["windows-x86_64"],
        _ => &[],
    }
}

fn sdk_root() -> Option<PathBuf> {
    let configured = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .find_map(|name| env_path(name));
    if configured.is_some() {
        return configured;
    }

    // Android Studio's default macOS location is used when the build is
    // launched by a GUI/Gradle process that did not export ANDROID_HOME.
    // Keep this as a discovery fallback; explicit environment variables win.
    let home = env_path("HOME")?;
    [
        home.join("Library/Android/sdk"),
        home.join("Android/Sdk"),
        home.join("AppData/Local/Android/Sdk"),
    ]
    .into_iter()
    .find(|path| path.join("ndk").is_dir())
}

fn ndk_root() -> Option<PathBuf> {
    if let Some(path) = ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"]
        .iter()
        .find_map(|name| env_path(name))
    {
        return Some(path);
    }

    let sdk = sdk_root()?;
    let ndk_dir = sdk.join("ndk");
    let requested = env::var_os("ANDROID_NDK_VERSION").map(PathBuf::from);
    if let Some(version) = requested {
        let candidate = ndk_dir.join(version);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    let mut versions = fs::read_dir(ndk_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort();
    versions.pop()
}

fn configured_api_level(manifest_dir: &str) -> String {
    if let Some(value) = env::var_os("ANDROID_NDK_API_LEVEL") {
        if !value.is_empty() {
            return value.to_string_lossy().into_owned();
        }
    }

    // Keep the build aligned with the repository's pinned Android settings
    // without adding a JSON parser to this tiny build script.
    let lock = PathBuf::from(manifest_dir)
        .join("..")
        .join("..")
        .join("toolchains.lock.json");
    if let Ok(text) = fs::read_to_string(lock) {
        if let Some(start) = text.find("\"ndkApiLevel\"") {
            let digits = text[start..]
                .chars()
                .skip_while(|character| !character.is_ascii_digit())
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>();
            if !digits.is_empty() {
                return digits;
            }
        }
    }
    "24".to_string()
}

struct AndroidTools {
    compiler: PathBuf,
    archiver: PathBuf,
}

fn android_tools(target: &str, manifest_dir: &str) -> Result<Option<AndroidTools>, String> {
    if !target.ends_with("-android") && target != "armv7-linux-androideabi" {
        return Ok(None);
    }
    if explicit_compiler_is_configured(target) {
        return Ok(None);
    }

    let triple = target;
    let ndk = ndk_root().ok_or_else(|| {
        "Android target detected, but no NDK was found. Set ANDROID_NDK_HOME or ANDROID_HOME."
            .to_string()
    })?;
    let prebuilt_root = ndk.join("toolchains").join("llvm").join("prebuilt");
    let mut prebuilts = fs::read_dir(&prebuilt_root)
        .map_err(|error| format!("cannot read {}: {error}", prebuilt_root.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    prebuilts.sort_by_key(|path| {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        host_tags()
            .iter()
            .position(|tag| *tag == name)
            .unwrap_or(host_tags().len())
    });

    let api = configured_api_level(manifest_dir);
    for prebuilt in prebuilts {
        let bin = prebuilt.join("bin");
        let preferred = bin.join(format!("{triple}{api}-clang++"));
        let compiler = if preferred.is_file() {
            Some(preferred)
        } else {
            // NDK revisions can expose a different API-level range. Choose the
            // lowest available version rather than an unversioned name that
            // recent NDKs no longer ship.
            let mut candidates = fs::read_dir(&bin)
                .ok()
                .into_iter()
                .flat_map(|entries| entries.filter_map(Result::ok))
                .map(|entry| entry.path())
                .filter(|path| {
                    let name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default();
                    name.starts_with(triple) && name.ends_with("-clang++")
                })
                .collect::<Vec<_>>();
            candidates.sort();
            candidates.into_iter().next()
        };
        if let Some(compiler) = compiler {
            let archiver = [bin.join(format!("{triple}-ar")), bin.join("llvm-ar")]
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| format!("no Android archiver found under {}", bin.display()))?;
            return Ok(Some(AndroidTools { compiler, archiver }));
        }
    }

    Err(format!(
        "no Android C++ compiler found for {target} under {}",
        ndk.display()
    ))
}

fn main() {
    // CARGO_MANIFEST_DIR からsource/headerの絶対pathを組み立てる
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = PathBuf::from(&manifest_dir).join("..").join("..");
    let src = root.join("packages/core/src/core.cpp");
    let include = root.join("packages/core/include");

    assert!(src.exists(), "missing {}", src.display());
    assert!(include.exists(), "missing {}", include.display());

    println!("cargo:rerun-if-changed={}", src.display());
    println!(
        "cargo:rerun-if-changed={}",
        include.join("core.h").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        include.join("core_wire.h").display()
    );
    for name in [
        "ANDROID_HOME",
        "ANDROID_SDK_ROOT",
        "ANDROID_NDK_HOME",
        "ANDROID_NDK_ROOT",
        "ANDROID_NDK_VERSION",
        "ANDROID_NDK_API_LEVEL",
        "NDK_HOME",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    // TARGET / OUT_DIR はccが利用する。verboseログでcompiler引数を確認する。
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.is_empty() {
        println!("cargo:warning=core-ffi target={target}");
    }

    let mut build = cc::Build::new();
    build.cpp(true).std("c++17").file(&src).include(&include);
    if let Some(tools) =
        android_tools(&target, &manifest_dir).unwrap_or_else(|error| panic!("{error}"))
    {
        println!(
            "cargo:warning=core-ffi Android compiler={}",
            tools.compiler.display()
        );
        println!(
            "cargo:warning=core-ffi Android archiver={}",
            tools.archiver.display()
        );
        build.compiler(tools.compiler);
        build.archiver(tools.archiver);
    }
    build.compile("core");
}
