#!/usr/bin/env node
// verify-ios-device-web — iPhone実機SafariでW実機相当を全自動検証する。
// 前提: 実機がUSB接続・ロック解除済み・画面ON、Safariでpreview URLを開きっぱなし (単一タブ推奨)、preview:web が --host 0.0.0.0 で起動済み。
// 手法: pymobiledevice3 webinspector cdp (native RSD) へ直接接続してJS評価。手動タップ不要。
//
// 注意 (過去の不発の教訓):
// - URL一致のCDP page targetを選び、各セッションは同じDOMへ接続する。
//   click→結果読取は同一セッション内で行い、Node側sleepで待つ。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
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
  console.error(`--udid is required (xcrun devicectl list devices の CoreDevice UUID または hardware UDID)。\n${usage()}`);
  process.exit(2);
}
if (typeof pageUrl !== "string" || !pageUrl.startsWith("http")) {
  console.error(`--url http://<host-lan-ip>:4174/ is required。\n${usage()}`);
  process.exit(2);
}
const outRel = kv["out"] ?? "docs/reports/local/ios-device";

// CoreDevice の identifier (xcrun devicectl が返す UUID) と、Web Inspector
// が要求する hardware UDID は別の値である。native RSD tunnel は hardware
// UDID を受け取るため、CoreDevice UUID が渡された場合は devicectl の JSON
// から同じ実機の hardwareProperties.udid を解決する。
function resolveInspectorUdid(input) {
  if (/^\d{8}-\w{16}$/.test(input)) return input;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pentang-ios-device-"));
  const detailsPath = path.join(tempDir, "details.json");
  try {
    const details = run("xcrun", [
      "devicectl",
      "device",
      "info",
      "details",
      "--device",
      input,
      "--timeout",
      "20",
      "--json-output",
      detailsPath,
    ], { timeout: 40000 });
    if (details.status !== 0) return input;
    const parsed = JSON.parse(readFileSync(detailsPath, "utf8"));
    const resolved = parsed?.result?.hardwareProperties?.udid;
    return typeof resolved === "string" && resolved.length > 0 ? resolved : input;
  } catch {
    return input;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function log(m) {
  console.log(`[verify-ios-device-web] ${m}`);
}
function fail(m) {
  console.error(`[verify-ios-device-web] FAIL: ${m}`);
  process.exit(1);
}
function blocked(m) {
  console.error(`[verify-ios-device-web] BLOCKED: ${m}`);
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 60000, ...opts });
}

const inspectorUdid = resolveInspectorUdid(udid);
let cdpServer = null;
let cdpTarget = null;

function stopCdpServer() {
  if (!cdpServer) return;
  try {
    cdpServer.kill("SIGTERM");
  } catch {
    // The server may already have exited after a device disconnect.
  }
  cdpServer = null;
  cdpTarget = null;
}

process.on("exit", stopCdpServer);

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not reserve a loopback port for the iOS CDP bridge");
  return port;
}

