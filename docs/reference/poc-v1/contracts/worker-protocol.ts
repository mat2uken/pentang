/** BrowserBackend と Dedicated Worker 内部だけの契約。公開APIではない。 */
import type {
  AppError,
  CoreInfo,
  TransformRequest,
  TransformResult,
} from "./application-api";

export const WORKER_PROTOCOL_VERSION = 1 as const;

interface RequestBase {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  /** 一つの Backend インスタンス内で単調増加。安全な正整数。 */
  readonly id: number;
}

export type WorkerRequest =
  | (RequestBase & {
      readonly method: "init";
      /** composition root が構築した同一originのURL。ユーザー入力にしない。 */
      readonly moduleUrl: string;
      readonly wasmUrl: string;
    })
  | (RequestBase & { readonly method: "getInfo" })
  | (RequestBase & {
      readonly method: "transform";
      readonly payload: TransformRequest;
    });

export type WorkerSuccess =
  | (RequestBase & {
      readonly ok: true;
      readonly method: "init" | "getInfo";
      readonly data: CoreInfo;
    })
  | (RequestBase & {
      readonly ok: true;
      readonly method: "transform";
      readonly data: TransformResult;
    });

export type WorkerFailure = RequestBase & {
  readonly ok: false;
  readonly method: WorkerRequest["method"];
  readonly error: AppError;
};

export type WorkerResponse = WorkerSuccess | WorkerFailure;
