import type {
  AppError,
  ApplicationApi,
  RuntimeInfo,
  TransformRequest,
  TransformResult,
} from "../../api/application-api";
import { appError, isAppErrorCode, normalizeInvokeRejection } from "../../api/errors";
import {
  validateRuntimeInfo,
  validateTransformRequest,
  validateTransformResult,
} from "../../api/validation";
import { RequestState } from "../request-state";
import { checkResultLength, isSingleFailure, raceWithGuard } from "../pipeline";
import { TransportError } from "../transport/bridge-interface";
import { InvokeB64Transport } from "../transport/transport-b64";
import {
  POCBIN_TRANSFORM_URL,
  SchemeBinaryTransport,
  probeSchemeEndpoint,
  type FetchFn,
  type SchemeEndpoint,
  type SchemeHttpMethod,
} from "../transport/transport-scheme";
import {
  decodeTransformResponse,
  encodeTransformRequest,
  scanFrames,
  valuesToArray,
} from "../../api/wire";

export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** transform用データプレーン。getInfo等の制御プレーンは常にJSON invoke。
 * - "json": 従来動作 (既定・最安全)。
 * - "b64": `poc_transform_bin` へbase64 batch。
 * - "scheme": `pocbin:` へraw binary fetch (最速)。
 * - "auto": scheme到達を確認できればscheme、不可ならjsonへ無音fallback。
 */
export type TauriDataPlane = "json" | "b64" | "scheme" | "auto";

async function realInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const mod = await import("@tauri-apps/api/core");
  return (mod as { invoke: InvokeFn }).invoke(cmd, args);
}

/** binary系拒否値の正規化。server由来の {code,message} は引き継ぐ。 */
function normalizeBinaryRejection(reason: unknown): AppError {
  if (reason instanceof TransportError && isAppErrorCode(reason.code)) {
    return appError(reason.code, reason.message);
  }
  if (reason instanceof Error) {
    return appError("TRANSPORT_ERROR", `binary transport failed: ${reason.message.slice(0, 200)}`);
  }
  return appError("TRANSPORT_ERROR", "binary transport failed");
}

export interface TauriBackendDeps {
  readonly invoke?: InvokeFn;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly dataPlane?: TauriDataPlane;
  readonly fetchFn?: FetchFn;
}

class TauriBackend implements ApplicationApi {
  private readonly invoke: InvokeFn;
  private readonly state: RequestState;
  private readonly dataPlaneOpt: TauriDataPlane;
  private readonly fetchFn?: FetchFn;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private plane: "json" | "b64" | "scheme" = "json";
  private schemeTransport: SchemeBinaryTransport | null = null;
  private schemeTransformUrl: string = POCBIN_TRANSFORM_URL;
  private schemeMethod: SchemeHttpMethod = "POST";

  constructor(deps: TauriBackendDeps = {}) {
    this.invoke = deps.invoke ?? realInvoke;
    this.fetchFn = deps.fetchFn;
    this.dataPlaneOpt = deps.dataPlane ?? "json";
    if (this.dataPlaneOpt === "b64") this.plane = "b64";
    if (this.dataPlaneOpt === "scheme") this.plane = "scheme";
    this.setTimeoutFn =
      deps.setTimeoutFn ??
      (((fn: (...a: never[]) => void, ms?: number, ...args: never[]) =>
        globalThis.setTimeout(fn, ms, ...args)) as unknown as typeof setTimeout);
    this.clearTimeoutFn =
      deps.clearTimeoutFn ??
      (((h: Parameters<typeof clearTimeout>[0]) =>
        globalThis.clearTimeout(h)) as unknown as typeof clearTimeout);
    this.state = new RequestState({
      initTimeoutMs: deps.initTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    });
  }

