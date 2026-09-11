#!/usr/bin/env node
// preview:web — 指定したdistだけを同じprefixで配信する検証用静的配信。
// MIME、CSP、no-store、strict 404を適用する。path traversalを拒否し、任意directoryを公開しない。
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseKVArgs } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `usage: npm run preview:web [-- --base /|/core/ --port 4173 --host 127.0.0.1 --dist dist/web]`;
}

const { kv } = parseKVArgs(process.argv.slice(2));
for (const k of Object.keys(kv)) {
  if (!["base", "port", "host", "dist"].includes(k)) {
    console.error(`unknown argument: --${k}\n${usage()}`);
    process.exit(2);
  }
}
const base = kv["base"] ?? "/";
const port = Number(kv["port"] ?? "4173");
const host = kv["host"] ?? "127.0.0.1";
const distRel = kv["dist"] ?? "dist/web";

if (typeof base !== "string" || !base.startsWith("/") || (base !== "/" && !base.endsWith("/"))) {
  console.error(`--base must be / or absolute path with trailing slash\n${usage()}`);
  process.exit(2);
}
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  console.error(`--port invalid\n${usage()}`);
  process.exit(2);
}

const distDir = path.resolve(ROOT, distRel);
// 任意directoryを公開しない: dist配下のみ
const allowedRoot = path.resolve(ROOT, "dist");
if (!distDir.startsWith(allowedRoot + path.sep) && distDir !== allowedRoot) {
  console.error(`--dist must be under dist/ (got: ${distRel})`);
  process.exit(2);
}
if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  console.error(`missing dist dir: ${distRel}. Run build:web first.`);
  process.exit(1);
}

// preview/test:webは記録とdistを照合し、base不一致・欠落・古い出力を拒否する
const recordPath = path.join(ROOT, "dist/web-build.json");
if (existsSync(recordPath)) {
  try {
    const rec = JSON.parse(readFileSync(recordPath, "utf-8"));
    if (rec.base !== base) {
      console.error(`base mismatch: record=${String(rec.base)} requested=${base}. Rebuild with --base ${base}.`);
      process.exit(1);
    }
    // 出力ファイルの存在を確認
    for (const o of rec.outputs ?? []) {
      const p = path.join(distDir, o.path);
      if (!existsSync(p)) {
        console.error(`missing output file: ${o.path}. Stale dist? Rebuild.`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(`invalid web-build.json: ${String(e)}`);
    process.exit(1);
  }
}

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".wasm") return "application/wasm";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

function isWorkerScript(filePath) {
  // Worker scriptの応答にもCSPを付ける。ここではjs/mjs/wasmをWorker候補としてCSPを付ける。
  // HTMLには必ず付ける。
  return true;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}:${String(port)}`);
    let pathname = decodeURIComponent(url.pathname);
    // prefix以外は404
    if (!pathname.startsWith(base)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    let rel = pathname.slice(base.length);
    // path traversalを拒否
    if (rel.includes("..") || rel.includes("\\")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const filePath = path.normalize(path.join(distDir, rel));
    if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // 欠落mjs/wasmにindex.htmlを200で返さない
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    const body = readFileSync(filePath);
    const headers = {
      "content-type": mimeFor(filePath),
      "cache-control": "no-store",
      "content-length": body.length,
    };
    // .htmlだけでなくWorker scriptの応答にもCSPを付ける
    if (filePath.endsWith(".html") || isWorkerScript(filePath)) {
      headers["content-security-policy"] = CSP;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("internal error");
  }
});

server.listen(port, host, () => {
  const prefix = base === "/" ? "/" : base;
  console.log(`preview:web serving ${distRel} at http://${host}:${String(port)}${prefix} (base=${base})`);
  console.log(`CSP: ${CSP}`);
});
