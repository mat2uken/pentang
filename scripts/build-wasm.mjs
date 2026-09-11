#!/usr/bin/env node
// build-wasm.mjs — 同一C++→mjs/wasm。生成先は web-public/wasm/。
// docs/plan/05-build-run.md の引数を配列で組み立てる。shell貼り付け用ではない。
// emsdkの有効化済み環境を呼び出し側で渡す (source ~/emsdk/emsdk_env.sh)。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function whichEmxx() {
  const res = spawnSync("sh", ["-c", "command -v em++"], { encoding: "utf-8" });
  const out = (res.stdout ?? "").trim();
  return out === "" ? null : out;
}

function emVersion(emxx) {
  const res = spawnSync(emxx, ["--version"], { encoding: "utf-8" });
  const out = ((res.stdout ?? "") + (res.stderr ?? "")).trim().split("\n")[0];
  return out;
}

function main() {
  const emxx = whichEmxx();
  if (!emxx) {
    console.error("em++ not found. Web build時のみ有効化する: source ~/emsdk/emsdk_env.sh");
    process.exit(1);
  }
  console.log(`em++: ${emxx} (${emVersion(emxx)})`);

  const src = path.join(ROOT, "packages/core/src/core.cpp");
  const include = path.join(ROOT, "packages/core/include");
  if (!existsSync(src) || !existsSync(include)) {
    console.error(`missing ${src} or ${include}`);
    process.exit(1);
  }

  // docs/05 (docs/plan/05-build-run.md) の引数
  const args = [
    src,
    "-I",
    include,
    "-std=c++17",
    "-O2",
    "-fno-exceptions",
    "-fno-rtti",
    "--no-entry",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createCore",
    "-sENVIRONMENT=worker",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=16777216",
    "-sMAXIMUM_MEMORY=67108864",
    "-sABORTING_MALLOC=0",
    "-sFILESYSTEM=0",
    "-sDYNAMIC_EXECUTION=0",
    '-sEXPORTED_FUNCTIONS=["_core_abi_version","_core_version","_core_transform_i32","_malloc","_free"]',
    '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAP32","HEAPU32"]',
  ];

  const tmpDir = path.join(tmpdir(), `core-wasm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpMjs = path.join(tmpDir, "core.mjs");
  const tmpWasm = path.join(tmpDir, "core.wasm");
  const fullArgs = [...args, "-o", tmpMjs];

  console.log(`$ em++ ${fullArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  const res = spawnSync(emxx, fullArgs, { cwd: ROOT, stdio: "inherit" });
  if ((res.status ?? 1) !== 0) {
    // em++が非0なら旧ファイルを新成功結果として扱わない。一時出力を残さず終了する。
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    console.error("em++ failed");
    process.exit(res.status ?? 1);
  }
  if (!existsSync(tmpMjs) || !existsSync(tmpWasm)) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    console.error("missing output mjs/wasm");
    process.exit(1);
  }
  const mjsHash = sha256File(tmpMjs);
  const wasmHash = sha256File(tmpWasm);
  console.log(`tmp mjs sha256=${mjsHash}`);
  console.log(`tmp wasm sha256=${wasmHash}`);

  const outDir = path.join(ROOT, "web-public/wasm");
  mkdirSync(outDir, { recursive: true });
  const outMjs = path.join(outDir, "core.mjs");
  const outWasm = path.join(outDir, "core.wasm");
  // 成功後にmjs/wasmの存在とhashを確認し、組として公開先へ移す。
  renameSync(tmpMjs, outMjs);
  renameSync(tmpWasm, outWasm);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  console.log(`wrote ${outMjs} sha256=${sha256File(outMjs)}`);
  console.log(`wrote ${outWasm} sha256=${sha256File(outWasm)}`);

  // 入力/flags/出力hashの記録 (M2-04のdist/web-build.jsonへ引き継ぐための基礎情報)
  const record = {
    emxx,
    emVersion: emVersion(emxx),
    src: `packages/core/src/core.cpp sha256=${sha256File(src)}`,
    header: `packages/core/include/core.h sha256=${sha256File(path.join(include, "core.h"))}`,
    args,
    outputs: {
      "web-public/wasm/core.mjs": sha256File(outMjs),
      "web-public/wasm/core.wasm": sha256File(outWasm),
    },
    memory: { initial: 16777216, maximum: 67108864, growth: true, target: "wasm32" },
  };
  writeFileSync(path.join(outDir, "build-info.json"), JSON.stringify(record, null, 2) + "\n");
  console.log("wrote web-public/wasm/build-info.json");
}

main();