async function startCdpBridge() {
  const port = await reserveLoopbackPort();
  cdpServer = spawn(
    "pymobiledevice3",
    ["webinspector", "cdp", "--native", "--udid", inspectorUdid, "--host", "127.0.0.1", "--port", String(port)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  cdpServer.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  cdpServer.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (cdpServer.exitCode !== null) {
      throw new Error(`pymobiledevice3 cdp exited ${cdpServer.exitCode}: ${(stderr || stdout).trim().slice(-600)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item?.type === "page" && item?.url === pageUrl)
          ?? targets.find((item) => item?.type === "page" && new URL(item.url).href === new URL(pageUrl).href);
        if (target) {
          cdpTarget = target;
          return { port, targets };
        }
      }
    } catch {
      // The bridge is still starting or the device has not published Safari yet.
    }
    await sleep(500);
  }
  throw new Error(`iOS CDP target did not appear for ${pageUrl}: ${(stderr || stdout).trim().slice(-600)}`);
}

function cdpCall(socket, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = cdpCall.nextId++;
    const timer = setTimeout(() => {
      cdpCall.pending.delete(id);
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cdpCall.pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
cdpCall.nextId = 1;
cdpCall.pending = new Map();

// CDP を直接使って対象 URL の page target を選ぶ。pymobiledevice3 の
// js-shell は複数タブ時に対話選択を要求するため、CI/ローカル自動実行では
// /json/list の URL 一致で選択して同じページへ Runtime.evaluate を送る。
async function jsSession(steps, sessionTimeoutMs = 120000) {
  if (!cdpTarget?.webSocketDebuggerUrl) throw new Error("iOS CDP target is not ready");
  const socket = new WebSocket(cdpTarget.webSocketDebuggerUrl);
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = cdpCall.pending.get(message.id);
    if (!pending) return;
    cdpCall.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`CDP error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  };
  socket.addEventListener("message", onMessage);
  const close = () => {
    try { socket.close(); } catch { /* already closed */ }
  };
  const timeout = setTimeout(() => close(), sessionTimeoutMs);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket open timed out after ${sessionTimeoutMs}ms`)), sessionTimeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket connection failed")); }, { once: true });
    });
    await cdpCall(socket, "Runtime.enable");
    const outputs = [];
    for (const step of steps) {
      if (step.waitMs) await sleep(step.waitMs);
      if (!step.write) continue;
      const result = await cdpCall(socket, "Runtime.evaluate", {
        expression: step.write,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(`CDP Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`);
      }
      const value = result?.result?.value;
      if (value !== undefined) outputs.push(String(value));
    }
    return { code: 0, out: outputs.join("\n"), err: "" };
  } finally {
    clearTimeout(timeout);
    for (const [id, pending] of cdpCall.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP session closed"));
      cdpCall.pending.delete(id);
    }
    close();
  }
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

  log(`device route: input=${udid.slice(0, 8)}… inspector=${inspectorUdid.slice(0, 8)}… (native RSD)`);

  const pmdHelp = run("pymobiledevice3", ["webinspector", "opened-tabs", "--help"], { timeout: 30000 });
  if (pmdHelp.status !== 0 || !/--native/.test(`${pmdHelp.stdout ?? ""}\n${pmdHelp.stderr ?? ""}`)) {
    blocked("pymobiledevice3 11.x の native Web Inspector 経路がありません。pymobiledevice3==11.12.1 を導入して再実行してください。");
  }

  // 1. タブ確認 (単一・対象URLであること。--urlは付けない=再ナビゲート防止)
  const tabs = run("pymobiledevice3", ["webinspector", "opened-tabs", "--native", "--udid", inspectorUdid], { timeout: 40000 });
  const tabOut = stripAnsi(tabs.stdout ?? "");
  const tabErr = stripAnsi(tabs.stderr ?? "");
  if (/Unable to find available pages|unlock the page|Device not found|Web Inspector|Remote Automation/i.test(tabOut + tabErr)) {
    blocked("実機が未接続かロック中、またはWeb Inspectorから見えていません。接続・ロック解除・Safari表示を確認して再実行してください。");
  }
  const tabLines = tabOut.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("<") && /TYPE:WIRType(?:WebPage|Page|Web)/.test(l));
  const urlHost = new URL(pageUrl).host;
  const matched = tabLines.filter((l) => l.includes(urlHost));
  if (matched.length === 0) {
    blocked(`対象URL(${pageUrl})のタブがありません。実機Safariで開いてから再実行してください。tabs=${tabOut.slice(0, 300)}`);
  }
  if (tabLines.length !== 1) {
    blocked(`タブが${tabLines.length}件ありattachが不安定になります。対象外タブを閉じて単一にしてから再実行してください。`);
  }
  log(`tab OK: ${matched[0].slice(0, 120)}`);

  let bridge;
  try {
    bridge = await startCdpBridge();
    log(`CDP target OK: ${cdpTarget.id} (bridge port=${bridge.port}, pages=${bridge.targets.length})`);
  } catch (error) {
    stopCdpServer();
    blocked(`Web Inspector CDP bridgeを開始できませんでした: ${String(error)}`);
  }

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

  const runMd = `# 実行記録: ios-device-web (iPhone実機Safari・全自動)\n\n| 項目 | 値 |\n|---|---|\n| 日時 | ${new Date().toISOString()} |\n| 対象 | W実機 (iPhone実機Safari、UDIDは記録省略) |\n| 到達URL | ${pageUrl} (preview base=/ port=${new URL(pageUrl).port} host=0.0.0.0) |\n| 手法 | scripts/verify-ios-device-web.mjs (pymobiledevice3 native CDP、URL一致target、合成click全自動) |\n| 結果 | PASS |\n\n- UI-01 status: PASS (ready)\n- UI-02 backend-info: PASS (wasm-worker/dedicated-worker/browser/abi:1)\n- UI-03: PASS ([3,5,7]/15)\n- UI-04: PASS (success 11/11, invalid 7/7)\n- UI-05: PASS (disposed->ready)\n- W-02: PASS (CSP/no-store)\n`;
  writeFileSync(path.join(outDir, "run.md"), runMd);
  log("PASS ios-device-web");
  stopCdpServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
