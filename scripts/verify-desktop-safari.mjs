#!/usr/bin/env node
// verify-desktop-safari — 実SafariでW-SAFARI相当を全自動検証する (safaridriver不要、AppleScript + do JavaScript)。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseKVArgs, ROOT } from "./lib.mjs";

function usage() {
  return `usage: node scripts/verify-desktop-safari.mjs [--url http://127.0.0.1:4173/ --out reports/local/wsafari-root]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
const url = kv["url"] ?? "http://127.0.0.1:4173/";
const outRel = kv["out"] ?? "reports/local/wsafari-root";

function osa(script) {
  const res = spawnSync("osascript", ["-e", script], { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
  return res;
}

function log(m) {
  console.log(`[verify-safari] ${m}`);
}
function fail(m) {
  console.error(`[verify-safari] FAIL: ${m}`);
  process.exit(1);
}

function jsOnce(js) {
  const esc = js.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Safari"\ntry\ndo JavaScript "${esc}" in front document\non error e\nreturn "APPLESCRIPT_ERROR:" & e\nend try\nend tell`;
  const res = osa(script);
  if (res.status !== 0) return { ok: false, out: res.stderr };
  return { ok: true, out: (res.stdout ?? "").trim() };
}

async function main() {
  const outDir = path.join(ROOT, outRel);
  mkdirSync(outDir, { recursive: true });

  // Safari起動 + URLオープン (open -a Safari で確実に)
  log(`open ${url} in Safari`);
  spawnSync("open", ["-a", "Safari", url], { cwd: ROOT });
  await new Promise((r) => setTimeout(r, 4000));

  // UI-01 ready待ち (最大60s、do JavaScriptでpoll)
  let status = "";
  let backendInfo = "";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const r1 = jsOnce(`document.getElementById('status') ? document.getElementById('status').textContent : 'NO_STATUS'`);
    const r2 = jsOnce(`document.getElementById('backend-info') ? document.getElementById('backend-info').textContent : 'NO_INFO'`);
    status = r1.out ?? "";
    backendInfo = r2.out ?? "";
    log(`poll status=${status.slice(0, 40)} info=${backendInfo.slice(0, 80)}`);
    if (status === "ready" && backendInfo.includes("wasm-worker")) break;
    if (status.startsWith("APPLESCRIPT_ERROR")) {
      fail(`AppleScript JS not allowed. Enable Safari > Settings > Advanced > Show Develop menu + Allow JavaScript from Apple Events. got: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== "ready") fail(`UI-01 timeout status=${status}`);
  if (!backendInfo.includes("dedicated-worker") || !backendInfo.includes("browser") || !backendInfo.includes("abi: 1")) {
    fail(`UI-02 unexpected: ${backendInfo}`);
  }
  log(`UI-01/UI-02 PASS ${backendInfo}`);

  // Safariバージョン (推測転記せず実測)
  const verRes = osa(`tell application "Safari" to return version`);
  const safariVer = (verRes.stdout ?? "").trim();
  log(`Safari version=${safariVer}`);

  // UI-03 run
  jsOnce(`document.getElementById('run').click()`);
  let result = "";
  {
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 1000));
      const rr = jsOnce(`document.getElementById('result').textContent`);
      result = rr.out ?? "";
      if (result.includes("checksum=15")) break;
    }
  }
  if (!result.includes("checksum=15") || !result.includes("[3,5,7]")) fail(`UI-03 failed: ${result}`);
  log(`UI-03 PASS ${result}`);

  // UI-04 self-test
  jsOnce(`document.getElementById('selftest').click()`);
  let selfResult = "";
  {
    const dl = Date.now() + 60000;
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 2000));
      const rr = jsOnce(`document.getElementById('selftest-result').textContent`);
      selfResult = rr.out ?? "";
      if (selfResult.includes("success 11/11")) break;
    }
  }
  if (!selfResult.includes("success 11/11")) fail(`UI-04 failed: ${selfResult}`);
  log(`UI-04 PASS ${selfResult}`);

  // crossOriginIsolated=false
  const iso = jsOnce(`String(window.crossOriginIsolated)`);
  if ((iso.out ?? "") !== "false") fail(`crossOriginIsolated expected false, got ${iso.out}`);
  log(`crossOriginIsolated=false PASS`);

  // W-02 headers via fetch
  const expectedCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";
  const baseUrl = url.endsWith("/") ? url : url + "/";
  const htmlRes = await fetch(baseUrl);
  if (htmlRes.status !== 200) fail(`html status ${htmlRes.status}`);
  if ((htmlRes.headers.get("content-security-policy") ?? "") !== expectedCSP) fail("CSP mismatch");
  if ((htmlRes.headers.get("cache-control") ?? "") !== "no-store") fail("no-store missing");
  const mjsUrl = new URL("wasm/poc-core.mjs", baseUrl).toString();
  const mjsRes = await fetch(mjsUrl);
  if (mjsRes.status !== 200 || !(mjsRes.headers.get("content-type") ?? "").includes("javascript")) fail("mjs MIME");
  const wasmRes = await fetch(new URL("wasm/poc-core.wasm", baseUrl).toString());
  if (wasmRes.status !== 200 || wasmRes.headers.get("content-type") !== "application/wasm") fail("wasm MIME");
  const missRes = await fetch(new URL("wasm/missing.wasm", baseUrl).toString());
  if (missRes.status !== 404) fail("404");
  log("W-02 PASS");

  // screenshot: Safari windowをscreencapture (全画面ではなく -m main monitor, 証拠用)
  const shotPath = path.join(outDir, "safari.png");
  spawnSync("screencapture", ["-m", "-T", "1", shotPath], { cwd: ROOT, timeout: 15000 });
  log(`saved ${shotPath}`);

  const runMd = `# 実行記録: desktop-safari (${url})\n\n| 項目 | 値 |\n|---|---|\n| 日時 | ${new Date().toISOString()} |\n| 対象 | W-SAFARI |\n| URL | ${url} |\n| Safari実版 | ${safariVer} |\n| 結果 | PASS |\n\n- UI-01 ready: PASS\n- UI-02: PASS (${backendInfo})\n- UI-03: PASS (${result})\n- UI-04: PASS (${selfResult})\n- crossOriginIsolated=false: PASS\n- W-02: PASS\n`;
  writeFileSync(path.join(outDir, "run.md"), runMd);
  log("PASS W-SAFARI");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
