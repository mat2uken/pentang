#!/usr/bin/env node
// dev:web — WASM生成→Vite web配信。emsdk有効化済み環境で実行する。
import { spawnSync } from "node:child_process";
import { parseKVArgs } from "./lib.mjs";

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (k !== "port" && k !== "host") {
    console.error(`unknown argument: --${k}`);
    process.exit(2);
  }
}
const port = kv["port"] ?? "5173";
const host = kv["host"] ?? "127.0.0.1";

console.log("$ node scripts/build-wasm.mjs");
let res = spawnSync("node", ["scripts/build-wasm.mjs"], { stdio: "inherit" });
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

console.log(`$ vite dev --mode web --port ${port} --host ${host}`);
res = spawnSync("npx", ["vite", "dev", "--mode", "web", "--port", String(port), "--host", String(host)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
