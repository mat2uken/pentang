// Real-WebView IPC benchmark: drives ?bench=1 and records the report.
// Asserts cross-plane agreement and scheme reachability; numbers are recorded,
// selection happens offline in .lab-state/bench/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BENCH_TIMEOUT = 180000;

describe("Tauri WebView IPC bench", () => {
  it("runs all data planes and agrees on checksums", async () => {
    const plugin = await browser.execute(() => typeof window.wdioTauri !== "undefined");
    if (!plugin) {
      throw new Error("guest plugin missing: rebuild the binary with VITE_WDIO=1");
    }
    await browser.url("tauri://localhost/?bench=1");
    const out = await browser.$("#bench-output");
    await out.waitForExist({ timeout: 60000 });
    await browser.waitUntil(
      async () => {
        const t = await out.getText();
        return t.includes("webview-bench") || t.includes("\"error\"");
      },
      { timeout: BENCH_TIMEOUT, interval: 1000, timeoutMsg: "bench did not finish" },
    );
    const text = await out.getText();
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      throw new Error(`bench output not JSON: ${text.slice(0, 500)}`);
    }
    if (report.error) throw new Error(`bench failed in page: ${report.error}`);

    const dir = path.resolve(process.cwd(), ".lab-state/bench");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const file = path.join(dir, `webview-${stamp}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    console.log(`bench saved: ${file}`);

    // Print a compact table into the wdio log for the run record.
    console.log("| plane | N | iters | reqB | respB | medianMs | p95Ms |");
    for (const c of report.cases) {
      console.log(
        `| ${c.plane} | ${c.n} | ${c.iters} | ${c.reqBytes} | ${c.respBytes} | ${c.medianMs.toFixed(3)} | ${c.p95Ms.toFixed(3)} |`,
      );
    }

    if (!report.agreement) throw new Error("checksum agreement failed across planes");
    const planes = new Set(report.cases.map((c) => c.plane));
    if (!planes.has("invoke-json")) throw new Error("missing plane in report: invoke-json");
    // バイナリ面は環境到達に応じて scheme-binary / port-message のいずれかが必須。
    if (!planes.has("scheme-binary") && !planes.has("port-message")) {
      throw new Error("missing binary plane in report");
    }
    // 生Port公開環境 (Android) ではport系も必須とする。
    if (report.portReachable) {
      for (const p of ["port-message", "seq-port-32", "bridge-port-32"]) {
        if (!planes.has(p)) throw new Error(`missing plane in report: ${p}`);
      }
    }
  });
});