  // factoryはinit扱いで実getInfoを待ち、応答/ABI検査後にresolveする。
  async init(): Promise<void> {
    let guardId = -1;
    let guard: Promise<unknown> | null = null;
    try {
      const reg = this.state.register("getInfo", { init: true });
      guardId = reg.id;
      guard = reg.promise;
      // unhandled抑止のためcatchを付ける (raceでも処理するが二重安全)
      guard.catch(() => {});
      const invokeP = this.invoke("poc_get_info");
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "init timed out");
      const checked = validateRuntimeInfo(raw);
      if (!checked.ok) {
        // 形が正しくABIだけ違う場合はABI_MISMATCHでfailedへ
        this.state.failAll(checked.error);
        throw checked.error;
      }
      // invoke開始前にpending登録済み、成功でtimerを片付ける
      this.state.resolveOne(guardId, checked.info);
      // データプレーン確定。probe自体は有界時間で打ち切る。
      await this.resolveDataPlane();
      this.state.markReady();
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        // TIMEOUT等で既にfailed化済み
        throw saved;
      }
      const normalized = normalizeInvokeRejection(e);
      // 初期化失敗はINITIALIZATION_FAILED等でfailed化し、timer/listenerを片付ける
      const code =
        normalized.code === "ABI_MISMATCH" ||
        normalized.code === "TIMEOUT" ||
        normalized.code === "TRANSPORT_ERROR" ||
        normalized.code === "CORE_FAILURE"
          ? normalized
          : appError(
              "INITIALIZATION_FAILED",
              `init failed: ${normalized.code}: ${normalized.message}`,
            );
      // guardが残っていれば片付ける
      if (guardId >= 0) {
        this.state.rejectOne(guardId, code);
      }
      this.state.failAll(code);
      // 初期化に失敗したインスタンスを公開APIとして返さないため、factory側でrejectする
      throw code;
    }
  }

  /** test/UI用: init後に確定したtransform用データプレーン */
  get resolvedDataPlane(): "json" | "b64" | "scheme" {
    return this.plane;
  }

  /** scheme到達probe (有界時間)。timeout・失敗時はnull (json fallback用)。 */
  private probeSchemeBounded(): Promise<SchemeEndpoint | null> {
    return new Promise((resolve) => {
      let done = false;
      const timer = this.setTimeoutFn(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, 3000);
      probeSchemeEndpoint(this.fetchFn).then(
        (ep) => {
          if (!done) {
            done = true;
            this.clearTimeoutFn(timer);
            resolve(ep);
          }
        },
        () => {
          if (!done) {
            done = true;
            this.clearTimeoutFn(timer);
            resolve(null);
          }
        },
      );
    });
  }

  private async resolveDataPlane(): Promise<void> {
    if (this.dataPlaneOpt === "scheme") {
      // 明示指定: 到達可能なendpoint (URL+方式) をピン留めする。
      // どちらも不可の場合は初期化失敗として扱う (黙ってjsonに落とさない)。
      const pinned = await this.probeSchemeBounded();
      if (pinned === null) {
        const err = appError("INITIALIZATION_FAILED", "scheme transport unreachable");
        this.state.failAll(err);
        throw err;
      }
      try {
        this.schemeTransport = new SchemeBinaryTransport({
          fetchFn: this.fetchFn,
          transformUrl: pinned.transformUrl,
          method: pinned.method,
        });
      } catch (e) {
        const err = appError(
          "INITIALIZATION_FAILED",
          `scheme transport unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        this.state.failAll(err);
        throw err;
      }
      this.schemeTransformUrl = pinned.transformUrl;
      this.schemeMethod = pinned.method;
      this.plane = "scheme";
      return;
    }
    if (this.dataPlaneOpt === "auto") {
      const pinned = await this.probeSchemeBounded();
      // POST到達ならschemeが最速。GET迂回のみの環境 (Android相当) では
      // 単発はinvoke-b64が速いためb64を選ぶ (emulator実測)。
      if (pinned !== null && pinned.method === "POST") {
        try {
          this.schemeTransport = new SchemeBinaryTransport({
            fetchFn: this.fetchFn,
            transformUrl: pinned.transformUrl,
            method: pinned.method,
          });
          this.schemeTransformUrl = pinned.transformUrl;
          this.schemeMethod = pinned.method;
          this.plane = "scheme";
          return;
        } catch {
          // 構築失敗は下のb64/jsonへ
        }
      }
      if (pinned !== null && pinned.method === "GET") {
        this.plane = "b64";
        return;
      }
      this.plane = "json";
      return;
    }
    // "json" / "b64" はconstructorで確定済み
  }

  async getInfo(): Promise<RuntimeInfo> {
    this.state.throwIfNotReady();
    const reg = this.state.register("getInfo");
    const guard = reg.promise;
    guard.catch(() => {});
    const invokeP = this.invoke("poc_get_info");
    try {
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "timed out");
      const checked = validateRuntimeInfo(raw);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.state.rejectOne(reg.id, checked.error);
        throw checked.error;
      }
      this.state.resolveOne(reg.id, checked.info);
      return checked.info;
    } catch (e) {
      // guard起因のTIMEOUT/failedは保存した失敗を返す
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        // invoke側の遅延到着はstaleとして破棄される (pending削除済み)
        throw saved;
      }
      const normalized = normalizeInvokeRejection(e);
      if (isSingleFailure(normalized.code)) {
        // 当該要求だけreject、ready維持 (通常はgetInfoで単発エラーは起きないが規定どおり)
        this.state.rejectOne(reg.id, normalized);
        throw normalized;
      }
      this.state.failAll(normalized);
      this.state.rejectOne(reg.id, normalized);
      throw normalized;
    }
  }

  async transform(request: TransformRequest): Promise<TransformResult> {
    this.state.throwIfNotReady();
    // 入力検証と応答検証は小さな共通関数。検査済み入力を最初のawaitより前にコピーする。
    const v = validateTransformRequest(request as unknown);
    if (!v.ok) throw v.error;
    const snap = v.validated.snapshot();
    const reg = this.state.register("transform");
    const guard = reg.promise;
    guard.catch(() => {});
    // invoke開始前にpending登録済み。binary系はwire frame化して送る。
    const invokeP =
      this.plane === "json"
        ? this.invoke("poc_transform", { request: snap })
        : this.sendBinaryFrame(snap, reg.id & 0xffff);
    try {
      const raw = await raceWithGuard(invokeP, guard, () => this.state.getSavedFailure(), "timed out");
      // 成功値の形を検査する。field欠落・余分・不正型はTRANSPORT_ERROR。
      const checked = validateTransformResult(raw);
      if (!checked.ok) {
        this.state.failAll(checked.error);
        this.state.rejectOne(reg.id, checked.error);
        throw checked.error;
      }
      // 出力長が要求と一致するかも検査する (壊れた応答の拒否)
      const lengthError = checkResultLength(checked.result.values.length, snap.values.length);
      if (lengthError) {
        this.state.failAll(lengthError);
        this.state.rejectOne(reg.id, lengthError);
        throw lengthError;
      }
      this.state.resolveOne(reg.id, checked.result);
      // validationでtransportから切り離し済みのfreeze配列をそのまま返す (再コピー不要)。
      // 入力・他要求から独立し、readonlyのためcallerが壊せない。
      return checked.result;
    } catch (e) {
      const saved = this.state.getSavedFailure();
      if (saved && this.state.lifecycle === "failed") {
        throw saved;
      }
      const normalized =
        this.plane === "json" ? normalizeInvokeRejection(e) : normalizeBinaryRejection(e);
      // AppErrorのうち単発で済むものは当該要求だけrejectしready維持
      if (isSingleFailure(normalized.code)) {
        this.state.rejectOne(reg.id, normalized);
        throw normalized;
      }
      // Cの予期しないstatus、内部不備、IPC送受信失敗等はfailedへ
      this.state.failAll(normalized);
      this.state.rejectOne(reg.id, normalized);
      throw normalized;
    }
  }

  /** binary系データプレーンで1フレーム送受信し、検証済み成功値を返す。 */
  private async sendBinaryFrame(
    snap: { values: number[]; multiplier: number; offset: number },
    sequence: number,
  ): Promise<{ values: number[]; checksum: number }> {
    let req: Uint8Array;
    try {
      const buf = new Uint8Array(16 + 12 + snap.values.length * 4);
      const n = encodeTransformRequest(buf, 0, {
        sequence,
        values: snap.values,
        multiplier: snap.multiplier,
        offset: snap.offset,
      });
      req = buf.slice(0, n);
    } catch (e) {
      // 検証済み入力では到達不能な防御。WireEncodeErrorは輸送失敗扱い。
      throw new TransportError("TRANSPORT_ERROR", `wire encode failed: ${String(e).slice(0, 200)}`);
    }
    let resp: Uint8Array;
    if (this.plane === "b64") {
      resp = await new InvokeB64Transport({ invoke: this.invoke }).send(req);
    } else {
      const t =
        this.schemeTransport ??
        new SchemeBinaryTransport({
          fetchFn: this.fetchFn,
          transformUrl: this.schemeTransformUrl,
          method: this.schemeMethod,
        });
      this.schemeTransport = t;
      resp = await t.send(req);
    }
    const scanned = scanFrames(resp);
    if (
      !scanned.ok ||
      scanned.frames.length !== 1 ||
      scanned.frames[0]!.header.sequence !== sequence
    ) {
      throw new TransportError("TRANSPORT_ERROR", "binary response mismatch");
    }
    const f = scanned.frames[0]!;
    const dec = decodeTransformResponse(resp.subarray(f.offset, f.offset + f.frameLen));
    if (!dec.ok) {
      throw new TransportError("TRANSPORT_ERROR", `bad response frame: ${dec.error.message}`);
    }
    return { values: valuesToArray(dec.valuesBytes, dec.count), checksum: dec.checksum };
  }

  async dispose(): Promise<void> {
    this.state.dispose();
  }

  /** test用: 現在のlifecycleとpending数 */
  debugState(): { lifecycle: string; pending: number } {
    return { lifecycle: this.state.lifecycle, pending: this.state.pendingCount };
  }
}

// 公開factoryは引数なし
export async function createTauriBackend(deps: TauriBackendDeps = {}): Promise<ApplicationApi> {
  const backend = new TauriBackend(deps);
  await backend.init();
  return backend;
}

// composition root用の統一名 (web/nativeで同じapps/poc-demo/main.ts/ui.tsを使う)
// native既定はauto: scheme到達時は最速経路、不可時は従来JSONへ無音fallback。
export async function createBackend(): Promise<ApplicationApi> {
  return createTauriBackend({ dataPlane: "auto" });
}

// test用のinvoke/clock注入は内部関数だけに設ける
export async function createTauriBackendWithDeps(
  deps: TauriBackendDeps,
): Promise<ApplicationApi> {
  const backend = new TauriBackend(deps);
  await backend.init();
  return backend;
}

export function createTauriBackendForTest(deps: TauriBackendDeps): TauriBackend {
  return new TauriBackend(deps);
}
