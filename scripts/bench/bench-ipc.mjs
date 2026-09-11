#!/usr/bin/env node
// bench-ipc.mjs — JS側シリアライズのマイクロベンチ (アプリ不要)。
// JSON vs wire-raw のペイロードbyte数・encode/decode時間を比較する。
// packages/api/wire.ts をesbuildで束ねて読み込む。
// 結果は .lab-state/bench/ipc-micro-<timestamp>.json に保存し、md表をstdoutに出す。
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const out = { sizes: [0, 3, 64, 256, 1024, 4096], reps: 0, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sizes" && argv[i + 1]) out.sizes = argv[++i].split(",").map(Number);
    else if (a === "--reps" && argv[i + 1]) out.reps = Number(argv[++i]);
    else if (a === "--out-dir" && argv[i + 1]) out.outDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: bench-ipc.mjs [--sizes 0,3,256,1024,4096] [--reps N] [--out-dir DIR]");
      process.exit(0);
    }
  }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

// JSONサイズに現実味を持たせる混合値 (大小・負・境界値)。
function makeValues(n) {
  const v = new Array(n);
  for (let i = 0; i < n; i++) {
    switch (i % 8) {
      case 0: v[i] = 2147483647; break;
      case 1: v[i] = -2147483648; break;
      case 2: v[i] = -i; break;
      case 3: v[i] = 0; break;
      default: v[i] = i * 7919 % 100000;
    }
  }
  return v;
}

async function loadWire() {
  const esbuild = await import("esbuild");
  const dir = mkdtempSync(path.join(tmpdir(), "pentang-bench-"));
  const entry = path.join(dir, "entry.mjs");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(ROOT, "packages/api/wire.ts"))};\n`,
  );
  const outFile = path.join(dir, "wire.bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: outFile,
    logLevel: "silent",
  });
  return import(outFile);
}

function defaultReps(n) {
  if (n <= 3) return 3000;
  if (n <= 64) return 1500;
  if (n <= 256) return 600;
  if (n <= 1024) return 200;
  return 60;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const W = await loadWire();
  const rows = [];
  const memBefore = process.memoryUsage().heapUsed;

  for (const n of args.sizes) {
    const reps = args.reps > 0 ? args.reps : defaultReps(n);
    const values = makeValues(n);
    const req = { values, multiplier: 2, offset: 1 };

    // --- JSON ---
    const jsonStr = JSON.stringify({ request: req });
    const jsonBytes = Buffer.byteLength(jsonStr, "utf8");
    const tJEnc = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      JSON.stringify({ request: req });
      tJEnc.push(performance.now() - t0);
    }
    const tJDec = [];
    let parsed;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      parsed = JSON.parse(jsonStr);
      tJDec.push(performance.now() - t0);
    }
    // parse結果のint32走査 (Rust側validate相当のJS側コスト目安)。
    const tJWalk = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const arr = parsed.request.values;
      let acc = 0;
      for (let k = 0; k < arr.length; k++) {
        const v = arr[k];
        if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new Error("bad");
        acc = (acc + (v | 0)) | 0;
      }
      tJWalk.push(performance.now() - t0);
    }

    // --- wire raw ---
    const wireBuf = new Uint8Array(16 + 12 + n * 4);
    const wireLen = W.encodeTransformRequest(wireBuf, 0, { sequence: 1, values, multiplier: 2, offset: 1 });
    const wireReq = wireBuf.slice(0, wireLen);
    const tWEnc = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      W.encodeTransformRequest(wireBuf, 0, { sequence: 1, values, multiplier: 2, offset: 1 });
      tWEnc.push(performance.now() - t0);
    }
    const tWDec = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const d = W.decodeTransformRequest(wireReq);
      if (!d.ok) throw new Error("wire dec failed");
      W.valuesToArray(d.valuesBytes, d.count);
      tWDec.push(performance.now() - t0);
    }

    rows.push({
      n,
      reps,
      json: { bytes: jsonBytes, encMs: median(tJEnc), decMs: median(tJDec), walkMs: median(tJWalk), encP95: p95(tJEnc), decP95: p95(tJDec) },
      wire: { bytes: wireLen, encMs: median(tWEnc), decMs: median(tWDec), encP95: p95(tWEnc), decP95: p95(tWDec) },
    });
  }

  // --- 保持メモリ: 各方式の要求表現を200件保持したときのheap増分 ---
  // 正確なGC制御のため node --expose-gc 付きでの実行を推奨 (なければ近似)。
  const retained = [];
  for (const [name, make] of [
    ["json", (v) => JSON.stringify({ request: { values: v, multiplier: 2, offset: 1 } })],
    ["wire", (v) => {
      const b = new Uint8Array(16 + 12 + v.length * 4);
      const n = W.encodeTransformRequest(b, 0, { sequence: 1, values: v, multiplier: 2, offset: 1 });
      return b.slice(0, n);
    }],
  ]) {
    if (global.gc) global.gc();
    const v = makeValues(4096);
    // 予熱でJITとallocatorを安定化させる。
    for (let i = 0; i < 20; i++) make(v);
    if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed;
    const hold = [];
    for (let i = 0; i < 200; i++) hold.push(make(v));
    const h1 = process.memoryUsage().heapUsed;
    retained.push({ method: name, heapDeltaBytes: h1 - h0, perOpBytes: (h1 - h0) / 200 });
    // holdを解放して次方式への漏れを防ぐ。
    hold.length = 0;
    if (global.gc) global.gc();
  }

  const memAfter = process.memoryUsage().heapUsed;
  const result = {
    tool: "bench-ipc.mjs",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(),
    rows,
    retained,
    processHeapDeltaBytes: memAfter - memBefore,
  };

  const outDir = args.outDir ?? path.join(ROOT, ".lab-state/bench");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const outFile = path.join(outDir, `ipc-micro-${stamp}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");

  // md表
  console.log("| N | 方式 | bytes | enc中央値ms | dec中央値ms |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) {
    const f = (x) => x.toFixed(4);
    console.log(`| ${r.n} | json | ${r.json.bytes} | ${f(r.json.encMs)} | ${f(r.json.decMs)}+walk${f(r.json.walkMs)} |`);
    console.log(`| ${r.n} | wire | ${r.wire.bytes} | ${f(r.wire.encMs)} | ${f(r.wire.decMs)} |`);
  }
  console.log("| 保持200件(N=4096) | heap増分 | 1件あたり |");
  console.log("|---|---|---|");
  for (const r of retained) {
    console.log(`| ${r.method} | ${r.heapDeltaBytes} B | ${r.perOpBytes.toFixed(0)} B |`);
  }
  console.log(`saved: ${outFile}`);
}

await main();
