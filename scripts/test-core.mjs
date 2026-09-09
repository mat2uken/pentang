#!/usr/bin/env node
// test:core — CMake configure→build→CTestを順に行う。Debug/Release等のconfigを明示する。
import { runCmd, parseKVArgs } from "./lib.mjs";

function usage() {
  return `usage: npm run test:core [-- --config <Debug|Release>]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (k !== "config") {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const config = kv["config"] ?? "Debug";
if (!["Debug", "Release", "RelWithDebInfo", "MinSizeRel"].includes(String(config))) {
  console.error(`--config must be Debug|Release|RelWithDebInfo|MinSizeRel\n${usage()}`);
  process.exit(2);
}

const buildDir = "build/core-test";
console.log(`$ cmake -S . -B ${buildDir} -DCMAKE_BUILD_TYPE=${config}`);
let res = runCmd("cmake", ["-S", ".", "-B", buildDir, `-DCMAKE_BUILD_TYPE=${config}`], { stdio: "inherit" });
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

console.log(`$ cmake --build ${buildDir} --config ${config}`);
res = runCmd("cmake", ["--build", buildDir, "--config", String(config)], { stdio: "inherit" });
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

console.log(`$ ctest --test-dir ${buildDir} -C ${config} --output-on-failure`);
res = runCmd("ctest", ["--test-dir", buildDir, "-C", String(config), "--output-on-failure"], { stdio: "inherit" });
process.exit(res.status ?? 1);
