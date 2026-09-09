import type {
  ApplicationApi,
  TransformRequest,
} from "../api/application-api";
import goldenRaw from "../../tests/fixtures/golden-vectors.json";

interface GoldenValid {
  id: string;
  request: TransformRequest;
  expected: { values: number[]; checksum: number };
}

interface GoldenFile {
  valid: GoldenValid[];
  generatedCases: Array<{
    id: string;
    repeatValue?: number;
    count?: number;
    multiplier?: number;
    offset?: number;
    expectedValue?: number;
    expectedChecksum?: number;
  }>;
}

export interface SelfTestResult {
  readonly successCount: number;
  readonly successTotal: number;
  readonly invalidPassed: number;
  readonly invalidTotal: number;
  readonly failures: string[];
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 画面からも使う試験。通常のtransform実装とは分離し、共通Application APIを通す。
// 成功計算11件 (valid 10 + maximum-length) を順次比較する。
// 入力不正の件数は別表示し、C++を実行していない拒否試験を成功計算件数に含めない。
export async function runSelfTest(api: ApplicationApi): Promise<SelfTestResult> {
  const failures: string[] = [];
  const golden = goldenRaw as unknown as GoldenFile;
  let successCount = 0;
  const successTotal = golden.valid.length + 1; // + maximum-length

  for (const c of golden.valid) {
    try {
      const r = await api.transform(c.request);
      if (!arraysEqual(r.values, c.expected.values) || r.checksum !== c.expected.checksum) {
        failures.push(c.id);
      } else {
        successCount++;
      }
    } catch (e) {
      failures.push(`${c.id}:throw:${String((e as { code?: string })?.code ?? e)}`);
    }
  }

  // maximum-length生成ケース
  const max = golden.generatedCases.find((c) => c.id === "maximum-length");
  if (max?.count != null && max.repeatValue != null) {
    const req: TransformRequest = {
      values: new Array(max.count).fill(max.repeatValue),
      multiplier: max.multiplier ?? 1,
      offset: max.offset ?? 0,
    };
    try {
      const r = await api.transform(req);
      const wantVal = max.expectedValue ?? 0;
      const wantSum = max.expectedChecksum ?? 0;
      if (
        r.values.length !== max.count ||
        !r.values.every((v) => v === wantVal) ||
        r.checksum !== wantSum
      ) {
        failures.push("maximum-length");
      } else {
        successCount++;
      }
    } catch (e) {
      failures.push(`maximum-length:throw:${String((e as { code?: string })?.code ?? e)}`);
    }
  }

  // 公開APIで再現できるA-01の一部 (INVALID_ARGUMENT/LIMIT_EXCEEDEDのcode一致のみ)。
  // C++を実行していない拒否は成功計算に含めない。
  const invalidCases: Array<{ id: string; req: unknown; want: string }> = [
    { id: "fractional-value", req: { values: [1.5], multiplier: 1, offset: 0 }, want: "INVALID_ARGUMENT" },
    { id: "out-of-range-value", req: { values: [2147483648], multiplier: 1, offset: 0 }, want: "INVALID_ARGUMENT" },
    { id: "fractional-multiplier", req: { values: [1], multiplier: 0.5, offset: 0 }, want: "INVALID_ARGUMENT" },
    { id: "string-value", req: { values: ["1"], multiplier: 1, offset: 0 }, want: "INVALID_ARGUMENT" },
    { id: "missing-offset", req: { values: [1], multiplier: 1 }, want: "INVALID_ARGUMENT" },
    { id: "null-request", req: null, want: "INVALID_ARGUMENT" },
    {
      id: "too-long",
      req: { values: new Array(4097).fill(1), multiplier: 1, offset: 0 },
      want: "LIMIT_EXCEEDED",
    },
  ];
  let invalidPassed = 0;
  for (const c of invalidCases) {
    try {
      await api.transform(c.req as TransformRequest);
      failures.push(`${c.id}:expected-${c.want}-but-success`);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === c.want) invalidPassed++;
      else failures.push(`${c.id}:want-${c.want}-got-${String(code)}`);
    }
  }

  return {
    successCount,
    successTotal,
    invalidPassed,
    invalidTotal: invalidCases.length,
    failures,
  };
}
