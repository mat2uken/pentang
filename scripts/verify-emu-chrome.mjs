#!/usr/bin/env node
// verify-emu-chrome — Emulator内ChromeでW-ANDROID相当を全自動検証する。
// 前提: preview:web が --base / --port 4173 で起動済み、Emulatorが起動済み、Chromeにログイン済み。
// 操作はadb + uiautomator dump解析のみで、手動タップ不要。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseKVArgs, ROOT } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `usage: node scripts/verify-emu-chrome.mjs [--serial emulator-5554 --base / --port 4173 --out reports/local/emu-chrome-wandroid]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (!["serial", "base", "port", "out"].includes(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const serial = kv["serial"] ?? "emulator-5554";
const base = kv["base"] ?? "/";
const port = Number(kv["port"] ?? "4173");
const outRel = kv["out"] ?? "reports/local/emu-chrome-wandroid";

function adb(...args) {
  const res = spawnSync("adb", ["-s", serial, ...args], { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
  return res;
}

function log(msg) {
  console.log(`[verify-emu-chrome] ${msg}`);
}

function fail(msg) {
  console.error(`[verify-emu-chrome] FAIL: ${msg}`);
  process.exit(1);
}

// uiautomator dump取得・pull・parse
function dumpUi() {
  const r1 = adb("shell", "uiautomator", "dump", "/sdcard/emu-chrome-ui.xml");
  if (r1.status !== 0) fail(`uiautomator dump failed: ${r1.stderr}`);
  const tmpLocal = path.join("/tmp", `emu-chrome-ui-${serial}.xml`);
  const r2 = spawnSync("adb", ["-s", serial, "pull", "/sdcard/emu-chrome-ui.xml", tmpLocal], { cwd: ROOT, encoding: "utf-8", timeout: 30000 });
  if (r2.status !== 0) fail(`pull failed: ${r2.stderr}`);
  return readFileSync(tmpLocal, "utf-8");
}

function parseNodes(xml) {
  // resource-id, text, boundsを抜く
  const nodes = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const rid = (tag.match(/resource-id="([^"]*)"/) || [])[1] ?? "";
    const text = (tag.match(/ text="([^"]*)"/) || [])[1] ?? "";
    const bounds = (tag.match(/bounds="([^"]*)"/) || [])[1] ?? "";
    const cls = (tag.match(/class="([^"]*)"/) || [])[1] ?? "";
    nodes.push({ rid, text, bounds, cls });
  }
  return nodes;
}

function findById(nodes, id) {
  return nodes.find((n) => n.rid === id || n.rid.endsWith(`:id/${id}`) || n.rid === id);
}

function centerOf(bounds) {
  const m = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]), y1 = Number(m[2]), x2 = Number(m[3]), y2 = Number(m[4]);
  return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
}

function tapCenter(bounds, label) {
  const c = centerOf(bounds);
  if (!c) fail(`cannot parse bounds for ${label}: ${bounds}`);
  log(`tap ${label} at ${c.x},${c.y}`);
  const r = adb("shell", "input", "tap", String(c.x), String(c.y));
  if (r.status !== 0) fail(`tap failed: ${r.stderr}`);
}

async function fetchHost(pathname) {
  const url = `http://127.0.0.1:${port}${pathname.startsWith("/") ? pathname : "/" + pathname}`;
  const res = await fetch(url);
  const text = await res.text();
  return { res, text, headers: res.headers };
}

