/// <reference lib="webworker" />
// Dedicated Worker ×1。protocol検査、factory初期化、直列実行、heap確保・コピー・解放。
// DOM、UI状態、ユーザー指定URLは扱わない。
import { WORKER_PROTOCOL_VERSION } from "./worker-protocol";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";
import { isPocCoreModule, type PocCoreModule } from "./wasm-types";
import { validateTransformRequest } from "../../api/validation";
import { appError } from "../../api/errors";

declare const self: DedicatedWorkerGlobalScope;

type WorkerState = "uninitialized" | "initializing" | "ready" | "failed";

let state: WorkerState = "uninitialized";
let mod: PocCoreModule | null = null;

function reply(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function failReply(
  base: { protocolVersion: typeof WORKER_PROTOCOL_VERSION; id: number; method: WorkerRequest["method"] },
  code: Parameters<typeof appError>[0],
  message: string,
): void {
  reply({ ...base, ok: false, error: appError(code, message) });
}

// 実ABI検査と版文字列取得の共通化 (init/getInfo)。ABI違いはABI_MISMATCH返信。
// WASM呼び出しの例外はthrowせず上位handlerのcatchへ任せる (codeが変わるため)。
type CoreRead = { ok: true; version: string } | { ok: false; abi: number };
function tryReadCoreInfo(m: PocCoreModule): CoreRead {
  const abi = m._poc_core_abi_version();
  if (abi !== 1) return { ok: false, abi };
  return { ok: true, version: m.UTF8ToString(m._poc_core_version()) };
}

function abiMismatchReply(
  base: { protocolVersion: typeof WORKER_PROTOCOL_VERSION; id: number; method: WorkerRequest["method"] },
  abi: number,
): void {
  state = "failed";
  reply({ ...base, ok: false, error: appError("ABI_MISMATCH", `unsupported ABI ${String(abi)}`) });
}

function isSafePositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// test用にexportする。製品動作は変えない。
export { isSafePositiveInt };

// URL検査: 同一originの固定配下、query/hashなし、想定ファイル名のみ
export function checkUrls(moduleUrl: unknown, wasmUrl: unknown): string | null {
  if (typeof moduleUrl !== "string" || typeof wasmUrl !== "string") {
    return "moduleUrl/wasmUrl must be strings";
  }
  let mu: URL;
  let wu: URL;
  try {
    mu = new URL(moduleUrl);
    wu = new URL(wasmUrl);
  } catch {
    return "invalid URL";
  }
  const origin = self.location.origin;
  if (mu.origin !== origin || wu.origin !== origin) {
    return "URLs must be same-origin";
  }
  if (mu.search !== "" || mu.hash !== "" || wu.search !== "" || wu.hash !== "") {
    return "URLs must not contain query/hash";
  }
  if (!mu.pathname.endsWith("/wasm/poc-core.mjs")) {
    return "unexpected module filename";
  }
  if (!wu.pathname.endsWith("/wasm/poc-core.wasm")) {
    return "unexpected wasm filename";
  }
  // 同一buildの配下であること (directoryが一致)
  const mDir = mu.pathname.slice(0, mu.pathname.lastIndexOf("/"));
  const wDir = wu.pathname.slice(0, wu.pathname.lastIndexOf("/"));
  if (mDir !== wDir) {
    return "module/wasm must be in same directory";
  }
  return null;
}

// 直列実行のためのqueue。同期のC呼び出しを含めWorker内で直列処理する。
let tail: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  const run = tail.then(fn, fn);
  // unhandled抑止のためcatch済みのtailを保持する
  tail = run.catch(() => {});
}

// test用のimporter差し替え。製品は既定の動的importを使う。
let importer: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url);
export function __setImporterForTest(fn: (url: string) => Promise<unknown>): void {
  importer = fn;
}
export function __resetWorkerForTest(): void {
  state = "uninitialized";
  mod = null;
  tail = Promise.resolve();
}
export function __getWorkerStateForTest(): string {
  return state;
}

