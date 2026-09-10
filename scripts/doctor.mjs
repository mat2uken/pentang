#!/usr/bin/env node
// doctor -- --target <web|native|android|ios> --phase <tools|build|run>
// phase既定build。仕様は docs/plan/01-environment.md。
// 読み取り専用: 自動install、SDK変更、実機起動、署名変更を行わない。
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT, runCmd, which, cmdVersion, loadJson, parseKVArgs } from "./lib.mjs";

const VALID_TARGETS = ["web", "native", "android", "ios"];
const VALID_PHASES = ["tools", "build", "run"];

function usage() {
  return `usage: npm run doctor -- --target <web|native|android|ios> [--phase <tools|build|run>] [--device-class simulator|device] [--arch arm64|x86_64] [--artifact <path>] [--url <http(s) url>] [--device <UDID|serial>]`;
}

function row(name, status, expected, actual, remedy) {
  return { item: name, status, expected, actual, remedy };
}

function main() {
  const { kv } = parseKVArgs(process.argv.slice(2));
  const target = kv["target"];
  const phase = kv["phase"] ?? "build";
  const deviceClass = kv["device-class"];
  const arch = kv["arch"];
  const artifact = kv["artifact"];
  const url = kv["url"];
  const device = kv["device"];

  const allowedKeys = new Set([
    "target",
    "phase",
    "device-class",
    "arch",
    "artifact",
    "url",
    "device",
  ]);
  for (const k of Object.keys(kv)) {
    if (!allowedKeys.has(k)) {
      console.error(`unknown argument: --${k}\n${usage()}`);
      process.exit(2);
    }
  }
  if (!target || !VALID_TARGETS.includes(String(target))) {
    console.error(`--target is required: web|native|android|ios\n${usage()}`);
    process.exit(2);
  }
  if (!VALID_PHASES.includes(String(phase))) {
    console.error(`--phase must be tools|build|run\n${usage()}`);
    process.exit(2);
  }
  if (target === "ios" && phase !== "tools" && !deviceClass) {
    // toolsでは必須にしないが、build/runでは対象を明確にする
    console.error(`ios requires --device-class simulator|device for phase ${phase}\n${usage()}`);
    process.exit(2);
  }
  if (deviceClass && !["simulator", "device"].includes(String(deviceClass))) {
    console.error(`--device-class must be simulator|device\n${usage()}`);
    process.exit(2);
  }
  if (arch && !["arm64", "x86_64"].includes(String(arch))) {
    console.error(`--arch must be arm64|x86_64\n${usage()}`);
    process.exit(2);
  }
  if (phase === "run" && !artifact) {
    console.error(`run phase requires --artifact <path>\n${usage()}`);
    process.exit(2);
  }
  if (phase === "run" && target === "web" && !url) {
    console.error(`web run phase requires --url <http(s) url>\n${usage()}`);
    process.exit(2);
  }
  if (phase === "run" && (target === "android" || target === "ios") && !device) {
    console.error(`${target} run phase requires --device <UDID|serial>\n${usage()}`);
    process.exit(2);
  }

  const lockFile = loadJson("toolchains.lock.json");
  const pkgFile = loadJson("package.json");
  const rows = [];

  const nodePath = which("node");
  const nodeVer = nodePath ? cmdVersion("node", ["--version"]) : { ok: false, output: "(not found)" };
  const npmVer = cmdVersion("npm", ["--version"]);
  const expectedNode = pkgFile.found ? (pkgFile.data?.engines?.node ?? "(unspecified)") : "(no package.json)";
  const actualNode = nodeVer.ok ? nodeVer.output : (nodePath ?? "MISSING");
  if (!nodePath || !nodeVer.ok) {
    rows.push(row("node", "MISSING", expectedNode, actualNode, "Node 24.20.0を作業shellに用意する (.node-version参照)"));
  } else if (expectedNode !== "(unspecified)" && !actualNode.includes("24.20.0")) {
    rows.push(row("node", "MISMATCH", expectedNode, actualNode, "この作業用shellにNode 24.20.0を選ぶ。ホスト既定は変更しない"));
  } else {
    rows.push(row("node", "FOUND", expectedNode, actualNode, "-"));
  }
  rows.push(
    row(
      "npm",
      npmVer.ok ? "FOUND" : "MISSING",
      pkgFile.found ? String(pkgFile.data?.engines?.npm ?? "(unspecified)") : "(no package.json)",
      npmVer.ok ? npmVer.output : "MISSING",
      npmVer.ok ? "-" : "Node 24に付随するnpmを用意する",
    ),
  );

  // Rust (native/android/iosで必須、webでは診断しない)
  if (target !== "web") {
    const rustVer = cmdVersion("rustc", ["--version"]);
    const expectedRust = lockFile.found ? String(lockFile.data?.versions?.rust ?? "(unspecified)") : "(no lock)";
    if (!rustVer.ok) {
      rows.push(row("rustc", "MISSING", expectedRust, "MISSING", "rustupで1.96.1を用意する"));
    } else if (expectedRust !== "(unspecified)" && !rustVer.output.includes(expectedRust)) {
      rows.push(row("rustc", "MISMATCH", expectedRust, rustVer.output, "rust-toolchain.tomlの版に合わせる"));
    } else {
      rows.push(row("rustc", "FOUND", expectedRust, rustVer.output, "-"));
    }
    const cargoVer = cmdVersion("cargo", ["--version"]);
    rows.push(row("cargo", cargoVer.ok ? "FOUND" : "MISSING", expectedRust, cargoVer.ok ? cargoVer.output : "MISSING", cargoVer.ok ? "-" : "Rustと同時に用意する"));
    // Rust target
    if (target === "android" || target === "ios" || (target === "native" && arch)) {
      let wantTarget = null;
      if (target === "android") {
        wantTarget = arch === "x86_64" ? "x86_64-linux-android" : "aarch64-linux-android";
      } else if (target === "ios") {
        wantTarget = deviceClass === "device" ? "aarch64-apple-ios" : "aarch64-apple-ios-sim";
      }
      if (wantTarget) {
        const res = runCmd("rustup", ["target", "list", "--installed"]);
        const installed = (res.stdout ?? "").split("\n").map((s) => s.trim());
        if (installed.includes(wantTarget)) rows.push(row(`rust-target:${wantTarget}`, "FOUND", wantTarget, wantTarget, "-"));
        else rows.push(row(`rust-target:${wantTarget}`, "MISSING", wantTarget, installed.join(",") || "(none)", `rustup target add ${wantTarget}`));
      }
    }
    // C++ compiler
    const cxx = which("c++") ?? which("clang++") ?? which("clang");
    if (!cxx) rows.push(row("cxx", "MISSING", "clang++/c++ (Xcode CLT)", "MISSING", "Xcode Command Line Toolsを用意する"));
    else {
      const v = cmdVersion("clang", ["--version"]);
      rows.push(row("cxx", "FOUND", "clang (Xcode)", v.ok ? v.output : cxx, "-"));
    }
    const cmakeVer = cmdVersion("cmake", ["--version"]);
    rows.push(row("cmake", cmakeVer.ok ? "FOUND" : "MISSING", lockFile.found ? String(lockFile.data?.versions?.cmake ?? "4.3.4") : "4.3.4", cmakeVer.ok ? cmakeVer.output.split("\n")[0] : "MISSING", cmakeVer.ok ? "-" : "CMakeを用意する (test:core用)"));
  }

  // Web固有: emsdkはM2-01で固定。以後はtools/buildで必須、runでは不要。
  if (target === "web") {
    const emsdkVer = lockFile.found ? lockFile.data?.web?.emscripten : null;
    if (phase === "tools" || phase === "build") {
      if (emsdkVer == null) {
        rows.push(row("em++", "NOT_CHECKED", "(M2-01で固定)", "UNRESOLVED", "M2-01でemsdk版を固定する。M0の空画面には不要"));
      } else {
        const emxx = which("em++");
        if (!emxx) rows.push(row("em++", "MISSING", String(emsdkVer), "MISSING", "emsdkを有効化してPATHへ渡す (Web build時のみ)"));
        else {
          const v = cmdVersion("em++", ["--version"]);
          rows.push(row("em++", v.ok ? "FOUND" : "MISSING", String(emsdkVer), v.ok ? v.output : "MISSING", v.ok ? "-" : "emsdkの有効化を確認する"));
        }
      }
    }
  }

  // Android固有
  if (target === "android") {
    const javaVer = cmdVersion("java", ["-version"]);
    rows.push(row("jdk", javaVer.ok ? "FOUND" : "MISSING", lockFile.found ? String(lockFile.data?.androidEmulator?.jdk ?? "21") : "21", javaVer.ok ? javaVer.output.split("\n")[0] : "MISSING", javaVer.ok ? "-" : "OpenJDK 21を用意する"));
    const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? null;
    if (!sdkRoot) rows.push(row("android-sdk", phase === "tools" ? "MISSING" : "NOT_CHECKED", "ANDROID_HOME", "MISSING", "Android SDKを用意しANDROID_HOMEを設定する"));
    else rows.push(row("android-sdk", existsSync(sdkRoot) ? "FOUND" : "MISSING", "ANDROID_HOME", sdkRoot, existsSync(sdkRoot) ? "-" : "SDK pathを確認する"));
    const ndkVer = lockFile.found ? lockFile.data?.androidEmulator?.ndk : null;
    if (ndkVer == null) rows.push(row("ndk", "NOT_CHECKED", "(M0-05で単一版へ解決)", "UNRESOLVED", "M0-05でNDK実pathを単一版へ解決する"));
    else {
      const sdkRootForNdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";
      const ndkPath = String(ndkVer).includes("/") ? String(ndkVer) : path.join(sdkRootForNdk, "ndk", String(ndkVer));
      rows.push(row("ndk", existsSync(ndkPath) ? "FOUND" : "MISSING", `ndk/${ndkVer}`, ndkPath, existsSync(ndkPath) ? "-" : "NDK版を確認しANDROID_HOME配下に用意する"));
    }
    // ビルド生成物の確認はbuild phaseのみ
  }

  // iOS固有
  if (target === "ios") {
    const xcodeVer = cmdVersion("xcodebuild", ["-version"]);
    rows.push(row("xcode", xcodeVer.ok ? "FOUND" : "MISSING", lockFile.found ? String(lockFile.data?.macos?.xcode ?? lockFile.data?.iosSimulator?.xcode ?? "26.6") : "26.6", xcodeVer.ok ? xcodeVer.output.split("\n")[0] : "MISSING", xcodeVer.ok ? "-" : "Xcodeを用意する"));
    const sdkShow = runCmd("xcodebuild", ["-showsdks"]);
    if (sdkShow.status === 0) rows.push(row("ios-sdk", "FOUND", deviceClass === "device" ? "iphoneos" : "iphonesimulator", "showsdks ok", "-"));
    else rows.push(row("ios-sdk", phase === "tools" ? "MISSING" : "NOT_CHECKED", "iphoneos/iphonesimulator", "xcodebuild -showsdks failed", "Xcode SDKを確認する"));
    const pod = which("pod");
    if (!pod) rows.push(row("cocoapods", "NOT_CHECKED", "(sim build時に必要)", "MISSING", "必要ならCocoaPodsを用意する。版はM0-05で固定"));
    else rows.push(row("cocoapods", "FOUND", "(M0-05で固定)", pod, "-"));
    // 実機用team/provisioningは成功条件にしない
    if (deviceClass === "device" && phase !== "tools") {
      rows.push(row("signing", "NOT_CHECKED", "(device実機は後続)", "UNRESOLVED", "実機は後続。署名準備ができてから診断する"));
    }
  }

  // build phase: 生成project/lock/依存導入
  if (phase === "build" || phase === "run") {
    // npm依存
    if (!existsSync(path.join(ROOT, "node_modules"))) {
      rows.push(row("node_modules", "MISSING", "npm ci済み", "MISSING", "npm ciを実行する"));
    } else {
      rows.push(row("node_modules", "FOUND", "npm ci済み", "exists", "-"));
    }
    if (!existsSync(path.join(ROOT, "package-lock.json"))) {
      rows.push(row("package-lock.json", "MISSING", "lock生成済み", "MISSING", "npm installで生成する"));
    } else {
      rows.push(row("package-lock.json", "FOUND", "lock生成済み", "exists", "-"));
    }
    // 生成projectの存在 (存在しなければbuild phaseでMISSING)
    if (target !== "web") {
      const tauriConf = path.join(ROOT, "src-tauri", "tauri.conf.json");
      if (!existsSync(tauriConf)) {
        rows.push(row("src-tauri project", phase === "tools" ? "NOT_CHECKED" : "MISSING", "M0-04で生成", "MISSING", "M0-04でtemplateから生成する"));
      } else {
        rows.push(row("src-tauri project", "FOUND", "M0-04で生成", "exists", "-"));
      }
      if (!existsSync(path.join(ROOT, "Cargo.lock"))) {
        rows.push(row("Cargo.lock", phase === "tools" ? "NOT_CHECKED" : "MISSING", "cargo generate-lockfile", "MISSING", "cargo generate-lockfile / buildで生成する"));
      } else {
        rows.push(row("Cargo.lock", "FOUND", "cargo lock", "exists", "-"));
      }
    } else {
      // web build scriptはM2まで未提供でよい
      const wasmScript = path.join(ROOT, "scripts", "build-wasm.mjs");
      if (!existsSync(wasmScript)) {
        rows.push(row("build:wasm script", phase === "tools" ? "NOT_CHECKED" : "NOT_CHECKED", "(M2-01で提供)", "MISSING", "M2-01で提供する。M0ではVite単独の空画面のみ"));
      } else {
        rows.push(row("build:wasm script", "FOUND", "M2-01で提供", "exists", "-"));
      }
    }
    // mobile生成projectはbuild phaseでも不存在で失敗させない (M0-03仕様)
    if (target === "android" || target === "ios") {
      rows.push(row("mobile gen project", "NOT_CHECKED", "(M0-05で生成)", "UNRESOLVED", "M0-05でios/android init後に確認する"));
    }
    // browser不足をbuild不能としない
    if (target === "web" && phase === "build") {
      rows.push(row("browser (run用)", "NOT_CHECKED", "(runで診断)", "UNRESOLVED", "buildでは必須にしない"));
    }
  }

  // run phase: 成果物と起動環境
  if (phase === "run") {
    const artPath = path.resolve(ROOT, artifact);
    if (!existsSync(artPath)) {
      rows.push(row("artifact", "MISSING", String(artifact), "MISSING", "対象のbuildを先に実行し、出力pathを記録する"));
    } else {
      rows.push(row("artifact", "FOUND", String(artifact), artPath, "-"));
    }
    if (target === "web") {
      if (!/^https?:\/\//.test(String(url))) {
        rows.push(row("url", "MISMATCH", "http(s) URL", String(url), "--url にpreviewのHTTP(S) URLを指定する"));
      } else {
        rows.push(row("url", "FOUND", "http(s) URL", String(url), "-"));
      }
      rows.push(row("browser", "NOT_CHECKED", "(M2-04/M4-06で実測)", "UNRESOLVED", "起動対象のbrowser実版を記録する"));
    }
    if (target === "android") {
      const adb = cmdVersion("adb", ["version"]);
      rows.push(row("adb", adb.ok ? "FOUND" : "MISSING", "platform-tools", adb.ok ? adb.output.split("\n")[0] : "MISSING", adb.ok ? "-" : "Android platform-toolsを用意する"));
      rows.push(row("device", device ? "FOUND" : "MISSING", "adb serial", String(device ?? "MISSING"), device ? "-" : "--device にadb serialを指定する"));
    }
    if (target === "ios") {
      const sim = cmdVersion("xcrun", ["simctl", "list", "devices"]);
      rows.push(row("simctl", sim.ok ? "FOUND" : "MISSING", "xcrun simctl", sim.ok ? "ok" : "MISSING", sim.ok ? "-" : "Xcode simctlを確認する"));
      rows.push(row("device", device ? "FOUND" : "MISSING", "UDID", String(device ?? "MISSING"), device ? "-" : "--device にUDIDを指定する"));
    }
    if (target === "native") {
      rows.push(row("webview", "NOT_CHECKED", "(起動時に記録)", "UNRESOLVED", "macOSはWebKit情報を記録。WindowsはWebView2版を記録"));
    }
  }

  // 出力
  console.log(`doctor target=${target} phase=${phase}`);
  console.log(`| item | status | expected | actual | remedy |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.item} | ${r.status} | ${r.expected} | ${r.actual} | ${r.remedy} |`);
  }
  const failed = rows.filter((r) => r.status === "MISSING" || r.status === "MISMATCH");
  if (failed.length > 0) {
    console.error(`\ndoctor: ${failed.length} required item(s) missing/mismatched`);
    process.exit(1);
  } else {
    console.log(`\ndoctor: OK (${rows.length} items)`);
  }
}

main();
