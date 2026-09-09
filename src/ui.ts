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
  try {
    const v = JSON.parse(t);
    return v;
  } catch {
    // "2"のような素の数字はJSONとして解釈できるが、"abc"はundefined
    return undefined;
  }
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
    reinitBtn.disabled = busy && uiState === "initializing";
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
        await backend.dispose();
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

  runBtn.addEventListener("click", () => {
    void (async () => {
      if (!backend || uiState !== "ready" || busy) return;
      const myGen = generation;
      busy = true;
      setButtonsEnabled();
      const t0 = performance.now();
      try {
        const req = {
          values: parseValues(valuesEl.value) as number[],
          multiplier: parseIntField(mulEl.value) as number,
          offset: parseIntField(offEl.value) as number,
        };
        // UIの入力解析後もBackend側で同じ規則を検査する (undefined等はINVALID)
        const r = await backend.transform(req as never);
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
        const ce = e as { code?: string };
        if (
          ce.code === "TIMEOUT" ||
          ce.code === "TRANSPORT_ERROR" ||
          ce.code === "WORKER_FAILED" ||
          ce.code === "CORE_FAILURE" ||
          ce.code === "ABI_MISMATCH"
        ) {
          setState("failed", errorEl.textContent);
        }
      } finally {
        if (myGen === generation) {
          busy = false;
          setButtonsEnabled();
        }
      }
    })();
  });

  selfBtn.addEventListener("click", () => {
    void (async () => {
      if (!backend || uiState !== "ready" || busy) return;
      const myGen = generation;
      busy = true;
      setButtonsEnabled();
      selfResultEl.textContent = "self-test: running...";
      try {
        const r = await runSelfTest(backend);
        if (myGen !== generation) return;
        selfResultEl.textContent =
          `self-test: success ${String(r.successCount)}/${String(r.successTotal)}, invalid ${String(r.invalidPassed)}/${String(r.invalidTotal)}` +
          (r.failures.length > 0 ? ` failures: ${r.failures.join(",")}` : "");
      } catch (e) {
        if (myGen !== generation) return;
        selfResultEl.textContent = `self-test: failed ${String(e)}`;
      } finally {
        if (myGen === generation) {
          busy = false;
          setButtonsEnabled();
        }
      }
    })();
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