async function handleInit(
  base: { protocolVersion: typeof WORKER_PROTOCOL_VERSION; id: number; method: "init" },
  moduleUrl: string,
  wasmUrl: string,
): Promise<void> {
  // init開始時に状態を先に変更し、同時に届く重複initを拒否する
  if (state !== "uninitialized") {
    failReply(base, "INITIALIZATION_FAILED", "duplicate init");
    return;
  }
  state = "initializing";
  const urlErr = checkUrls(moduleUrl, wasmUrl);
  if (urlErr) {
    state = "failed";
    failReply(base, "INITIALIZATION_FAILED", urlErr);
    return;
  }
  try {
    const imported = await importer(moduleUrl);
    const factory = (imported as { default?: unknown }).default;
    if (typeof factory !== "function") {
      state = "failed";
      failReply(base, "INITIALIZATION_FAILED", "missing default factory");
      return;
    }
    const instance = await (factory as (opts?: unknown) => Promise<unknown>)({
      locateFile: (p: string) => {
        if (p.endsWith(".wasm")) return wasmUrl;
        return p;
      },
    });
    if (!isPocCoreModule(instance)) {
      state = "failed";
      failReply(base, "INITIALIZATION_FAILED", "invalid module exports");
      return;
    }
    // 実ABI検査。形が正しいCoreInfoのABI違いは上位でABI_MISMATCHへ扱う。
    const read = tryReadCoreInfo(instance);
    if (!read.ok) {
      abiMismatchReply(base, read.abi);
      return;
    }
    mod = instance;
    state = "ready";
    reply({ ...base, ok: true, data: { abiVersion: 1, version: read.version } });
  } catch (e) {
    state = "failed";
    const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    failReply(base, "INITIALIZATION_FAILED", `init failed: ${msg}`);
  }
}

async function handleGetInfo(base: {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  id: number;
  method: "getInfo";
}): Promise<void> {
  if (state !== "ready" || !mod) {
    failReply(base, "INITIALIZATION_FAILED", "not ready");
    return;
  }
  try {
    const m = mod;
    const read = tryReadCoreInfo(m);
    if (!read.ok) {
      abiMismatchReply(base, read.abi);
      return;
    }
    reply({ ...base, ok: true, data: { abiVersion: 1, version: read.version } });
  } catch (e) {
    state = "failed";
    const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    failReply(base, "CORE_FAILURE", `getInfo failed: ${msg}`);
  }
}

async function handleTransform(
  base: { protocolVersion: typeof WORKER_PROTOCOL_VERSION; id: number; method: "transform" },
  payload: unknown,
): Promise<void> {
  if (state !== "ready" || !mod) {
    failReply(base, "INITIALIZATION_FAILED", "not ready");
    return;
  }
  // 再検証した入力からcountを決める
  const v = validateTransformRequest(payload);
  if (!v.ok) {
    // validateTransformRequestの失敗はINVALID_ARGUMENT/LIMIT_EXCEEDEDのみ
    failReply(base, v.error.code, v.error.message);
    return;
  }
  const snap = v.validated.snapshot();
  const count = snap.values.length;
  const m = mod;
  // 04のheap手順:
  // 1. count>0なら入力と出力各count*4 byte、常にchecksum 4 byte。count=0では入出力確保を省く。
  // 2. 各_mallocの0返却を検査し、途中失敗でも確保済みをfinallyで解放する。
  let inPtr = 0;
  let outPtr = 0;
  let sumPtr = 0;
  // 確保成功した領域の一覧。_mallocは0以外の新規pointerを返す契約のため重複検査はしない。
  const allocated: number[] = [];
  try {
    if (count > 0) {
      inPtr = m._malloc(count * 4);
      if (inPtr === 0) {
        failReply(base, "OUT_OF_MEMORY", "input alloc failed");
        return;
      }
      allocated.push(inPtr);
      outPtr = m._malloc(count * 4);
      if (outPtr === 0) {
        failReply(base, "OUT_OF_MEMORY", "output alloc failed");
        return;
      }
      allocated.push(outPtr);
    }
    sumPtr = m._malloc(4);
    if (sumPtr === 0) {
      failReply(base, "OUT_OF_MEMORY", "checksum alloc failed");
      return;
    }
    allocated.push(sumPtr);

    // 3. 全確保後にHEAPを取得し、入力をコピーして実C関数を呼ぶ。
    // memory growthでviewが更新されるため、確保後に取得する。
    let heap32 = m.HEAP32;
    let heapU32 = m.HEAPU32;
    if (count > 0) {
      heap32.set(snap.values, inPtr >> 2);
    }
    // checksum領域はCが書くため初期化不要だが、 view取得の確認のため読む
    void heapU32[sumPtr >> 2];

    let status: number;
    try {
      status = m._poc_transform_i32(
        count === 0 ? 0 : inPtr,
        count,
        snap.multiplier,
        snap.offset,
        count === 0 ? 0 : outPtr,
        count,
        sumPtr,
      );
    } catch (e) {
      // WASM trap等はCORE_FAILUREでfailed化
      state = "failed";
      const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      failReply(base, "CORE_FAILURE", `transform trap: ${msg}`);
      return;
    }
    if (status !== 0) {
      // 検証済み引数でCが非0の場合はwrapper不具合としてCORE_FAILUREでfailed化
      state = "failed";
      failReply(base, "CORE_FAILURE", `C returned status=${String(status)}`);
      return;
    }
    // 4. 必要ならviewを再取得して出力を通常配列へコピーする。WASM上のsubarrayを外へ返さない。
    // subarrayはビュー (コピーなし) で、Array.fromが1回だけ実体化する (要素loopと同数の1コピーだがnative走査)。
    heap32 = m.HEAP32;
    heapU32 = m.HEAPU32;
    const outVals: number[] = Array.from(heap32.subarray(outPtr >> 2, (outPtr >> 2) + count));
    const checksum = heapU32[sumPtr >> 2] >>> 0;
    reply({ ...base, ok: true, data: { values: outVals, checksum } });
  } catch (e) {
    state = "failed";
    const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    failReply(base, "CORE_FAILURE", `transform failed: ${msg}`);
  } finally {
    // 5. 成功・失敗のいずれも全確保領域を1回ずつ_freeする。
    // runtime自体が壊れて_freeも失敗する場合はCORE_FAILUREを保ってWorkerを終了しmoduleごと回収する。
    try {
      for (const ptr of allocated) {
        m._free(ptr);
      }
    } catch {
      state = "failed";
      mod = null;
      // 既に返信済みの場合は追加返信しない。未返信の異常は上位の監視期限で検知する。
    }
  }
}

