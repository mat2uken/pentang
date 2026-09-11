#!/usr/bin/env node
// collect-bench — sim/実機のbench-runnerからの結果POSTを受けて保存する。
// usage: node scripts/collect-bench.mjs --port 4179 [--out .lab-state/bench --expect 1 --timeout 600000]
// bench側は `?report=http://<host>:<port>/bench` または VITE_BENCH_REPORT_URL で送信する。
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseKVArgs, ROOT } from "./lib.mjs";

const { kv } = parseKVArgs(process.argv.slice(2));
const port = Number(kv["port"] ?? "4179");
const outRel = kv["out"] ?? ".lab-state/bench";
const expectCount = Number(kv["expect"] ?? "1");
const timeoutMs = Number(kv["timeout"] ?? "600000");

const dir = path.join(ROOT, outRel);
mkdirSync(dir, { recursive: true });
let received = 0;
const server = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
      const ua = String(report.userAgent ?? "unknown");
      const tag = ua.includes("iPhone") || ua.includes("iPad") ? "ios" : "device";
      const file = path.join(dir, `${tag}-${stamp}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      console.log(`[collect-bench] saved: ${file} agreement=${report.agreement}`);
      received++;
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("ok");
      if (received >= expectCount) {
        // 応答後に終了する。
        setTimeout(() => process.exit(0), 500).unref();
      }
    } catch (e) {
      console.error(`[collect-bench] bad body: ${String(e).slice(0, 200)}`);
      res.writeHead(400).end();
    }
  });
});
server.listen(port, "0.0.0.0", () => {
  console.log(`[collect-bench] listening on 0.0.0.0:${port} (out=${outRel})`);
});
setTimeout(() => {
  console.error(`[collect-bench] TIMEOUT after ${timeoutMs}ms (received ${received}/${expectCount})`);
  process.exit(2);
}, timeoutMs).unref();
