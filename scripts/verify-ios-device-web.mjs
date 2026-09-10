#!/usr/bin/env node
// verify-ios-device-web — iPhone実機SafariでW実機相当を全自動検証する。
// 前提: 実機がUSB接続・ロック解除済み・画面ON、Safariでpreview URLを開きっぱなし (単一タブ推奨)、preview:web が --host 0.0.0.0 で起動済み。
// 手法: pymobiledevice3 webinspector js-shell (Inspector mode) でJS評価。手動タップ不要。
//
// 注意 (過去の不発の教訓):
// - js-shellに --url を渡すと接続時に window.location へ再ナビゲートし、bootがリセットされて
//   click/読取が競合する (セッション依存の不発)。タブが単一なら --url を付けずにattachする。
// - 各セッションは隔離JSワールド (window直下の変数は共有されない) だがDOMは共有される。
//   click→結果読取は同一セッション内で行い、stdinを開いたままNode側sleepで待つ。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseKVArgs, ROOT } from "./lib.mjs";

function usage() {
  return `usage: node scripts/verify-ios-device-web.mjs --udid <device-udid> --url http://<host-lan-ip>:4174/ [--out docs/reports/local/ios-device]
  example: node scripts/verify-ios-device-web.mjs --udid <device-udid> --url http://<host-lan-ip>:4174/`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (!["udid", "url", "out"].includes(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const udid = kv["udid"];
const pageUrl = kv["url"];
if (typeof udid !== "string" || udid === "") {
  console.error(`--udid is required (pymobiledevice3 usbmux listで確認)。\n${usage()}`);
  process.exit(2);
}
if (typeof pageUrl !== "string" || !pageUrl.startsWith("http")) {
  console.error(`--url http://<host-lan-ip>:4174/ is required。\n${usage()}`);
  process.exit(2);
}
const outRel = kv["out"] ?? "docs/reports/local/ios-device";

function log(m) {
  console.log(`[verify-ios-device-web] ${m}`);
}
function fail(m) {
  console.error(`[verify-ios-device-web] FAIL: ${m}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 60000, ...opts });
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

// 単一js-shellセッションで複式を評価する。stepsは [{write, waitMs}] の列。
// stdinを開いたままNode側で待つため、click→(device処理)→読取が同一DOM/同一pageで完結する。
function jsSession(steps, sessionTimeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "pymobiledevice3",
      ["webinspector", "js-shell", "--udid", udid],
      { cwd: ROOT, timeout: sessionTimeoutMs },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    (async () => {
      for (const s of steps) {
        if (s.waitMs) await new Promise((r) => setTimeout(r, s.waitMs));
        if (s.write) p.stdin.write(s.write + "\n");
      }
      p.stdin.end();
    })().catch(reject);
    p.on("close", (code) => resolve({ code, out: stripAnsi(out), err: stripAnsi(err) }));
    setTimeout(() => reject(new Error(`js-shell timeout after ${sessionTimeoutMs}ms out=${out.slice(-300)}`)), sessionTimeoutMs + 5000);
  });
}

// 評価結果からマーカー __M_<name>__:JSON を抜く (最後の出現を採用)。
function pickMarker(cleanOut, name) {
  const re = new RegExp(`__M_${name}__:(.*)`, "g");
  let m, last = null;
  while ((m = re.exec(cleanOut)) !== null) last = (m[1] ?? "").trim();
  return last;
}

function expr(marker, js) {
  // JSON.stringifyで1行化し、前方一致のゴミと区別できる形にする。
  return `'__M_${marker}__:'+JSON.stringify(${js})`;
}

async function main() {
  const outDir = path.join(ROOT, outRel);
  mkdirSync(outDir, { recursive: true });

  // 1. タブ確認 (単一・対象URLであること。--urlは付けない=再ナビゲート防止)
  const tabs = run("pymobiledevice3", ["webinspector", "opened-tabs", "--udid", udid], { timeout: 40000 });
  const tabOut = stripAnsi(tabs.stdout ?? "");
  if (/Unable to find available pages|unlock the page/i.test(tabOut + (tabs.stderr ?? ""))) {
    fail("実機がロック中か、inspectableなタブがありません。ロック解除 + Safari表示のまま再実行してください。");
  }
  const tabLines = tabOut.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("<"));
  const urlHost = new URL(pageUrl).host;
  const matched = tabLines.filter((l) => l.includes(urlHost));
  if (matched.length === 0) {
    fail(`対象URL(${pageUrl})のタブがありません。実機Safariで開いてから再実行してください。tabs=${tabOut.slice(0, 300)}`);
  }
  if (tabLines.length !== 1) {
    fail(`タブが${tabLines.length}件ありattachが不安定になります。対象外タブを閉じて単一にしてから再実行してください。`);
  }
  log(`tab OK: ${matched[0].slice(0, 120)}`);

  // 2. UI-01/UI-02 (同一セッションで2読取)
  {
    const r = await jsSession([
      { write: expr("status", "document.getElementById('status').textContent") },
      { write: expr("backend", "document.getElementById('backend-info').textContent") },
    ]);
    const status = JSON.parse(pickMarker(r.out, "status") ?? "null");
    const backend = JSON.parse(pickMarker(r.out, "backend") ?? "null");
    log(`status=${status} backend=${(backend ?? "").slice(0, 90)}`);
    if (status !== "ready") fail(`UI-01 missing ready: ${status}`);
    for (const n of ["wasm-worker", "dedicated-worker", "browser", "abi: 1"]) {
      if (!String(backend ?? "").includes(n)) fail(`UI-02 backend missing ${n}: ${backend}`);
    }
    log("UI-01/UI-02 PASS");
  }

  // 3. UI-03: 実行click→発火確認(disabled)→8s待機→結果 (同一セッション、最大3試行)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await jsSession([
      { write: "document.getElementById('run').click()" },
      { write: expr("fired", "document.getElementById('run').disabled") },
      { waitMs: 8000 },
      { write: expr("result", "document.getElementById('result').textContent") },
      { write: expr("error", "document.getElementById('error').textContent") },
    ]);
    const fired = JSON.parse(pickMarker(r.out, "fired") ?? "null");
    const result = JSON.parse(pickMarker(r.out, "result") ?? "null");
    const error = JSON.parse(pickMarker(r.out, "error") ?? "null");
    log(`UI-03 attempt=${attempt} result=${result} error=${error} (fired=${fired}は参考: 高速完了時はfalse表示あり)`);
    if (String(result ?? "").includes("checksum=15") && String(result).includes("[3,5,7]")) {
      log("UI-03 PASS");
      break;
    }
    if (attempt === 3) fail(`UI-03 failed: result=${result} error=${error}`);
    await new Promise((r2) => setTimeout(r2, 3000));
  }

  // 4. UI-04: self-test click→最大90sポーリング (同一セッションを開きっぱなし)
  {
    const steps = [{ write: "document.getElementById('selftest').click()" }];
    for (let i = 0; i < 9; i++) {
      steps.push({ waitMs: 10000 });
      steps.push({ write: expr(`self${i}`, "document.getElementById('selftest-result').textContent") });
    }
    const r = await jsSession(steps, 180000);
    let ok = false, last = "";
    for (let i = 0; i < 9; i++) {
      last = JSON.parse(pickMarker(r.out, `self${i}`) ?? "null") ?? "";
      if (String(last).includes("success 11/11")) { ok = true; break; }
    }
    log(`UI-04 last=${String(last).slice(0, 100)}`);
    if (!ok) fail(`UI-04 failed: ${last}`);
    if (!String(last).includes("invalid 7/7")) fail(`UI-04 invalid count missing: ${last}`);
    log("UI-04 PASS");
  }

  // 5. UI-05: 破棄→disposed→再初期化→ready
  {
    const r = await jsSession([
      { write: "document.getElementById('dispose').click()" },
      { waitMs: 4000 },
      { write: expr("st", "document.getElementById('status').textContent") },
    ]);
    const st = JSON.parse(pickMarker(r.out, "st") ?? "null");
    if (st !== "disposed") fail(`UI-05 dispose failed: ${st}`);
    log("UI-05 dispose PASS");
  }
  {
    const steps = [{ write: "document.getElementById('reinit').click()" }];
    for (let i = 0; i < 6; i++) {
      steps.push({ waitMs: 10000 });
      steps.push({ write: expr(`re${i}`, "document.getElementById('status').textContent") });
    }
    const r = await jsSession(steps, 120000);
    let st = "";
    for (let i = 0; i < 6; i++) {
      st = JSON.parse(pickMarker(r.out, `re${i}`) ?? "null") ?? "";
      if (st === "ready") break;
    }
    if (st !== "ready") fail(`UI-05 reinit failed: ${st}`);
    log("UI-05 reinit PASS");
  }

  // 6. W-02 headers (host側、Sim/Web実機と同一preview)
  {
    const baseUrl = pageUrl.endsWith("/") ? pageUrl : pageUrl + "/";
    const expectedCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";
    const htmlRes = await fetch(baseUrl);
    if (htmlRes.status !== 200) fail(`html ${htmlRes.status}`);
    if ((htmlRes.headers.get("content-security-policy") ?? "") !== expectedCSP) fail("CSP mismatch");
    if ((htmlRes.headers.get("cache-control") ?? "") !== "no-store") fail("no-store mismatch");
    log("W-02 PASS");
  }

  const runMd = `# 実行記録: ios-device-web (iPhone実機Safari・全自動)\n\n| 項目 | 値 |\n|---|---|\n| 日時 | ${new Date().toISOString()} |\n| 対象 | W実機 (iPhone実機Safari、UDIDは記録省略) |\n| 到達URL | ${pageUrl} (preview base=/ port=${new URL(pageUrl).port} host=0.0.0.0) |\n| 手法 | scripts/verify-ios-device-web.mjs (pymobiledevice3 webinspector js-shell、合成click全自動) |\n| 結果 | PASS |\n\n- UI-01 status: PASS (ready)\n- UI-02 backend-info: PASS (wasm-worker/dedicated-worker/browser/abi:1)\n- UI-03: PASS ([3,5,7]/15)\n- UI-04: PASS (success 11/11, invalid 7/7)\n- UI-05: PASS (disposed->ready)\n- W-02: PASS (CSP/no-store)\n`;
  writeFileSync(path.join(outDir, "run.md"), runMd);
  log("PASS ios-device-web");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
