#!/usr/bin/env node
// android-bench — debuggableなAndroid WebViewへCDP接続し、?bench=1を実行して
// 報告JSONを保存する。usage:
//   node scripts/android-bench.mjs --serial emulator-5554 --port 9222 [--out .lab-state/bench] [--timeout 600000]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseKVArgs, ROOT } from "./lib.mjs";

const { kv } = parseKVArgs(process.argv.slice(2));
const serial = kv["serial"];
const port = Number(kv["port"] ?? "9222");
const outRel = kv["out"] ?? ".lab-state/bench";
const timeoutMs = Number(kv["timeout"] ?? "600000");
if (typeof serial !== "string" || serial === "") {
  console.error("usage: node scripts/android-bench.mjs --serial <adb-serial> [--port 9222]");
  process.exit(2);
}

function adb(...args) {
  return spawnSync("adb", ["-s", serial, ...args], { cwd: ROOT, encoding: "utf-8", timeout: 60000 });
}

function log(m) { console.log(`[android-bench] ${m}`); }
function fail(m) { console.error(`[android-bench] FAIL: ${m}`); process.exit(1); }

const pid = (adb("shell", "pidof", "dev.example.commoncorepoc").stdout ?? "").trim();
if (!pid) fail("app not running; launch it first");
log(`app pid=${pid}`);
adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) fail("no page target");
log(`page: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("ws connect timeout")), 15000);
  ws.addEventListener("open", () => { clearTimeout(t); res(null); }, { once: true });
  ws.addEventListener("error", (e) => rej(e), { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(String(ev.data)); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(method, params = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.error) reject(new Error(`cdp error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { return (${expr}); })()`,
    returnByValue: true,
    awaitPromise: true,
  }, 120000);
  if (r.exceptionDetails) throw new Error(`eval exception: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result?.value ?? null;
}

try {
  await send("Page.navigate", { url: "http://tauri.localhost/?bench=1" });
  log("navigated to ?bench=1, polling #bench-output");
  const deadline = Date.now() + timeoutMs;
  let text = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    text = await evaluate(`document.getElementById('bench-output')?.textContent ?? ''`) ?? "";
    if (text.includes("webview-bench") || text.includes('"error"')) break;
    if (Date.now() > deadline) fail(`bench timeout, last=${text.slice(0, 200)}`);
    log(`waiting... (${text.slice(0, 40)})`);
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail(`bench output not JSON: ${text.slice(0, 300)}`);
  }
  if (report.error) fail(`bench failed in page: ${report.error}`);
  report.tool = "android-webview-bench";
  report.device = serial;
  const dir = path.join(ROOT, outRel);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const file = path.join(dir, `android-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  log(`saved: ${file}`);
  console.log("| plane | N | iters | medianMs | p95Ms |");
  for (const c of report.cases) {
    console.log(`| ${c.plane} | ${c.n} | ${c.iters} | ${c.medianMs.toFixed(3)} | ${c.p95Ms.toFixed(3)} |`);
  }
  if (!report.agreement) fail("checksum agreement failed");
  if (!report.schemeReachable) fail("scheme not reachable");
  log(`agreement ok, schemeUrl=${report.schemeUrl}`);
} finally {
  ws.close();
  process.exit(0);
}
