import type { ApplicationApi } from "./api/application-api";
import { runSelfTest } from "./self-test/runner";
import { createBackend } from "@backend";

type UiState = "initializing" | "ready" | "failed" | "disposed";

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function parseValues(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// 空の数値欄を0へ変換しない。空欄はINVALIDとして扱う。
function parseIntField(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return undefined;
  // 整数欄: JSON数値として解釈し、空・不正はundefinedで返す
  // ("2"のような素の数字はJSONとして解釈できるが、"abc"はundefined)
  return parseValues(t);
}

export async function boot(): Promise<void> {
  const statusEl = el("status");
  const backendInfoEl = el("backend-info");
  const errorEl = el("error");
  const valuesEl = el<HTMLInputElement>("values");
  const mulEl = el<HTMLInputElement>("multiplier");
  const offEl = el<HTMLInputElement>("offset");
  const runBtn = el<HTMLButtonElement>("run");
  const selfBtn = el<HTMLButtonElement>("selftest");
  const disposeBtn = el<HTMLButtonElement>("dispose");
  const reinitBtn = el<HTMLButtonElement>("reinit");
  const resultEl = el("result");
  const roundtripEl = el("roundtrip");
  const selfResultEl = el("selftest-result");

  let generation = 0;
  let backend: ApplicationApi | null = null;
  let uiState: UiState = "initializing";
  let busy = false;

  function setState(s: UiState, msg = ""): void {
    uiState = s;
    statusEl.textContent = s;
    if (msg) errorEl.textContent = msg;
    else if (s === "ready" || s === "initializing") errorEl.textContent = "";
  }

  function setButtonsEnabled(): void {
    const canRun = uiState === "ready" && !busy;
    runBtn.disabled = !canRun;
    selfBtn.disabled = !canRun;
    // 実行中は再初期化も受け付けない (handler側でもbusyで無視する二重化)。
    reinitBtn.disabled = busy;
  }

  async function setupBackend(): Promise<void> {
    const myGen = ++generation;
    setState("initializing");
    setButtonsEnabled();
    backendInfoEl.textContent = "backend: -";
    let next: ApplicationApi;
    try {
      next = await createBackend();
    } catch (e) {
      // 古いfactory完了・エラーで新UIを更新しない
      if (myGen !== generation) {
        return;
      }
      const code = (e as { code?: string })?.code ?? "INITIALIZATION_FAILED";
      const msg = (e as { message?: string })?.message ?? String(e);
      setState("failed", `${code}: ${msg}`);
      setButtonsEnabled();
      return;
    }
    if (myGen !== generation) {
      // 旧factoryが新世代の後に成功: 旧instanceをdisposeし、新UIへ渡さない
      try {
        await next.dispose();
      } catch {
        // ignore
      }
      return;
    }
    backend = next;
    try {
      const info = await backend.getInfo();
      if (myGen !== generation) {
        // このsetupが作ったinstanceを片付ける。共有変数は破棄側が既にnull化済みのため触らない。
        await next.dispose();
        return;
      }
      backendInfoEl.textContent =
        `backend: ${info.backend} execution: ${info.execution} hostOs: ${info.hostOs} abi: ${String(info.core.abiVersion)} version: ${info.core.version}`;
      setState("ready");
    } catch (e) {
      if (myGen !== generation) return;
      const code = (e as { code?: string })?.code ?? "INITIALIZATION_FAILED";
      const msg = (e as { message?: string })?.message ?? String(e);
      setState("failed", `${code}: ${msg}`);
    }
    setButtonsEnabled();
  }

  // 実行中は単一操作に限る。世代が進んだ (破棄・再初期化された) 完了はUIへ反映しない。
  // busy解除は同一世代の完了だけが行い、破棄側が既に整えた状態を上書きしない。
  // backend参照はガード直後に固定し、taskへ渡す (世代管理は呼び出し側と共有する)。
  async function withBusy(task: (myGen: number, api: ApplicationApi) => Promise<void>): Promise<void> {
    const api = backend;
    if (!api || uiState !== "ready" || busy) return;
    const myGen = generation;
    busy = true;
    setButtonsEnabled();
    try {
      await task(myGen, api);
    } finally {
      if (myGen === generation) {
        busy = false;
        setButtonsEnabled();
      }
    }
  }

  runBtn.addEventListener("click", () => {
    void withBusy(async (myGen, api) => {
      const t0 = performance.now();
      try {
        const req = {
          values: parseValues(valuesEl.value) as number[],
          multiplier: parseIntField(mulEl.value) as number,
          offset: parseIntField(offEl.value) as number,
        };
        // UI入力は動的で、実行時の不正はBackend側のvalidationがINVALIDとして返す。
        // reqの形はTransformRequestに合わせ、不正値はundefinedキャストで表現する。
        const r = await api.transform(req);
        if (myGen !== generation) return;
        resultEl.textContent = `result: [${r.values.join(",")}] checksum=${String(r.checksum)}`;
        const dt = performance.now() - t0;
        roundtripEl.textContent = `roundtrip: ${dt.toFixed(1)}ms (参考値。C++単体速度ではない)`;
        errorEl.textContent = "";
      } catch (e) {
        if (myGen !== generation) return;
        const code = (e as { code?: string })?.code ?? "TRANSPORT_ERROR";
        const msg = (e as { message?: string })?.message ?? String(e);
        resultEl.textContent = "result: -";
        errorEl.textContent = `${code}: ${msg}`;
        // eはnullの可能性もあるため直接参照しない (上と同じ任意検査にする)
        const ceCode = (e as { code?: string } | null | undefined)?.code;
        if (
          ceCode === "TIMEOUT" ||
          ceCode === "TRANSPORT_ERROR" ||
          ceCode === "WORKER_FAILED" ||
          ceCode === "CORE_FAILURE" ||
          ceCode === "ABI_MISMATCH"
        ) {
          setState("failed", errorEl.textContent);
        }
      }
    });
  });

  selfBtn.addEventListener("click", () => {
    void withBusy(async (myGen, api) => {
      selfResultEl.textContent = "self-test: running...";
      try {
        const r = await runSelfTest(api);
        if (myGen !== generation) return;
        selfResultEl.textContent =
          `self-test: success ${String(r.successCount)}/${String(r.successTotal)}, invalid ${String(r.invalidPassed)}/${String(r.invalidTotal)}` +
          (r.failures.length > 0 ? ` failures: ${r.failures.join(",")}` : "");
      } catch (e) {
        if (myGen !== generation) return;
        selfResultEl.textContent = `self-test: failed ${String(e)}`;
      }
    });
  });

  disposeBtn.addEventListener("click", () => {
    void (async () => {
      // 破棄操作は実行中にも受け付ける
      const b = backend;
      backend = null;
      generation++;
      busy = false;
      if (b) {
        try {
          await b.dispose();
        } catch {
          // ignore
        }
      }
      resultEl.textContent = "result: -";
      setState("disposed", "");
      setButtonsEnabled();
    })();
  });

  reinitBtn.addEventListener("click", () => {
    void (async () => {
      if (busy) return;
      const b = backend;
      backend = null;
      generation++;
      if (b) {
        try {
          await b.dispose();
        } catch {
          // ignore
        }
      }
      // 再初期化は新インスタンスを作る操作。旧Backendのdispose完了を待ってから生成する。
      await setupBackend();
    })();
  });

  setButtonsEnabled();
  await setupBackend();
}