async function main() {
  const outDir = path.join(ROOT, outRel);
  mkdirSync(outDir, { recursive: true });

  // 1. 成果物と配信の対応
  const recPath = path.join(ROOT, "dist/web-build.json");
  if (!existsSync(recPath)) fail("missing dist/web-build.json. Run build:web first.");
  const rec = JSON.parse(readFileSync(recPath, "utf-8"));
  if (rec.base !== base) fail(`base mismatch: record=${rec.base} requested=${base}. Rebuild with --base ${base}.`);
  log(`dist base=${rec.base} outputs=${rec.outputs?.length ?? 0}`);

  // 2. preview到達 (host側)
  try {
    const { res } = await fetchHost(base);
    if (res.status !== 200) fail(`preview ${base} status=${res.status}`);
    log(`preview reachable ${base} 200`);
  } catch (e) {
    fail(`preview not reachable at 127.0.0.1:${port}${base}. Start: npm run preview:web -- --base ${base} --port ${port}. err=${String(e)}`);
  }

  // 3. EmulatorへURL起動 (10.0.2.2はEmulatorからhostへの到達用)
  const emuUrl = `http://10.0.2.2:${port}${base}`;
  log(`launch Chrome ${emuUrl} on ${serial}`);
  const rStart = adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", emuUrl);
  if (rStart.status !== 0) fail(`am start failed: ${rStart.stderr}`);

  // 4. UI-01/UI-02: ready + backend-info待ち (最大60s)
  let nodes = [];
  let status = "";
  let backendInfo = "";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const xml = dumpUi();
    nodes = parseNodes(xml);
    const st = findById(nodes, "status");
    const bi = findById(nodes, "backend-info");
    status = st?.text ?? "";
    backendInfo = bi?.text ?? "";
    log(`poll status=${status || "(empty)"} backend=${backendInfo.slice(0, 80)}`);
    if (status === "ready" && backendInfo.includes("wasm-worker")) break;
  }
  if (status !== "ready") fail(`UI-01 timeout: status=${status}`);
  if (!backendInfo.includes("wasm-worker") || !backendInfo.includes("dedicated-worker") || !backendInfo.includes("browser") || !backendInfo.includes("abi: 1")) {
    fail(`UI-02 backend-info unexpected: ${backendInfo}`);
  }
  log(`UI-01/UI-02 PASS ready + ${backendInfo}`);

  // 5. UI-03: 実行タップ -> checksum=15
  const runNode = findById(nodes, "run");
  if (!runNode) fail("run button not found");
  tapCenter(runNode.bounds, "run");
  let result = "";
  {
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 1500));
      nodes = parseNodes(dumpUi());
      const rn = findById(nodes, "result");
      result = rn?.text ?? "";
      log(`poll result=${result.slice(0, 80)}`);
      if (result.includes("checksum=15") && result.includes("[3,5,7]")) break;
    }
  }
  if (!result.includes("checksum=15")) fail(`UI-03 failed: result=${result}`);
  log(`UI-03 PASS ${result}`);

  // 6. UI-04: self-test -> 11/11
  const selfNode = findById(nodes, "selftest");
  if (!selfNode) fail("selftest button not found");
  tapCenter(selfNode.bounds, "selftest");
  let selfResult = "";
  {
    const dl = Date.now() + 60000;
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 2000));
      nodes = parseNodes(dumpUi());
      const sn = findById(nodes, "selftest-result");
      selfResult = sn?.text ?? "";
      log(`poll selftest=${selfResult.slice(0, 120)}`);
      if (selfResult.includes("success 11/11")) break;
    }
  }
  if (!selfResult.includes("success 11/11")) fail(`UI-04 failed: ${selfResult}`);
  if (!selfResult.includes("invalid 7/7")) fail(`UI-04 invalid count missing: ${selfResult}`);
  log(`UI-04 PASS ${selfResult}`);

  // 7. UI-05: 破棄 -> disposed -> 再初期化 -> ready
  const dispNode = findById(nodes, "dispose");
  if (!dispNode) fail("dispose button not found");
  tapCenter(dispNode.bounds, "dispose");
  {
    const dl = Date.now() + 20000;
    let st = "";
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 1000));
      nodes = parseNodes(dumpUi());
      st = findById(nodes, "status")?.text ?? "";
      if (st === "disposed") break;
    }
    if (st !== "disposed") fail(`UI-05 dispose failed: status=${st}`);
    log(`UI-05 dispose PASS disposed`);
  }
  const reinitNode = findById(nodes, "reinit");
  if (!reinitNode) fail("reinit button not found");
  tapCenter(reinitNode.bounds, "reinit");
  {
    const dl = Date.now() + 60000;
    let st = "";
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 2000));
      nodes = parseNodes(dumpUi());
      st = findById(nodes, "status")?.text ?? "";
      if (st === "ready") break;
    }
    if (st !== "ready") fail(`UI-05 reinit failed: status=${st}`);
    log(`UI-05 reinit PASS ready`);
  }

  // 8. W-02: 配信header (host側で自動確認)
  const expectedCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";
  {
    const { res, headers } = await fetchHost(base);
    const csp = headers.get("content-security-policy") ?? "";
    const cc = headers.get("cache-control") ?? "";
    const ct = headers.get("content-type") ?? "";
    if (csp !== expectedCSP) fail(`CSP mismatch: ${csp}`);
    if (cc !== "no-store") fail(`cache-control mismatch: ${cc}`);
    if (!ct.includes("text/html")) fail(`content-type mismatch: ${ct}`);
    const mjsRes = await fetch(`http://127.0.0.1:${port}${base === "/" ? "/" : base}wasm/poc-core.mjs`);
    if (mjsRes.status !== 200 || !(mjsRes.headers.get("content-type") ?? "").includes("javascript")) fail("mjs MIME failed");
    const wasmRes = await fetch(`http://127.0.0.1:${port}${base === "/" ? "/" : base}wasm/poc-core.wasm`);
    if (wasmRes.status !== 200 || wasmRes.headers.get("content-type") !== "application/wasm") fail("wasm MIME failed");
    const missRes = await fetch(`http://127.0.0.1:${port}${base === "/" ? "/" : base}wasm/missing.wasm`);
    if (missRes.status !== 404) fail("404 failed");
    const missText = await missRes.text();
    if (missText.toLowerCase().includes("<!doctype")) fail("404 body should not be index.html");
    log("W-02 PASS MIME/CSP/no-store/404");
  }

  // 9. 証拠保存: screenshot + xml + run.md
  const shotPath = path.join(outDir, "emu-chrome.png");
  const shot = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], { cwd: ROOT, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (shot.status === 0) {
    writeFileSync(shotPath, shot.stdout);
    log(`saved ${shotPath}`);
  }
  const finalXml = dumpUi();
  writeFileSync(path.join(outDir, "ui-dump.xml"), finalXml);
  const runMd = `# 実行記録: emu-chrome-wandroid (W-ANDROID Emulator Chrome)\n\n| 項目 | 値 |\n|---|---|\n| 日時 | ${new Date().toISOString()} |\n| 対象ID / 試験ID | W-ANDROID / UI-01〜UI-05、W-01、W-02 |\n| 実行環境 | emulator-5554 medium_phone android-36 arm64-v8a Emu Chrome |\n| 到達URL | ${emuUrl} (preview base=${base} port=${port}) |\n| 成果物 | dist/web (base=${rec.base}) |\n| 結果 | PASS |\n\n## 結果\n\n- UI-01 ready: PASS (status=ready)\n- UI-02 backend-info: PASS (${backendInfo})\n- UI-03 result: PASS (${result})\n- UI-04 self-test: PASS (${selfResult})\n- UI-05 dispose->reinit: PASS (disposed->ready)\n- W-02 MIME/CSP/no-store/404: PASS\n- 画面: emu-chrome.png, ui-dump.xml\n`;
  writeFileSync(path.join(outDir, "run.md"), runMd);
  log("PASS W-ANDROID (Emu Chrome)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
