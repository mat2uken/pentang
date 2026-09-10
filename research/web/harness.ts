// test用TS入口。Worker単独を呼び、factory/exports/basic/empty/ABI/golden11件を確認する。
// 通常buildの入口へ追加しない。
import goldenFile from "../../packages/api/fixtures/golden-vectors.json";

type GoldenValid = {
  id: string;
  request: { values: number[]; multiplier: number; offset: number };
  expected: { values: number[]; checksum: number };
};

const out = document.getElementById("out")!;

function log(msg: string): void {
  out.textContent += `\n${msg}`;
  console.log(msg);
}

type WorkerReq = {
  protocolVersion: number;
  id: number;
  method: string;
  moduleUrl?: string;
  wasmUrl?: string;
  payload?: unknown;
};

function callWorker(
  worker: Worker,
  req: WorkerReq,
  timeoutMs = 15000,
): Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } } & { id: number; method: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", onMsg);
      reject(new Error(`timeout id=${String(req.id)}`));
    }, timeoutMs);
    function onMsg(ev: MessageEvent): void {
      const d = ev.data as { id?: unknown };
      if (d?.id !== req.id) return;
      clearTimeout(timer);
      worker.removeEventListener("message", onMsg);
      resolve(ev.data as never);
    }
    worker.addEventListener("message", onMsg);
    worker.postMessage(req);
  });
}

async function main(): Promise<void> {
  out.textContent = "running...";
  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  const moduleUrl = new URL("wasm/poc-core.mjs", base).toString();
  const wasmUrl = new URL("wasm/poc-core.wasm", base).toString();
  log(`moduleUrl=${moduleUrl}`);
  log(`wasmUrl=${wasmUrl}`);
  const worker = new Worker(new URL("../../packages/backends/browser/core.worker.ts", import.meta.url), {
    type: "module",
  });
  let failed = 0;
  const ok = (id: string, cond: boolean, extra = ""): void => {
    log(`${cond ? "ok" : "FAIL"} ${id} ${extra}`);
    if (!cond) failed++;
  };
  try {
    const init = await callWorker(worker, { protocolVersion: 1, id: 1, method: "init", moduleUrl, wasmUrl });
    ok("init.ok", init.ok === true, JSON.stringify(init));
    const core = (init as { data?: { abiVersion?: unknown; version?: unknown } }).data;
    ok("abi", core?.abiVersion === 1, `abi=${String(core?.abiVersion)}`);
    ok("version", core?.version === "0.1.0", `version=${String(core?.version)}`);

    const info = await callWorker(worker, { protocolVersion: 1, id: 2, method: "getInfo" });
    ok("getInfo.ok", info.ok === true, JSON.stringify(info));

    const basic = await callWorker(worker, {
      protocolVersion: 1,
      id: 3,
      method: "transform",
      payload: { values: [1, 2, 3], multiplier: 2, offset: 1 },
    });
    ok(
      "basic",
      basic.ok === true &&
        JSON.stringify((basic as { data?: unknown }).data) ===
          JSON.stringify({ values: [3, 5, 7], checksum: 15 }),
      JSON.stringify(basic),
    );

    const empty = await callWorker(worker, {
      protocolVersion: 1,
      id: 4,
      method: "transform",
      payload: { values: [], multiplier: 1, offset: 0 },
    });
    ok(
      "empty",
      empty.ok === true &&
        JSON.stringify((empty as { data?: unknown }).data) ===
          JSON.stringify({ values: [], checksum: 0 }),
      JSON.stringify(empty),
    );

    // golden 11件 (valid 10 + maximum-length)
    const golden = goldenFile as {
      valid: GoldenValid[];
    };
    let id = 10;
    for (const c of golden.valid) {
      id++;
      const r = await callWorker(worker, { protocolVersion: 1, id, method: "transform", payload: c.request });
      const d = (r as { data?: { values?: number[]; checksum?: number } }).data;
      const pass =
        r.ok === true &&
        JSON.stringify(d?.values) === JSON.stringify(c.expected.values) &&
        d?.checksum === c.expected.checksum;
      ok(`golden.${c.id}`, pass, pass ? "" : JSON.stringify(r));
    }
    // maximum-length
    id++;
    const maxReq = { values: new Array(4096).fill(1), multiplier: 2, offset: 1 };
    const maxR = await callWorker(worker, { protocolVersion: 1, id, method: "transform", payload: maxReq });
    const maxD = (maxR as { data?: { values?: number[]; checksum?: number } }).data;
    ok(
      "golden.maximum-length",
      maxR.ok === true && maxD?.values?.length === 4096 && maxD.values.every((v) => v === 3) && maxD.checksum === 12288,
      `len=${String(maxD?.values?.length)} sum=${String(maxD?.checksum)}`,
    );
  } catch (e) {
    ok("harness.exception", false, String(e));
  } finally {
    worker.terminate();
    log(failed === 0 ? "HARNESS PASS" : `HARNESS FAIL (${String(failed)})`);
    (window as unknown as { __harnessDone?: boolean; __harnessFailed?: number }).__harnessDone = true;
    (window as unknown as { __harnessFailed?: number }).__harnessFailed = failed;
  }
}

void main();
