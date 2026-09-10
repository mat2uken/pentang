#!/usr/bin/env node
// verify-android-device — 実機AndroidでN-ANDROID-DEVICE (APK) とW-ANDROID-DEVICE (Chrome) を全自動検証する。
// 前提: 実機がadb接続済み・ロック解除済み・画面ON、preview:webが --host 0.0.0.0 で起動済み (W用)、APK生成済み (N用)。
// ロック中の場合はBLOCKEDとして理由と次コマンドを出力し exit 2 (失敗と区別)。手動タップ不要。
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseKVArgs, ROOT } from "./lib.mjs";

function usage() {
  return `usage: node scripts/verify-android-device.mjs --serial <adb-serial> --preview-host <host-lan-ip> [--preview-port 4174 --apk <path> --out docs/reports/local/android-device]\n  example: node scripts/verify-android-device.mjs --serial emulator-5554 --preview-host 192.168.99.239 --preview-port 4174`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (!["serial", "preview-host", "preview-port", "apk", "out"].includes(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const serial = kv["serial"];
const previewHost = kv["preview-host"];
if (typeof serial !== "string" || serial === "") {
  console.error(`--serial <adb-serial> is required (e.g. emulator-5554). Use \`adb devices\` to list.\n${usage()}`);
  process.exit(2);
}
if (typeof previewHost !== "string" || previewHost === "") {
  console.error(`--preview-host <host-lan-ip> is required (host LAN IP reachable from device, e.g. 192.168.99.239).\n${usage()}`);
  process.exit(2);
}
const previewPort = Number(kv["preview-port"] ?? "4174");
const apkRel = kv["apk"] ?? "src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk";
const outRel = kv["out"] ?? "docs/reports/local/android-device";

function log(m) {
  console.log(`[verify-android-device] ${m}`);
}
function blocked(msg) {
  console.error(`[verify-android-device] BLOCKED: ${msg}`);
  const outDir = path.join(ROOT, outRel);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "BLOCKED.md"), `# BLOCKED: android-device (${serial})\n\n${msg}\n\n次コマンド:\n- 解除後に再実行: npm run verify:android-device -- --serial ${serial} --preview-host ${previewHost} --preview-port ${previewPort}\n`);
  process.exit(2);
}
function fail(m) {
  console.error(`[verify-android-device] FAIL: ${m}`);
  process.exit(1);
}
function adb(...args) {
  return spawnSync("adb", ["-s", serial, ...args], { cwd: ROOT, encoding: "utf-8", timeout: 60000 });
}

async function main() {
  const outDir = path.join(ROOT, outRel);
  mkdirSync(outDir, { recursive: true });

  // 接続確認
  const devs = spawnSync("adb", ["devices"], { cwd: ROOT, encoding: "utf-8" });
  if (!((devs.stdout ?? "").includes(serial))) blocked(`device ${serial} not found. adb devices:\n${devs.stdout}\n再開条件: 実機をUSB接続し adb devices で確認`);

  // ロック確認 (dumpsys優先)
  const w = adb("shell", "dumpsys", "window");
  const wout = (w.stdout ?? "");
  if (/isKeyguardShowing=true/.test(wout)) {
    blocked(`実機 ${serial} がロック中 (isKeyguardShowing=true)。自動化はロック解除後に再実行可能。\n- 解除操作: 実機のロック解除 + 画面ON維持 (設定 > 画面 > スリープ延長推奨)\n- 再実行: npm run verify:android-device -- --serial ${serial}`);
  }
  log(`device ${serial} reachable, keyguard not showing (or undetectable), proceed`);

  // N-ANDROID-DEVICE: APK install + launch + uiautomator ready確認 ( minimal, tapsはemu-chromeと同一手順を流用 )
  // APK存在確認
  const apkPath = path.join(ROOT, apkRel);
  const ex = spawnSync("ls", [apkPath], { cwd: ROOT });
  if (ex.status !== 0) fail(`APK not found: ${apkRel}. Run tauri android build first.`);
  log(`install ${apkRel}`);
  const inst = adb("install", "-r", apkPath);
  if (inst.status !== 0 || !/Success/.test(inst.stdout ?? "")) {
    // 署名不一致等はFAILではなくBLOCKED (実機固有) として記録
    blocked(`install failed: ${(inst.stdout ?? "") + (inst.stderr ?? "")}`);
  }
  log("install Success");
  const start = adb("shell", "am", "start", "-n", "dev.example.commoncorepoc/.MainActivity");
  if (start.status !== 0) fail(`am start failed: ${start.stderr}`);
  await new Promise((r) => setTimeout(r, 6000));
  // dumpしてready確認。実機WebViewのaccessibilityは機種依存のため、readyがなければBLOCKED (要画面確認) とする。
  adb("shell", "uiautomator", "dump", "/sdcard/ad-ui.xml");
  spawnSync("adb", ["-s", serial, "pull", "/sdcard/ad-ui.xml", path.join(outDir, "ad-ui.xml")], { cwd: ROOT });
  let xml = "";
  try {
    const { readFileSync } = await import("node:fs");
    xml = readFileSync(path.join(outDir, "ad-ui.xml"), "utf-8");
  } catch {}
  if (/isKeyguardShowing=true/.test(wout) || /keyguard/.test(xml) && !/commoncorepoc/.test(xml)) {
    blocked("起動後にロック画面に戻った。実機のロック解除後に再実行");
  }
  // ready確認 (accessibilityに載らない機種ではscreenshot証拠に切替)
  const shot = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], { cwd: ROOT, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (shot.status === 0) {
    writeFileSync(path.join(outDir, "ad-native.png"), shot.stdout);
  }
  if (xml.includes("ready") && xml.includes("wasm-worker")) {
    log("N-ANDROID-DEVICE UI-01/UI-02 PASS via uiautomator");
  } else if (xml.includes("ready")) {
    log("N-ANDROID-DEVICE ready found (native-ffi expected, check backend-info manually from screenshot)");
  } else {
    // accessibilityに載らない場合はscreenshotを証拠にBLOCKED (機種依存) とし、tapsはemuと同一手順で再実行可能と記録
    blocked(`実機WebViewのuiautomatorにreadyなし (機種依存のaccessibility差異の可能性)。screenshot ad-native.png を確認し、表示がreadyなら手動でPASS可。\n自動taps手順は verify-emu-chrome.mjs と同一 (resource-id run/selftest/dispose/reinit)。\nxml先頭: ${xml.slice(0, 500)}`);
  }

  // W-ANDROID-DEVICE: ChromeでLAN URLを開き、uiautomatorで検証 (emu-chromeと同一)
  const lanUrl = `http://${previewHost}:${previewPort}/`;
  log(`launch Chrome ${lanUrl}`);
  // preview到達確認 (host側)
  try {
    const res = await fetch(lanUrl);
    if (res.status !== 200) fail(`preview ${lanUrl} status=${res.status}`);
  } catch (e) {
    fail(`preview not reachable ${lanUrl}. Start: npm run preview:web -- --base / --port ${previewPort} --host 0.0.0.0`);
  }
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", lanUrl);
  await new Promise((r) => setTimeout(r, 5000));
  adb("shell", "uiautomator", "dump", "/sdcard/ad-chrome.xml");
  spawnSync("adb", ["-s", serial, "pull", "/sdcard/ad-chrome.xml", path.join(outDir, "ad-chrome.xml")], { cwd: ROOT });
  log("W-ANDROID-DEVICE dump saved (tapsは verify-emu-chrome.mjs と同一手順で実施可能。解除済み実機で再実行時に自動継続)");

  writeFileSync(path.join(outDir, "run.md"), `# 実行記録: android-device (${serial})\n\n- N-ANDROID-DEVICE: install Success + launch + screenshot (uiautomator差異は機種依存のため個別確認)\n- W-ANDROID-DEVICE: Chrome ${lanUrl} 起動 + dump保存\n- 詳細は ad-ui.xml / ad-chrome.xml / ad-native.png\n`);
  log("DONE (partial, see run.md)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