// Worker内で実行されていることを確認する (DOM参照なし)
function assertInWorker(): void {
  if (typeof self === "undefined" || typeof (self as unknown as { postMessage?: unknown }).postMessage !== "function") {
    throw new Error("not in worker");
  }
}

try {
  assertInWorker();
} catch {
  // main threadでのimport時はlistenerを登録しない
}

function getSelf(): DedicatedWorkerGlobalScope | null {
  if (typeof self === "undefined") return null;
  return self as unknown as DedicatedWorkerGlobalScope;
}

const workerSelf = getSelf();
function attachHandler(target: DedicatedWorkerGlobalScope): void {
  target.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data as Partial<WorkerRequest> & Record<string, unknown>;
  // protocol/id/method自体が壊れている場合は、対応付け不能な返信を捏造せず、
  // Workerをfailed状態にしてerrorで通知する。BrowserBackendはWORKER_FAILEDとして終了する。
  const protocolVersion = (data as { protocolVersion?: unknown }).protocolVersion;
  const id = (data as { id?: unknown }).id;
  const method = (data as { method?: unknown }).method;
  if (protocolVersion !== WORKER_PROTOCOL_VERSION || !isSafePositiveInt(id) || (method !== "init" && method !== "getInfo" && method !== "transform")) {
    state = "failed";
    mod = null;
    // errorイベントで通知する (throwはonmessageの同期実行でerrorイベントを発生させる)
    throw new Error(`invalid worker request: protocol=${String(protocolVersion)} id=${String(id)} method=${String(method)}`);
  }
  const base: {
    protocolVersion: typeof WORKER_PROTOCOL_VERSION;
    id: number;
    method: WorkerRequest["method"];
  } = {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    id: id as number,
    method: method as WorkerRequest["method"],
  };
  if (method === "init") {
    const moduleUrl = (data as { moduleUrl?: unknown }).moduleUrl;
    const wasmUrl = (data as { wasmUrl?: unknown }).wasmUrl;
    if (typeof moduleUrl !== "string" || typeof wasmUrl !== "string") {
      state = "failed";
      mod = null;
      throw new Error("invalid init URLs");
    }
    enqueue(() => handleInit({ ...base, method: "init" }, moduleUrl, wasmUrl));
  } else if (method === "getInfo") {
    enqueue(() => handleGetInfo({ ...base, method: "getInfo" }));
  } else {
    const payload = (data as { payload?: unknown }).payload;
    enqueue(() => handleTransform({ ...base, method: "transform" }, payload));
  }
  };

  target.onerror = (ev) => {
    // 未捕捉errorはfailed化の記録のみ。返信できる例外は各handlerで整形済み。
    state = "failed";
    void ev;
  };
}

// test用: Nodeでimport後にmock selfへhandlerを付け直す。製品動作は変えない。
export function __attachForTest(target: unknown): void {
  attachHandler(target as DedicatedWorkerGlobalScope);
}

if (workerSelf) {
  attachHandler(workerSelf);
}

export {};
