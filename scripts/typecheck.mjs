#!/usr/bin/env node
// typecheck -- --scope native|web|all (既定allだがM0はnativeのみ提供、M2でweb/all追加)
import { runCmd, parseKVArgs, ROOT } from "./lib.mjs";

function usage() {
  return `usage: npm run typecheck -- --scope <native|web|all>`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
const allowed = new Set(["scope"]);
for (const k of Object.keys(kv)) {
  if (!allowed.has(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const scope = kv["scope"] ?? "all";
if (!["native", "web", "all"].includes(String(scope))) {
  console.error(`--scope must be native|web|all\n${usage()}`);
  process.exit(2);
}

function tsc(project) {
  console.log(`$ tsc --noEmit -p ${project}`);
  const res = runCmd("npx", ["tsc", "--noEmit", "-p", project], { stdio: "inherit" });
  // spawnSync with inherit: status only
  return res.status ?? 1;
}

let code = 0;
if (scope === "native") {
  code = tsc("tsconfig.native.json");
  if (code === 0) code = tsc("tsconfig.node.json");
} else if (scope === "web") {
  code = tsc("tsconfig.web.json");
  if (code === 0) code = tsc("tsconfig.worker.json");
  if (code === 0) code = tsc("tsconfig.node.json");
} else {
  code = tsc("tsconfig.native.json");
  if (code === 0) code = tsc("tsconfig.web.json");
  if (code === 0) code = tsc("tsconfig.worker.json");
  if (code === 0) code = tsc("tsconfig.node.json");
  if (code === 0) code = tsc("tsconfig.tests.json");
}
process.exit(code);
