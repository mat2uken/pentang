import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const RUN_SCHEMA_VERSION = 1;

export const PROFILES = Object.freeze({
  fast: Object.freeze(["fast"]),
  web: Object.freeze(["fast", "web"]),
  packaged: Object.freeze(["fast", "packaged"]),
  devices: Object.freeze(["devices"]),
  affected: Object.freeze(["fast", "affected"]),
  full: Object.freeze(["fast", "web", "packaged", "devices"]),
});

export function parseArgs(argv) {
  const args = { _: [], values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--") continue;
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const body = item.slice(2);
    const equal = body.indexOf("=");
    if (equal >= 0) {
      args.values[body.slice(0, equal)] = body.slice(equal + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.values[body] = next;
      i += 1;
    } else {
      args.values[body] = true;
    }
  }
  return args;
}

export function redactedIdentifier(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return text ? "<local>" : "";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function safeName(value) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "unnamed";
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ファイルhashの実体は scripts/lib.mjs に一本化。import表面は維持する。
export { sha256File } from "./lib.mjs";

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(String(text), "utf8"));
}

function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export function hashFileList(root, relativePaths) {
  const hash = createHash("sha256");
  for (const relative of [...relativePaths].sort()) {
    const filePath = path.join(root, relative);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
    hash.update(relative.replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sourceHash(root, files = null) {
  const selected = files ?? walkFiles(root, "");
  const ignored = [
    /^node_modules\//,
    /^target\//,
    /^build\//,
    /^dist\//,
    /^coverage\//,
    /^test-results\//,
    /^playwright-report\//,
    // Device verifiers write screenshots and local run summaries here. They
    // are evidence for a run, not source inputs, so repeat runs must keep the
    // same source identity.
    /^docs\/reports\/local\//,
    /^\.git\//,
    /^\.lab-state\//,
    /(?:^|\/)\.DS_Store$/,
    // Tauri's Android generator keeps build/cache outputs beside the tracked
    // Gradle sources. They are recreated by every device build and must not
    // change the identity of the source under test.
    /^src-tauri\/gen\/android\/(?:\.gradle|build|buildSrc\/(?:\.gradle|build)|app\/build|app\/src\/main\/(?:assets|jniLibs)|app\/src\/main\/java\/.*\/generated)\//,
    /^src-tauri\/gen\/android\/(?:app\/proguard-tauri\.pro|app\/tauri\.(?:build\.gradle\.kts|properties)|tauri\.settings\.gradle)$/,
  ];
  return hashFileList(root, selected.filter((file) => !ignored.some((pattern) => pattern.test(file.replaceAll(path.sep, "/")))));
}

export function classifyChangedFiles(files) {
  const normalized = files.map((file) => file.replaceAll(path.sep, "/"));
  const code = normalized.some((file) =>
    /^(apps|packages|src-tauri|index\.html|vite\.config\.ts|playwright\.config\.ts|wdio\.conf\.mjs)\//.test(file) ||
    /^(apps|packages|src-tauri|index\.html|vite\.config\.ts|playwright\.config\.ts|wdio\.conf\.mjs)/.test(file),
  );
  const web = normalized.some((file) =>
    /^(apps|packages|index\.html|vite\.config\.ts|scripts\/(build-web|serve-web|verify-.*)|docs\/verification)/.test(file),
  );
  const native = normalized.some((file) => /^(apps|packages|src-tauri|wdio\.conf\.mjs|tests\/tauri)/.test(file));
  const device = normalized.some((file) => /^scripts\/verify-(android|ios|sim|emu)/.test(file));
  const docsOnly = normalized.length > 0 && normalized.every((file) => /^(docs|README\.md|.*\.md$)/.test(file));
  return { files: normalized, code, web, native, device, docsOnly };
}

export function selectProfiles({ profile = "fast", changedFiles = [] } = {}) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`unknown profile: ${profile}`);
  if (profile !== "affected") return [...PROFILES[profile]];
  const classification = classifyChangedFiles(changedFiles);
  if (classification.docsOnly || changedFiles.length === 0) return ["fast"];
  const selected = ["fast"];
  if (classification.web) selected.push("web");
  if (classification.native) selected.push("packaged");
  if (classification.device) selected.push("devices");
  return [...new Set(selected)];
}

export function createRunRecord({ id, profile, profiles, source, requestedTargets = [] }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    status: "running",
    verification: "not_run",
    profile,
    profiles,
    requestedTargets,
    startedAt: now,
    finishedAt: null,
    source,
    steps: [],
    services: [],
    leases: [],
    artifacts: [],
    manualActions: [],
    errors: [],
  };
}

export function validateRunRecord(record) {
  const required = ["schemaVersion", "id", "status", "verification", "profile", "startedAt", "steps"];
  const missing = required.filter((key) => !(key in (record ?? {})));
  if (missing.length > 0) return { ok: false, errors: missing.map((key) => `missing ${key}`) };
  if (record.schemaVersion !== RUN_SCHEMA_VERSION) return { ok: false, errors: ["unsupported schemaVersion"] };
  if (!Array.isArray(record.steps)) return { ok: false, errors: ["steps must be an array"] };
  const allowedStatus = new Set(["running", "passed", "failed", "blocked", "cancelled"]);
  const allowedVerification = new Set(["not_run", "passed", "failed", "blocked", "inconclusive"]);
  const errors = [];
  if (!allowedStatus.has(record.status)) errors.push(`invalid status: ${record.status}`);
  if (!allowedVerification.has(record.verification)) errors.push(`invalid verification: ${record.verification}`);
  for (const [index, step] of record.steps.entries()) {
    if (!step || typeof step.id !== "string" || typeof step.status !== "string") errors.push(`invalid step ${index}`);
  }
  return { ok: errors.length === 0, errors };
}

export function finalRunState(stepStatuses) {
  if (stepStatuses.some((status) => status === "failed")) return { status: "failed", verification: "failed" };
  if (stepStatuses.some((status) => status === "blocked")) return { status: "blocked", verification: "blocked" };
  if (stepStatuses.some((status) => status === "cancelled")) return { status: "cancelled", verification: "inconclusive" };
  if (stepStatuses.length === 0) return { status: "blocked", verification: "blocked" };
  return { status: "passed", verification: "passed" };
}

export function markdownRunReport(record) {
  const lines = [
    `# Lab run ${record.id}`,
    "",
    `- Status: ${record.status}`,
    `- Verification: ${record.verification}`,
    `- Profile: ${record.profile}`,
    `- Started: ${record.startedAt}`,
    `- Finished: ${record.finishedAt ?? "running"}`,
    `- Branch: ${record.source?.branch ?? "unknown"}`,
    `- HEAD: ${record.source?.head ?? "unknown"}`,
    `- Source hash: ${record.source?.sourceHash ?? "unknown"}`,
    "",
    "| Step | Status | Duration | Detail |",
    "|---|---|---:|---|",
  ];
  for (const step of record.steps) {
    const detail = String(step.detail ?? step.command ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 240);
    lines.push(`| ${step.id} | ${step.status} | ${step.durationMs ?? "-"} ms | ${detail} |`);
  }
  if (record.manualActions?.length) {
    lines.push("", "## Human action required", "", ...record.manualActions.map((item) => `- ${item}`));
  }
  if (record.errors?.length) {
    lines.push("", "## Errors", "", ...record.errors.map((item) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}
