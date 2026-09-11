#!/usr/bin/env node
// build:web — 型検査→WASM生成→Vite web buildを直列に行う。
// --base は / または末尾slash付き絶対pathのみ。全工程成功後にその出力を試験対象とする。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseKVArgs, sha256File } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `usage: npm run build:web [-- --base /|/core/]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (k !== "base") {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const base = kv["base"] ?? "/";
if (typeof base !== "string" || !base.startsWith("/") || (base !== "/" && !base.endsWith("/"))) {
  console.error(`--base must be / or absolute path with trailing slash (got: ${String(base)})\n${usage()}`);
  process.exit(2);
}
if (base.includes("..") || base.includes("\\") || base.includes("?") || base.includes("#")) {
  console.error(`--base contains forbidden characters: ${base}`);
  process.exit(2);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  return res.status ?? 1;
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, rel));
    else out.push({ rel, full, hash: sha256File(full), size: st.size });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// 1. 型検査
if (run("node", ["scripts/typecheck.mjs", "--scope", "all"]) !== 0) process.exit(1);
// 2. WASM生成
if (run("node", ["scripts/build-wasm.mjs"]) !== 0) process.exit(1);

// 3. Vite web buildを一時出力へ (ビルド中の出力を配信せず、一時出力の検査後に差し替える)
const tmpOut = path.join(ROOT, "dist/.tmp-web-build");
if (existsSync(tmpOut)) rmSync(tmpOut, { recursive: true, force: true });
mkdirSync(tmpOut, { recursive: true });
if (run("npx", ["vite", "build", "--mode", "web", "--base", base, "--outDir", "dist/.tmp-web-build"]) !== 0) {
  try {
    rmSync(tmpOut, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}

// 一時出力の検査: index.html、wasm/mjs、Worker chunkの存在
const tmpFiles = listFiles(tmpOut);
const hasHtml = tmpFiles.some((f) => f.rel === "index.html");
const hasWasm = tmpFiles.some((f) => f.rel === "wasm/core.wasm");
const hasMjs = tmpFiles.some((f) => f.rel === "wasm/core.mjs");
if (!hasHtml || !hasWasm || !hasMjs) {
  console.error(`tmp build missing required files: html=${String(hasHtml)} mjs=${String(hasMjs)} wasm=${String(hasWasm)}`);
  try {
    rmSync(tmpOut, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}
// test harnessや故障注入設定が通常buildに入っていないこと
const hasHarness = tmpFiles.some((f) => f.rel.includes("harness") || f.rel.includes("worker-harness"));
if (hasHarness) {
  console.error("tmp build contains test harness (must not be in normal build)");
  try {
    rmSync(tmpOut, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}

// 差し替え: dist/webへ
const finalOut = path.join(ROOT, "dist/web");
if (existsSync(finalOut)) rmSync(finalOut, { recursive: true, force: true });
mkdirSync(path.dirname(finalOut), { recursive: true });
// renameで原子的に差し替える (同一FS内)
renameSync(tmpOut, finalOut);

// 記録: 配信外の dist/web-build.jsonへbase、source/header/fixture/lockのhash、出力一覧/hash
const finalFiles = listFiles(finalOut);
const record = {
  base,
  builtAt: new Date().toISOString(),
  sources: {
    "packages/core/src/core.cpp": sha256File(path.join(ROOT, "packages/core/src/core.cpp")),
    "packages/core/include/core.h": sha256File(path.join(ROOT, "packages/core/include/core.h")),
    "packages/api/fixtures/golden-vectors.json": sha256File(path.join(ROOT, "packages/api/fixtures/golden-vectors.json")),
    "package-lock.json": sha256File(path.join(ROOT, "package-lock.json")),
    "Cargo.lock": existsSync(path.join(ROOT, "Cargo.lock")) ? sha256File(path.join(ROOT, "Cargo.lock")) : null,
    "toolchains.lock.json": sha256File(path.join(ROOT, "toolchains.lock.json")),
  },
  outputs: finalFiles.map((f) => ({ path: f.rel, sha256: f.hash, size: f.size })),
};
mkdirSync(path.join(ROOT, "dist"), { recursive: true });
writeFileSync(path.join(ROOT, "dist/web-build.json"), JSON.stringify(record, null, 2) + "\n");
console.log(`built dist/web base=${base} files=${String(finalFiles.length)}`);
console.log("wrote dist/web-build.json");
