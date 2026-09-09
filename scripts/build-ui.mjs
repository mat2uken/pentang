#!/usr/bin/env node
// build-ui.mjs --mode tauri (M0)。web modeはM2で提供する。
// native/node型検査→Vite tauri build。emsdk不要。
import { runCmd, parseKVArgs } from "./lib.mjs";

function usage() {
  return `usage: npm run build:native-ui [-- --mode tauri]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
const allowed = new Set(["mode"]);
for (const k of Object.keys(kv)) {
  if (!allowed.has(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const mode = kv["mode"] ?? "tauri";
if (mode !== "tauri") {
  console.error(`M0のbuild-uiは --mode tauri のみ対応する (got: ${mode})。webはM2で提供する。`);
  process.exit(2);
}

console.log(`$ tsc native/node typecheck`);
let res = runCmd("node", ["scripts/typecheck.mjs", "--scope", "native"], { stdio: "inherit" });
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

console.log(`$ vite build --mode tauri`);
res = runCmd("npx", ["vite", "build", "--mode", "tauri"], { stdio: "inherit" });
process.exit(res.status ?? 1);
