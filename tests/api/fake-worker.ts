import { vi } from "vitest";
import { WORKER_PROTOCOL_VERSION } from "../../packages/backends/browser/worker-protocol";

// BrowserBackend試験用の最小fake Worker。共有して三重管理を防ぐ。
// postMessageで即時に正規返信を返す。onPostで応答の差し替え、hangInitでinit無応答、
// throwOnPostで送信失敗を再現する。
export interface FakeWorkerMessage {
  id: number;
  method: string;
  payload?: unknown;
}

export type FakeWorker = Worker & {
  __emitMessage: (data: unknown) => void;
  __emitError: () => void;
  __emitMessageError: () => void;
};

export function makeFakeWorker(opts: {
  onPost?: (msg: FakeWorkerMessage) => unknown;
  hangInit?: boolean;
  throwOnPost?: boolean;
} = {}): FakeWorker {
  const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>();
  let errorHandler: (() => void) | null = null;
  let messageErrorHandler: (() => void) | null = null;
  const worker = {
    postMessage: vi.fn((msg: FakeWorkerMessage) => {
      if (opts.throwOnPost) throw new Error("post fail");
      if (opts.hangInit && msg.method === "init") return;
      const data = opts.onPost
        ? opts.onPost(msg)
        : msg.method === "transform"
          ? (() => {
              const p = msg.payload as { values: number[]; multiplier: number; offset: number };
              const values = p.values.map((v) => Math.max(-2147483648, Math.min(2147483647, v * p.multiplier + p.offset)));
              let sum = 0;
              for (const v of values) sum = (sum + (v >>> 0)) >>> 0;
              return { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: "transform", ok: true, data: { values, checksum: sum } };
            })()
          : { protocolVersion: WORKER_PROTOCOL_VERSION, id: msg.id, method: msg.method, ok: true, data: { abiVersion: 1, version: "0.1.0" } };
      queueMicrotask(() => {
        for (const fn of listeners.get("message") ?? []) fn({ data });
      });
    }),
    terminate: vi.fn(),
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      if (fn) {
        if (!listeners.has("message")) listeners.set("message", new Set());
        listeners.get("message")!.clear();
        listeners.get("message")!.add(fn as (ev: { data: unknown }) => void);
      } else listeners.get("message")?.clear();
    },
    get onmessage() {
      return null;
    },
    set onerror(fn: (() => void) | null) {
      errorHandler = fn;
    },
    get onerror() {
      return errorHandler;
    },
    set onmessageerror(fn: (() => void) | null) {
      messageErrorHandler = fn;
    },
    get onmessageerror() {
      return messageErrorHandler;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __emitMessage(data: unknown) {
      for (const fn of listeners.get("message") ?? []) fn({ data });
    },
    __emitError() {
      errorHandler?.();
    },
    __emitMessageError() {
      messageErrorHandler?.();
    },
  };
  return worker as unknown as FakeWorker;
}
