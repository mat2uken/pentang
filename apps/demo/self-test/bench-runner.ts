/** 実WebViewベンチ (Tauri内データプレーン3方式の往復比較)。
 *
 * `?bench=1` 付きで開かれたときだけ main.ts から動的importされる別chunk。
 * 製品バンドルの初期ロードには影響しない。各方式×Nで往復時間を測り、
 * 3方式のchecksum一致で正当性を相互検証する (独立oracleではなく交差検証)。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  decodeTransformResponse,
  encodeTransformRequest,
  scanFrames,
  valuesToArray,
} from "../../../packages/api/wire";
import { BatchingBridge } from "../../../packages/backends/transport/index";
import { SchemeBinaryTransport, probeSchemeUrl } from "../../../packages/backends/transport/transport-scheme";
import { WebMessageTransport, getCorebinPort } from "../../../packages/backends/transport/transport-android";

export interface BenchCaseResult {
  plane: string;
  n: number;
  iters: number;
  reqBytes: number;
  respBytes: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  checksum: number;
}

export interface BenchReport {
  tool: string;
  userAgent: string;
  timestamp: string;
  timerQuantumMs: number;
  schemeReachable: boolean;
  schemeUrl: string | null;
  portReachable: boolean;
  cases: BenchCaseResult[];
  agreement: boolean;
}

/** 結果の回収先URL。`?report=<url>` が最優先、なければビルド時env
 * (`VITE_BENCH_REPORT_URL`, sim/実機の無人回収用)。どちらもなければnull。 */
export function resolveReportTarget(search: string): string | null {
  try {
    const q = new URLSearchParams(search).get("report");
    if (typeof q === "string" && q !== "") return q;
  } catch {
    // ignore
  }
  try {
    const envUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.[
      "VITE_BENCH_REPORT_URL"
    ];
    if (typeof envUrl === "string" && envUrl !== "") return envUrl;
  } catch {
    // ignore
  }
  return null;
}

/** 報告JSONを回収先へPOSTする (best-effort。失敗は黙って無視)。 */
export async function postReport(url: string, report: BenchReport): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function makeValues(n: number): number[] {
  const v = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    switch (i % 8) {
      case 0: v[i] = 2147483647; break;
      case 1: v[i] = -2147483648; break;
      case 2: v[i] = -i; break;
      case 3: v[i] = 0; break;
      default: v[i] = (i * 7919) % 100000;
    }
  }
  return v;
}

function stats(xs: number[]): { median: number; p95: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const p95 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { median, p95, mean };
}

function encodeReq(seq: number, values: number[]): Uint8Array {
  const out = new Uint8Array(16 + 12 + values.length * 4);
  const n = encodeTransformRequest(out, 0, { sequence: seq & 0xffff, values, multiplier: 2, offset: 1 });
  return out.slice(0, n);
}

function decodeChecksum(resp: Uint8Array): { values: number[]; checksum: number } {
  const d = decodeTransformResponse(resp);
  if (!d.ok) throw new Error(`bad response frame: ${d.error.message}`);
  return { values: valuesToArray(d.valuesBytes, d.count), checksum: d.checksum };
}

