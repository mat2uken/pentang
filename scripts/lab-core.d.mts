export const ROOT: string;
export const RUN_SCHEMA_VERSION: number;
export const PROFILES: Readonly<Record<string, readonly string[]>>;

export type LabStep = {
  id: string;
  status: string;
  [key: string]: unknown;
};

export type RunRecord = {
  schemaVersion: number;
  id: string;
  status: string;
  verification: string;
  profile: string;
  profiles: string[];
  requestedTargets: string[];
  startedAt: string;
  finishedAt: string | null;
  source: Record<string, unknown>;
  steps: LabStep[];
  services: Array<Record<string, unknown>>;
  leases: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  manualActions: string[];
  errors: string[];
  [key: string]: unknown;
};

export function parseArgs(argv: string[]): { _: string[]; values: Record<string, string | boolean> };
export function redactedIdentifier(value: unknown): string;
export function safeName(value: unknown): string;
export function sha256Bytes(bytes: Uint8Array): string;
export function sha256Text(text: string): string;
export function sha256File(filePath: string): string;
export function hashFileList(root: string, relativePaths: string[]): string;
export function sourceHash(root: string, files?: string[] | null): string;
export function classifyChangedFiles(files: string[]): {
  files: string[];
  code: boolean;
  web: boolean;
  native: boolean;
  device: boolean;
  docsOnly: boolean;
};
export function selectProfiles(options?: { profile?: string; changedFiles?: string[] }): string[];
export function createRunRecord(options: {
  id: string;
  profile: string;
  profiles: string[];
  source: Record<string, unknown>;
  requestedTargets?: string[];
}): RunRecord;
export function validateRunRecord(record: unknown): { ok: boolean; errors: string[] };
export function finalRunState(stepStatuses: string[]): { status: string; verification: string };
export function markdownRunReport(record: RunRecord): string;