export async function runBench(): Promise<BenchReport> {
  const sizes = [3, 256, 1024, 4096];
  // 1ms量子化対策: GROUPS×K opsを1サンプルとして計り、op単価に割る。
  const groupsFor = (_n: number) => 12;
  const opsPerGroup = (n: number) => (n <= 3 ? 25 : n <= 256 ? 20 : n <= 1024 ? 8 : 5);
  // performance.now() の分解能を記録する (量子化の裏付け用)。
  let timerQuantumMs = 0;
  {
    let minDelta = Number.POSITIVE_INFINITY;
    let prev = performance.now();
    for (let i = 0; i < 2000; i++) {
      const t = performance.now();
      const d = t - prev;
      if (d > 0 && d < minDelta) minDelta = d;
      prev = t;
    }
    timerQuantumMs = Number.isFinite(minDelta) ? minDelta : 0;
  }
  const schemeUrl = await probeSchemeUrl();
  const schemeReachable = schemeUrl !== null;
  const scheme = schemeUrl === null
    ? null
    : new SchemeBinaryTransport({ transformUrl: schemeUrl });
  // ネイティブ公開の生MessagePort (Android)。あれば全条件で計測する。
  const rawPort = getCorebinPort();
  const portReachable = rawPort !== null;
  const portMsg = rawPort === null ? null : new WebMessageTransport({ port: rawPort });
  const cases: BenchCaseResult[] = [];
  const checksums = new Map<string, number>();

  for (const n of sizes) {
    const values = makeValues(n);
    const groups = groupsFor(n);
    const perGroup = opsPerGroup(n);
    const iters = groups * perGroup;
    const seq = (n & 0xffff) || 7;

    // 1グループ=K opsを逐次実行して1サンプルにする。
    async function measure(send: (frame: Uint8Array) => Promise<Uint8Array>): Promise<{ samples: number[]; respBytes: number; checksum: number }> {
      const samples: number[] = [];
      let respBytes = 0;
      let checksum = 0;
      for (let g = -1; g < groups; g++) {
        const t0 = performance.now();
        for (let k = 0; k < perGroup; k++) {
          const frame = encodeReq(seq, values);
          const resp = await send(frame);
          const dec = decodeChecksum(resp);
          if (g === 0 && k === 0) {
            respBytes = resp.length;
            checksum = dec.checksum;
          }
        }
        const dt = performance.now() - t0;
        if (g >= 0) samples.push(dt / perGroup);
      }
      return { samples, respBytes, checksum };
    }

    // json: 既存コマンド直叩き (Backendオーバーヘッド除外の純IPC計測)。
    // frame経由にできないため専用loopで同条件計測する。
    {
      const samples: number[] = [];
      let reqBytes = 0;
      let respBytes = 0;
      let checksum = 0;
      for (let g = -1; g < groups; g++) {
        const t0 = performance.now();
        for (let k = 0; k < perGroup; k++) {
          const raw = (await invoke("core_transform", {
            request: { values, multiplier: 2, offset: 1 },
          })) as { values: number[]; checksum: number };
          if (g === 0 && k === 0) {
            reqBytes = JSON.stringify({ request: { values, multiplier: 2, offset: 1 } }).length;
            respBytes = JSON.stringify(raw).length;
            checksum = raw.checksum;
          }
        }
        const dt = performance.now() - t0;
        if (g >= 0) samples.push(dt / perGroup);
      }
      const s = stats(samples);
      cases.push({ plane: "invoke-json", n, iters, reqBytes, respBytes, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum });
      checksums.set(`json:${n}`, checksum);
    }

    // scheme / port: wire frame単位 (到達時のみ)。
    const planeSenders: Array<readonly [string, (b: Uint8Array) => Promise<Uint8Array>]> = [];
    const sch = scheme;
    if (sch !== null) planeSenders.push(["scheme-binary", (b: Uint8Array) => sch.send(b)]);
    const pm = portMsg;
    if (pm !== null) planeSenders.push(["port-message", (b: Uint8Array) => pm.send(b)]);
    for (const [plane, send] of planeSenders) {
      const frame0 = encodeReq(seq, values);
      const { samples, respBytes, checksum } = await measure(send);
      const s = stats(samples);
      cases.push({ plane, n, iters, reqBytes: frame0.length, respBytes, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum });
      checksums.set(`${plane}:${n}`, checksum);
    }
  }

  // 交差検証: 同一Nのchecksumが全方式で一致すること。
  let agreement = true;
  for (const n of sizes) {
    const set = new Set<number>();
    for (const [k, v] of checksums) {
      if (k.endsWith(`:${n}`)) set.add(v);
    }
    if (set.size !== 1) agreement = false;
  }

  // バッチスループット: N=3×32件。高頻度小メッセージの束ね効果を測る。
  {
    const values = makeValues(3);
    const frames = 32;
    const groups = 8;
    const expected = (() => {
      // 期待checksumは単発結果と一致するはず (交差検証に含める)。
      const got = checksums.get("json:3");
      if (got === undefined) throw new Error("missing single checksum");
      return got;
    })();
    async function groupSample(fn: () => Promise<void>): Promise<number[]> {
      const samples: number[] = [];
      for (let g = -1; g < groups; g++) {
        const t0 = performance.now();
        await fn();
        const dt = performance.now() - t0;
        if (g >= 0) samples.push(dt / frames);
      }
      return samples;
    }
    // 逐次json×32
    {
      const samples = await groupSample(async () => {
        for (let k = 0; k < frames; k++) {
          const raw = (await invoke("core_transform", {
            request: { values, multiplier: 2, offset: 1 },
          })) as { checksum: number };
          if (raw.checksum !== expected) throw new Error("checksum mismatch (json batch)");
        }
      });
      const s = stats(samples);
      cases.push({ plane: "seq-json-32", n: 3, iters: groups * frames, reqBytes: 76 * frames, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
    }
    // 逐次scheme×32・連結batch・Bridge (scheme到達時のみ)。
    const schBatch = scheme;
    if (schBatch !== null) {
    // 逐次scheme×32
    {
      const schSeq = schBatch;
      const samples = await groupSample(async () => {
        for (let k = 0; k < frames; k++) {
          const resp = await schSeq.send(encodeReq(5000 + k, values));
          const dec = decodeChecksum(resp);
          if (dec.checksum !== expected) throw new Error("checksum mismatch (scheme seq)");
        }
      });
      const s = stats(samples);
      cases.push({ plane: "seq-scheme-32", n: 3, iters: groups * frames, reqBytes: 40 * frames, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
    }
    // 単一fetchに32フレーム連結
    {
      const batch = (() => {
        const parts: Uint8Array[] = [];
        let total = 0;
        for (let k = 0; k < frames; k++) {
          const f = encodeReq(6000 + k, values);
          parts.push(f);
          total += f.length;
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        return out;
      })();
      const samples = await groupSample(async () => {
        const resp = await schBatch.send(batch);
        const scanned = scanFrames(resp);
        if (!scanned.ok || scanned.frames.length !== frames) {
          throw new Error("batch response shape mismatch");
        }
        for (const f of scanned.frames) {
          const dec = decodeChecksum(resp.subarray(f.offset, f.offset + f.frameLen));
          if (dec.checksum !== expected) throw new Error("checksum mismatch (scheme batch)");
        }
      });
      const s = stats(samples);
      cases.push({ plane: "batch-scheme-32", n: 3, iters: groups * frames, reqBytes: batch.length, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
    }
    // BatchingBridge経由 (製品バッチAPIのe2e)。
    {
      const samples = await groupSample(async () => {
        const bridge = new BatchingBridge(schBatch, { maxFrames: frames });
        try {
          const pending: Promise<Uint8Array>[] = [];
          for (let k = 0; k < frames; k++) {
            pending.push(bridge.submit(encodeReq(7000 + k, values)));
          }
          const resps = await Promise.all(pending);
          for (const r of resps) {
            if (decodeChecksum(r).checksum !== expected) {
              throw new Error("checksum mismatch (bridge)");
            }
          }
        } finally {
          bridge.close();
        }
      });
      const s = stats(samples);
      cases.push({ plane: "bridge-scheme-32", n: 3, iters: groups * frames, reqBytes: 40 * frames, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
    }
    } // end if (schBatch !== null)
    // 生Port逐次×32・Bridge (port到達時のみ)。
    const pmBatch = portMsg;
    if (pmBatch !== null) {
      {
        const samples = await groupSample(async () => {
          for (let k = 0; k < frames; k++) {
            const resp = await pmBatch.send(encodeReq(8000 + k, values));
            const dec = decodeChecksum(resp);
            if (dec.checksum !== expected) throw new Error("checksum mismatch (port seq)");
          }
        });
        const s = stats(samples);
        cases.push({ plane: "seq-port-32", n: 3, iters: groups * frames, reqBytes: 40 * frames, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
      }
      {
        const samples = await groupSample(async () => {
          const bridge = new BatchingBridge(pmBatch, { maxFrames: frames });
          try {
            const pending: Promise<Uint8Array>[] = [];
            for (let k = 0; k < frames; k++) {
              pending.push(bridge.submit(encodeReq(9000 + k, values)));
            }
            const resps = await Promise.all(pending);
            for (const r of resps) {
              if (decodeChecksum(r).checksum !== expected) {
                throw new Error("checksum mismatch (port bridge)");
              }
            }
          } finally {
            bridge.close();
          }
        });
        const s = stats(samples);
        cases.push({ plane: "bridge-port-32", n: 3, iters: groups * frames, reqBytes: 40 * frames, respBytes: 0, medianMs: s.median, p95Ms: s.p95, meanMs: s.mean, checksum: expected });
      }
    }
    checksums.set("batch:3", expected);
  }

  const report: BenchReport = {
    tool: "webview-bench",
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    timerQuantumMs,
    schemeReachable,
    schemeUrl,
    portReachable,
    cases,
    agreement,
  };
  const target = resolveReportTarget(window.location.search);
  if (target !== null) {
    const ok = await postReport(target, report);
    report.tool = ok ? "webview-bench:reported" : "webview-bench:report-failed";
  }
  return report;
}
