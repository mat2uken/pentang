#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { row } from "./lib.mjs";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  createRunRecord,
  finalRunState,
  markdownRunReport,
  parseArgs,
  redactedIdentifier,
  safeName,
  selectProfiles,
  sha256File,
  sha256Text,
  sourceHash,
  validateRunRecord,
} from "./lab-core.mjs";

const STATE_DIR = path.join(ROOT, ".lab-state");
const RUNS_DIR = path.join(STATE_DIR, "runs");
const LEASES_DIR = path.join(STATE_DIR, "leases");
const SETUP_FILE = path.join(STATE_DIR, "setup.json");
const DEFAULT_PREVIEW_PORT = 4173;
const DEFAULT_BASE = "/";

function usage() {
  return `usage:
  npm run lab -- doctor [--target web|native|android|ios|all] [--phase tools|build|run]
  npm run lab -- setup [--apply] [--target web|native|android|ios|all]
  npm run lab -- targets list [--show-identifiers]
  npm run lab -- targets register --name <name> --kind <android|ios|macos|windows> [--id <id>]
  npm run lab -- run --profile fast|web|packaged|devices|affected|full [--changed] [--android-serial <serial>] [--android-apk <path>] [--ios-udid <udid>] [--reuse-preview]
  npm run lab -- report [--run <run-id>]
  npm run lab -- cancel --run <run-id>
  npm run lab -- resume --run <run-id>`;
}

function normalizeOptions(values) {
  return {
    ...values,
    previewHost: values.previewHost ?? values["preview-host"],
    previewPort: values.previewPort ?? values["preview-port"],
    androidSerial: values.androidSerial ?? values["android-serial"],
    androidApk: values.androidApk ?? values["android-apk"],
    iosUdid: values.iosUdid ?? values["ios-udid"],
    showIdentifiers: values.showIdentifiers ?? values["show-identifiers"],
    reusePreview: values.reusePreview ?? values["reuse-preview"],
  };
}

function outputJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function ensureStateDirs() {
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(LEASES_DIR, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function runSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120000,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    windowsHide: true,
  });
  return {
    command,
    args,
    code: result.status ?? (result.error ? 127 : 1),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ? String(result.error) : null,
    signal: result.signal ?? null,
  };
}

function executable(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  const first = String(result.stdout ?? "").split(/\r?\n/).find(Boolean);
  return result.status === 0 && first ? first.trim() : null;
}

function version(command, args = ["--version"]) {
  const result = runSync(command, args, { timeoutMs: 30000 });
  return {
    found: result.code === 0,
    path: executable(command),
    version: `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "",
    error: result.error ?? (result.code === 0 ? null : result.stderr.trim()),
  };
}

function expectedNodeVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return String(packageJson.engines?.node ?? "");
  } catch {
    return "";
  }
}

function inferAndroidSdk(adbPath) {
  if (!adbPath) return null;
  const normalized = path.resolve(adbPath);
  const suffix = `${path.sep}platform-tools${path.sep}adb`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : null;
}

function resolveEmscripten() {
  const fromPath = executable("em++");
  if (fromPath) return { command: fromPath, root: process.env.EMSDK ?? null };
  const roots = [process.env.EMSDK, path.join(os.homedir(), "emsdk")].filter(Boolean);
  for (const root of roots) {
    const command = path.join(root, "upstream", "emscripten", process.platform === "win32" ? "em++.bat" : "em++");
    if (existsSync(command)) return { command, root };
  }
  return null;
}

function webToolchainEnv() {
  const resolved = resolveEmscripten();
  if (!resolved?.root) return {};
  const bin = path.join(resolved.root, "upstream", "emscripten");
  const python = [
    path.join(resolved.root, "python", "3.13.3_64bit", "bin", "python3"),
    path.join(resolved.root, "python", "3.13.3_64bit", "bin", "python"),
  ].find((candidate) => existsSync(candidate));
  return {
    EMSDK: resolved.root,
    EMSDK_PYTHON: python ?? "",
    PATH: [bin, python ? path.dirname(python) : null, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

function doctor(target = "all", phase = "build") {
  const targets = target === "all" ? ["web", "native", "android", "ios"] : [target];
  const rows = [];
  const node = version("node");
  const expectedNode = expectedNodeVersion();
  rows.push(row("node", !node.found ? "MISSING" : expectedNode && !node.version.includes(expectedNode) ? "MISMATCH" : "FOUND", expectedNode || "package.json engines.node", node.version || node.error || "MISSING", "Use the pinned Node from .node-version"));
  const npm = version(npmCommand());
  rows.push(row("npm", npm.found ? "FOUND" : "MISSING", ">=11.19.0", npm.version || npm.error || "MISSING", "Use npm bundled with the pinned Node"));

  for (const current of targets) {
    if (current === "web") {
      const emResolved = resolveEmscripten();
      const em = version(emResolved?.command ?? "em++");
      rows.push(row("web:em++", em.found ? "FOUND" : "MISSING", "Emscripten 6.0.9", em.version || em.error || "MISSING", "Activate the pinned emsdk only for Web builds"));
      if (!existsSync(path.join(ROOT, "node_modules"))) rows.push(row("web:node_modules", "MISSING", "npm ci", "MISSING", "Run lab setup --apply"));
    }
    if (current === "native") {
      for (const [name, command, args, expected] of [
        ["native:rustc", "rustc", ["--version"], "1.96.1"],
        ["native:cargo", "cargo", ["--version"], "1.96.1"],
        ["native:cmake", "cmake", ["--version"], "4.3.4"],
        ["native:cxx", "c++", ["--version"], "Apple clang"],
      ]) {
        const found = version(command, args);
        rows.push(row(name, !found.found ? "MISSING" : expected && !found.version.includes(expected) ? "MISMATCH" : "FOUND", expected, found.version || found.error || "MISSING", "Install or select the pinned native toolchain"));
      }
    }
    if (current === "android") {
      const adb = version("adb");
      rows.push(row("android:adb", adb.found ? "FOUND" : "MISSING", "Android platform-tools", adb.version || adb.error || "MISSING", "Connect a device or install platform-tools"));
      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || inferAndroidSdk(adb.path);
      rows.push(row("android:sdk", sdk && existsSync(sdk) ? "FOUND" : "MISSING", "ANDROID_HOME or adb under Android SDK", sdk || "MISSING", "Set ANDROID_HOME for repeatable builds"));
      const java = version("java", ["-version"]);
      rows.push(row("android:jdk", java.found ? "FOUND" : "MISSING", "JDK 21", java.version || java.error || "MISSING", "Install JDK 21 on the Android host"));
    }
    if (current === "ios") {
      const xcode = version("xcodebuild", ["-version"]);
      rows.push(row("ios:xcode", xcode.found ? "FOUND" : "MISSING", "Xcode 26.6", xcode.version || xcode.error || "MISSING", "Install the selected Xcode and command-line tools"));
      const xcrun = version("xcrun", ["--version"]);
      rows.push(row("ios:xcrun", xcrun.found ? "FOUND" : "MISSING", "xcrun", xcrun.version || xcrun.error || "MISSING", "Select the Xcode developer directory"));
      const pmdPath = executable("pymobiledevice3") ?? [path.join(os.homedir(), ".local", "bin", "pymobiledevice3"), path.join(os.homedir(), ".venv", "bin", "pymobiledevice3")].find((candidate) => existsSync(candidate));
      const pmd = pmdPath ? runSync(pmdPath, ["version"], { timeoutMs: 30000 }) : null;
      const expectedPmd = "11.12.1";
      const actualPmd = pmdPath && pmd?.code === 0 ? `${pmdPath} (${pmd.stdout.trim()})` : pmd?.stderr?.trim() || "MISSING";
      rows.push(row("ios:pymobiledevice3", !pmdPath || pmd?.code !== 0 ? "MISSING" : !pmd.stdout.includes(expectedPmd) ? "MISMATCH" : "FOUND", expectedPmd, actualPmd, "Install the pinned pymobiledevice3 native Web Inspector tool"));
    }
  }
  const required = rows.filter((item) => item.status === "MISSING" || item.status === "MISMATCH");
  return { target, phase, ok: required.length === 0, rows };
}

function printDoctor(result) {
  for (const item of result.rows) {
    console.log(`| ${item.item} | ${item.status} | ${item.expected} | ${item.actual.replaceAll("\n", " ").slice(0, 180)} | ${item.remedy} |`);
  }
  console.log(`doctor: ${result.ok ? "OK" : `${result.rows.filter((item) => item.status === "MISSING" || item.status === "MISMATCH").length} required item(s) missing/mismatched`}`);
}

function packageLockHash() {
  const lockPath = path.join(ROOT, "package-lock.json");
  return existsSync(lockPath) ? sha256File(lockPath) : null;
}

function nodeModulesLooksComplete() {
  if (!existsSync(path.join(ROOT, "node_modules", ".package-lock.json"))) return false;
  try {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    return Object.keys(dependencies).every((name) => existsSync(path.join(ROOT, "node_modules", name)));
  } catch {
    return false;
  }
}

function canReuseNpmInstall(lockHash) {
  if (!lockHash || !nodeModulesLooksComplete() || !existsSync(SETUP_FILE)) return false;
  try {
    const previous = JSON.parse(readFileSync(SETUP_FILE, "utf8"));
    return previous.node === process.version && previous.packageLockHash === lockHash && Array.isArray(previous.actions) && previous.actions.some((item) => item.code === 0);
  } catch {
    return false;
  }
}

function setup(options) {
  ensureStateDirs();
  if (!options.apply) {
    const result = doctor(options.target ?? "all", "tools");
    printDoctor(result);
    return result.ok ? 0 : 1;
  }
  const actions = [];
  const lockHash = packageLockHash();
  if (canReuseNpmInstall(lockHash)) {
    actions.push({ action: "npm ci", code: 0, status: "skipped", reason: "package-lock.json and direct dependencies unchanged" });
  } else {
    const npm = npmCommand();
    const result = runSync(npm, ["ci"], { timeoutMs: 600000 });
    actions.push({ action: "npm ci", code: result.code, stderr: result.stderr.slice(-2000) });
    if (result.code !== 0) {
      writeJsonAtomic(SETUP_FILE, { schemaVersion: 1, completedAt: new Date().toISOString(), node: process.version, packageLockHash: lockHash, actions });
      console.error(result.stderr);
      return 1;
    }
  }
  const result = doctor(options.target ?? "all", "tools");
  writeJsonAtomic(SETUP_FILE, {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    node: process.version,
    packageLockHash: lockHash,
    sourceHash: sourceHash(ROOT),
    actions,
    doctor: result,
  });
  printDoctor(result);
  if (!result.ok) {
    console.error("setup: BLOCKED (the missing host tools were not installed automatically)");
    return 2;
  }
  console.log("setup: OK");
  return 0;
}

function inventoryTargets(showIdentifiers = false) {
  const records = [];
  const adb = runSync("adb", ["devices", "-l"], { timeoutMs: 30000 });
  if (adb.code === 0) {
    for (const line of adb.stdout.split(/\r?\n/).slice(1)) {
      const match = line.match(/^(\S+)\s+(device|offline|unauthorized)\s*(.*)$/);
      if (!match) continue;
      const [, id, state, detail] = match;
      records.push({ kind: "android", id: showIdentifiers ? id : redactedIdentifier(id), state, detail: detail.trim() });
    }
  }
  const devicectl = runSync("xcrun", ["devicectl", "list", "devices"], { timeoutMs: 30000 });
  if (devicectl.code === 0) {
    for (const line of devicectl.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(.+?)\s{2,}(.+?)\s{2,}([0-9A-F-]{20,})\s{2,}(.+?)\s{2,}(.+)$/);
      if (!match || /Hostname|Name\s+Hostname|^[-\s]+$/.test(trimmed)) continue;
      records.push({ kind: "apple", name: match[1].trim(), hostname: match[2].trim(), id: showIdentifiers ? match[3] : redactedIdentifier(match[3]), state: match[4].trim(), model: match[5].trim() });
    }
  }
  const sim = runSync("xcrun", ["simctl", "list", "devices", "booted"], { timeoutMs: 30000 });
  if (sim.code === 0) {
    for (const line of sim.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s+(.+?)\s+\(([0-9A-F-]{20,})\) \(Booted\)/);
      if (match) records.push({ kind: "ios-simulator", name: match[1], id: showIdentifiers ? match[2] : redactedIdentifier(match[2]), state: "Booted" });
    }
  }
  return records;
}

function registerTarget(options) {
  ensureStateDirs();
  if (!options.name || !options.kind) throw new Error("targets register requires --name and --kind");
  const filePath = path.join(STATE_DIR, "targets.json");
  let config = { schemaVersion: 1, targets: [] };
  if (existsSync(filePath)) config = JSON.parse(readFileSync(filePath, "utf8"));
  const next = { name: String(options.name), kind: String(options.kind), id: options.id ? String(options.id) : null, updatedAt: new Date().toISOString() };
  config.targets = [...config.targets.filter((item) => item.name !== next.name), next].sort((a, b) => a.name.localeCompare(b.name));
  writeJsonAtomic(filePath, config);
  console.log(`registered ${next.name} (${next.kind})`);
  return 0;
}

function readLease(leaseDir) {
  try {
    return JSON.parse(readFileSync(path.join(leaseDir, "lease.json"), "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLease(name, runId, ttlMs = 30 * 60 * 1000) {
  ensureStateDirs();
  const leaseDir = path.join(LEASES_DIR, safeName(name));
  try {
    mkdirSync(leaseDir);
  } catch {
    const current = readLease(leaseDir);
    if (current && current.expiresAt > Date.now() && processAlive(current.pid)) return { ok: false, current };
    rmSync(leaseDir, { recursive: true, force: true });
    mkdirSync(leaseDir);
  }
  const lease = { schemaVersion: 1, name, runId, pid: process.pid, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
  writeJsonAtomic(path.join(leaseDir, "lease.json"), lease);
  return { ok: true, lease, leaseDir };
}

function releaseLease(name, runId) {
  const leaseDir = path.join(LEASES_DIR, safeName(name));
  const current = readLease(leaseDir);
  if (current && current.runId !== runId) return false;
  rmSync(leaseDir, { recursive: true, force: true });
  return true;
}

function getChangedFiles() {
  const tracked = runSync("git", ["diff", "--name-only", "HEAD"], { timeoutMs: 30000 });
  const untracked = runSync("git", ["ls-files", "--others", "--exclude-standard"], { timeoutMs: 30000 });
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function sourceIdentity() {
  const branch = runSync("git", ["branch", "--show-current"], { timeoutMs: 30000 }).stdout.trim();
  const head = runSync("git", ["rev-parse", "HEAD"], { timeoutMs: 30000 }).stdout.trim();
  const status = runSync("git", ["status", "--porcelain=v1"], { timeoutMs: 30000 }).stdout;
  const files = [...new Set(`${status}\n${getChangedFiles().join("\n")}`.split(/\r?\n/).map((item) => item.trim().replace(/^..\s+/, "")).filter(Boolean))];
  return { branch, head, dirty: status.trim() !== "", sourceHash: sourceHash(ROOT, files.length ? files : undefined) };
}

function writeStepFiles(runDir, step, stdout, stderr) {
  const basename = safeName(step.id);
  const stdoutPath = path.join(runDir, `${basename}.stdout.log`);
  const stderrPath = path.join(runDir, `${basename}.stderr.log`);
  writeFileSync(stdoutPath, stdout, { mode: 0o600 });
  writeFileSync(stderrPath, stderr, { mode: 0o600 });
  return { stdout: path.basename(stdoutPath), stderr: path.basename(stderrPath) };
}

function spawnCapture(command, args, { env = {}, timeoutMs = 600000, runDir, onOutput, onStart } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    onStart?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text, false);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text, true);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${String(error)}`, timedOut, durationMs: Date.now() - startedAt, pid: child.pid });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, signal, timedOut, durationMs: Date.now() - startedAt, pid: child.pid });
    });
  });
}

async function reservePort(preferred = DEFAULT_PREVIEW_PORT) {
  for (let offset = 0; offset < 20; offset += 1) {
    const port = preferred + offset;
    try {
      // A specific-address listener (for example 127.0.0.1:4175) can coexist
      // with a wildcard bind on macOS, yet still win requests sent to
      // 127.0.0.1. Treat any HTTP response as occupied before probing bind.
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
      continue;
    } catch {
      // No HTTP listener answered; the socket probe below handles non-HTTP use.
    }
    const available = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      // Preview servers bind 0.0.0.0 so LAN devices can reach them. Probe the
      // same wildcard address; probing loopback alone can miss an existing
      // wildcard listener on macOS.
      server.listen({ port, host: "0.0.0.0", exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("no preview port available");
}

async function waitForUrl(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview did not start: ${lastError}`);
}

function startLongProcess(command, args, env, runDir, label) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const stdoutPath = path.join(runDir, `${safeName(label)}.stdout.log`);
  const stderrPath = path.join(runDir, `${safeName(label)}.stderr.log`);
  const stdoutFd = openSync(stdoutPath, "a", 0o600);
  const stderrFd = openSync(stderrPath, "a", 0o600);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdout.on("data", (chunk) => writeFileSync(stdoutPath, chunk, { flag: "a", mode: 0o600 }));
  child.stderr.on("data", (chunk) => writeFileSync(stderrPath, chunk, { flag: "a", mode: 0o600 }));
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = String(error);
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return {
    child,
    get error() {
      return spawnError;
    },
    files: { stdout: path.basename(stdoutPath), stderr: path.basename(stderrPath) },
    stop() {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}

async function startDevicePreview({ base, port, runDir, reuse = false }) {
  const localUrl = `http://127.0.0.1:${String(port)}${base}`;
  const check = async (url) => {
    const response = await fetch(url);
    const body = await response.text();
    if (response.status !== 200 || !body.includes('id="status"')) {
      throw new Error(`preview check failed for ${url}: HTTP ${response.status}`);
    }
  };

  if (reuse) {
    try {
      await check(localUrl);
      return { port, process: null };
    } catch {
      // Fall through and start an owned preview when the requested one is not valid.
    }
  }

  if (!existsSync(path.join(ROOT, "dist", "web", "index.html"))) {
    throw new Error("dist/web/index.html is missing; build the web profile first");
  }
  const selectedPort = await reservePort(Number(port));
  const preview = startLongProcess(
    nodeCommand(),
    ["scripts/serve-web.mjs", "--base", base, "--host", "0.0.0.0", "--port", String(selectedPort)],
    {},
    runDir,
    "device-preview",
  );
  try {
    const selectedUrl = `http://127.0.0.1:${String(selectedPort)}${base}`;
    await waitForUrl(selectedUrl);
    if (preview.error) throw new Error(`preview failed to start: ${preview.error}`);
    await check(selectedUrl);
    return { port: selectedPort, process: preview };
  } catch (error) {
    preview.stop();
    throw error;
  }
}

function npmCommand() {
  const sibling = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return existsSync(sibling) ? sibling : process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeCommand() {
  return process.execPath;
}

async function runProfile(run, profile, options) {
  const runDir = path.join(RUNS_DIR, run.id);
  const stepStatuses = [];
  const addManual = (text) => {
    if (!run.manualActions.includes(text)) run.manualActions.push(text);
  };
  const save = () => writeJsonAtomic(path.join(runDir, "run.json"), run);

  async function step(id, command, args, env = {}, timeoutMs = 600000) {
    const startedAt = Date.now();
    const entry = { id, status: "running", command: `${command} ${args.join(" ")}`, startedAt: new Date(startedAt).toISOString() };
    run.steps.push(entry);
    save();
    console.log(`\n[lab] ${entry.command}`);
    const result = await spawnCapture(command, args, {
      env,
      timeoutMs,
      runDir,
      onStart: (pid) => {
        entry.pid = pid ?? null;
        save();
      },
      onOutput: (text, isErr) => (isErr ? process.stderr.write(text) : process.stdout.write(text)),
    });
    entry.pid = result.pid ?? null;
    const files = writeStepFiles(runDir, entry, result.stdout, result.stderr);
    entry.finishedAt = new Date().toISOString();
    entry.durationMs = result.durationMs;
    entry.exitCode = result.code;
    entry.signal = result.signal ?? null;
    // Exit code 2 is reserved for a missing host/device prerequisite. Keep it
    // separate from exit code 1, which means the scenario actually ran and
    // found a defect.
    entry.status = result.timedOut ? "blocked" : result.code === 0 ? "passed" : result.code === 2 ? "blocked" : "failed";
    entry.artifacts = files;
    entry.detail = result.timedOut ? `timeout after ${timeoutMs}ms` : result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    if (entry.status === "blocked" && result.code === 2) {
      const prerequisite = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      if (prerequisite) addManual(prerequisite);
    }
    stepStatuses.push(entry.status);
    save();
    return result;
  }

  async function blockedStep(id, detail, remedy) {
    const entry = { id, status: "blocked", command: "", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, detail };
    run.steps.push(entry);
    addManual(remedy);
    stepStatuses.push("blocked");
    save();
  }

  if (profile === "fast") {
    const commands = [
      ["typecheck", "npm", ["run", "typecheck", "--", "--scope", "all"], 180000],
      ["api-tests", "npm", ["run", "test:api"], 180000],
      ["core-tests", "npm", ["run", "test:core"], 180000],
      ["ffi-tests", "cargo", ["test", "-p", "core-ffi", "--locked"], 300000],
      ["app-tests", "cargo", ["test", "-p", "core-app", "--lib", "--locked"], 300000],
    ];
    for (const [id, command, args, timeout] of commands) {
      const result = await step(id, command, args, {}, timeout);
      if (result.code !== 0) break;
    }
  }

  if (profile === "web") {
    const preflight = doctor("web", "build");
    if (!preflight.ok) {
      await blockedStep("web-preflight", "Web build prerequisites are missing or mismatched", "Activate the pinned Emscripten toolchain, then rerun the same lab command.");
    } else {
      const base = String(options.base ?? DEFAULT_BASE);
      const build = await step("web-build", npmCommand(), ["run", "build:web", "--", "--base", base], webToolchainEnv(), 600000);
      if (build.code === 0) {
        const port = await reservePort(Number(options.previewPort ?? DEFAULT_PREVIEW_PORT));
        const preview = startLongProcess(nodeCommand(), ["scripts/serve-web.mjs", "--base", base, "--host", "127.0.0.1", "--port", String(port)], {}, runDir, "web-preview");
        run.services = [...(run.services ?? []), { id: "web-preview", pid: preview.child.pid, port }];
        save();
        try {
          const url = `http://127.0.0.1:${String(port)}${base}`;
          await waitForUrl(url);
          if (preview.error) throw new Error(`preview failed to start: ${preview.error}`);
          await step("web-e2e", npmCommand(), ["run", "test:web"], { PREVIEW_URL: url }, 240000);
        } catch (error) {
          await blockedStep("web-preview", String(error), "Inspect the saved preview logs and rerun after the host is available.");
        } finally {
          preview.stop();
          run.services = (run.services ?? []).filter((item) => item.id !== "web-preview");
          save();
        }
      }
    }
  }

  if (profile === "packaged") {
    const preflight = doctor("native", "build");
    if (!preflight.ok) {
      await blockedStep("packaged-preflight", "Native packaged E2E prerequisites are missing or mismatched", "Prepare the pinned Rust/Xcode/CMake toolchain, then rerun packaged E2E.");
    } else {
      const build = await step("native-packaged-build", npmCommand(), ["run", "tauri", "--", "build", "--debug", "--no-bundle", "--target", "aarch64-apple-darwin"], { VITE_WDIO: "1" }, 900000);
      if (build.code === 0) {
        const candidates = [
          path.join(ROOT, "src-tauri", "target", "aarch64-apple-darwin", "debug", "core-app"),
          path.join(ROOT, "src-tauri", "target", "debug", "core-app"),
          path.join(ROOT, "target", "aarch64-apple-darwin", "debug", "core-app"),
          path.join(ROOT, "target", "debug", "core-app"),
        ];
        const binary = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        if (!binary) {
          await blockedStep("native-binary", "The native build succeeded but no expected app binary was found", "Inspect the build output and set PENTANG_TAURI_BINARY to the generated binary.");
        } else {
          run.artifacts.push({ path: path.relative(ROOT, binary), sha256: sha256File(binary), kind: "application" });
          await step("native-packaged-e2e", npmCommand(), ["exec", "wdio", "run", "wdio.conf.mjs"], { PENTANG_TAURI_BINARY: binary }, 600000);
        }
      }
    }
  }

  if (profile === "devices") {
    const androidSerial = options.androidSerial;
    const androidApk = options.androidApk;
    const iosUdid = options.iosUdid;
    let devicePreview = null;
    try {
      const ensurePreview = async () => {
        if (devicePreview) return devicePreview;
        devicePreview = await startDevicePreview({
          base: String(options.base ?? DEFAULT_BASE),
          port: Number(options.previewPort ?? 4174),
          runDir,
          reuse: Boolean(options.reusePreview),
        });
        if (devicePreview.process) {
          run.services = [...(run.services ?? []), { id: "device-preview", pid: devicePreview.process.child.pid, port: devicePreview.port }];
          save();
        }
        return devicePreview;
      };

      if (androidSerial) {
        let androidBuildOk = true;
        let androidBuildResult = null;
        let apkPath = androidApk ? path.resolve(ROOT, String(androidApk)) : null;
        if (apkPath && !existsSync(apkPath)) {
          await blockedStep("android-apk", `The supplied APK does not exist: ${String(androidApk)}`, "Build the Android debug APK or pass an existing path with --android-apk.");
          androidBuildOk = false;
        }
        if (!apkPath) {
          androidBuildResult = await step("android-debug-build", npmCommand(), ["run", "tauri", "--", "android", "build", "--debug", "--apk", "--target", "aarch64"], {}, 1200000);
          androidBuildOk = androidBuildResult.code === 0;
          if (androidBuildResult.code === 0) {
            const candidates = [
              path.join(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "debug", "app-universal-debug.apk"),
              path.join(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "arm64-v8a", "debug", "app-arm64-v8a-debug.apk"),
            ];
            apkPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
          }
        }
        if (apkPath && existsSync(apkPath)) {
          options.androidApk = path.relative(ROOT, apkPath);
          run.options.androidApk = options.androidApk;
          run.artifacts.push({ path: options.androidApk, sha256: sha256File(apkPath), kind: "android-apk" });
          save();
        } else if (androidBuildResult?.code === 0) {
          await blockedStep("android-apk", "The Android build succeeded but no APK output was found", "Set --android-apk to the generated debug APK and rerun the device profile.");
          androidBuildOk = false;
        }
        if (!androidBuildOk) {
          // Do not install a stale APK after a build or artifact precondition failed.
        } else {
          const lease = acquireLease(`android-${androidSerial}`, run.id);
          if (!lease.ok) {
            await blockedStep("android-lease", `Android target is busy (run ${lease.current?.runId ?? "unknown"})`, "Wait for the owning run to finish or cancel it before retrying.");
          } else {
            run.leases.push({ name: lease.lease.name, redactedId: redactedIdentifier(androidSerial) });
            save();
            try {
              const host = options.previewHost;
              if (!host) {
                await blockedStep("android-preview-host", "No LAN host was supplied for the Android browser path", "Rerun with --preview-host set to the Mac LAN address reachable from the device.");
              } else {
                const preview = await ensurePreview();
                options.previewPort = preview.port;
                run.options.previewPort = preview.port;
                save();
                const apkArgs = options.androidApk ? ["--apk", String(options.androidApk)] : [];
                await step("android-device", nodeCommand(), ["scripts/verify-android-device.mjs", "--serial", String(androidSerial), "--preview-host", String(host), "--preview-port", String(preview.port), ...apkArgs], {}, 900000);
              }
            } finally {
              releaseLease(`android-${androidSerial}`, run.id);
            }
          }
        }
      }
      if (iosUdid) {
        const lease = acquireLease(`ios-${iosUdid}`, run.id);
        if (!lease.ok) {
          await blockedStep("ios-lease", `iOS target is busy (run ${lease.current?.runId ?? "unknown"})`, "Wait for the owning run to finish or cancel it before retrying.");
        } else {
          run.leases.push({ name: lease.lease.name, redactedId: redactedIdentifier(iosUdid) });
          save();
          try {
            let url = options.url ?? null;
            if (!url && options.previewHost) {
              const preview = await ensurePreview();
              options.previewPort = preview.port;
              run.options.previewPort = preview.port;
              save();
              url = `http://${options.previewHost}:${String(preview.port)}${String(options.base ?? DEFAULT_BASE)}`;
            }
            if (!url) {
              await blockedStep("ios-device-url", "No URL was supplied for the iOS Safari path", "Rerun with --url or --preview-host and --preview-port.");
            } else {
              const launch = await step("ios-safari-launch", "xcrun", [
                "devicectl",
                "device",
                "process",
                "launch",
                "--device",
                String(iosUdid),
                "--payload-url",
                url,
                "com.apple.mobilesafari",
                "--timeout",
                "20",
              ], {}, 120000);
              if (launch.code === 0) {
                await step("ios-device-web", nodeCommand(), ["scripts/verify-ios-device-web.mjs", "--udid", String(iosUdid), "--url", url], {}, 900000);
              }
            }
          } finally {
            releaseLease(`ios-${iosUdid}`, run.id);
          }
        }
      }
      if (!androidSerial && !iosUdid) {
        await blockedStep("devices-selection", "No shared device was explicitly selected", "Provide --android-serial and/or --ios-udid; the runner never guesses a shared device.");
      }
    } catch (error) {
      await blockedStep("device-preview", String(error), "Build dist/web or start a reachable preview on the requested port, then rerun the device profile.");
    } finally {
      devicePreview?.process?.stop();
      run.services = (run.services ?? []).filter((item) => item.id !== "device-preview");
      save();
    }
  }

  return stepStatuses;
}

async function runCommand(options) {
  ensureStateDirs();
  const profile = String(options.profile ?? "fast");
  const changedFiles = options.changed ? getChangedFiles() : [];
  const profiles = selectProfiles({ profile, changedFiles });
  const id = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const record = createRunRecord({ id, profile, profiles, source: sourceIdentity(), requestedTargets: [options.androidSerial ? "android" : null, options.iosUdid ? "ios" : null].filter(Boolean) });
  record.options = {
    base: options.base ?? DEFAULT_BASE,
    previewPort: options.previewPort ?? DEFAULT_PREVIEW_PORT,
    previewHost: options.previewHost ?? null,
    androidSerial: options.androidSerial ?? null,
    androidApk: options.androidApk ?? null,
    iosUdid: options.iosUdid ?? null,
    url: options.url ?? null,
    reusePreview: Boolean(options.reusePreview),
    changedFiles,
  };
  const runDir = path.join(RUNS_DIR, id);
  mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, "run.json"), record);
  console.log(`[lab] run ${id} profile=${profile} profiles=${profiles.join(",")}`);
  console.log(`[lab] source ${record.source.branch}@${record.source.head} hash=${record.source.sourceHash}`);

  const statuses = [];
  for (const item of profiles) {
    const result = await runProfile(record, item, record.options);
    statuses.push(...result);
    if (result.some((status) => status === "failed")) break;
  }
  const final = finalRunState(statuses);
  record.status = final.status;
  record.verification = final.verification;
  record.finishedAt = new Date().toISOString();
  if (record.status === "failed") record.errors.push("At least one verification step failed; inspect the per-step logs.");
  if (record.status === "blocked" && record.manualActions.length === 0) record.manualActions.push("A required host or device prerequisite is unavailable; see the run report.");
  const validation = validateRunRecord(record);
  if (!validation.ok) record.errors.push(...validation.errors);
  writeJsonAtomic(path.join(runDir, "run.json"), record);
  writeFileSync(path.join(runDir, "run.md"), markdownRunReport(record), { mode: 0o600 });
  console.log(`[lab] ${record.status.toUpperCase()} verification=${record.verification} run=${record.id}`);
  console.log(`[lab] report ${path.relative(ROOT, path.join(runDir, "run.md"))}`);
  return record.status === "passed" ? 0 : record.status === "blocked" ? 2 : 1;
}

function locateRun(runId) {
  if (runId) return path.join(RUNS_DIR, safeName(runId), "run.json");
  const entries = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
  if (!entries[0]) throw new Error("no lab runs found");
  return path.join(RUNS_DIR, entries[0].name, "run.json");
}

function reportCommand(options) {
  const filePath = locateRun(options.run);
  const record = JSON.parse(readFileSync(filePath, "utf8"));
  const validation = validateRunRecord(record);
  if (!validation.ok) throw new Error(`invalid run: ${validation.errors.join(", ")}`);
  if (options.json) outputJson(record);
  else process.stdout.write(markdownRunReport(record));
  return 0;
}

function cancelCommand(options) {
  const filePath = locateRun(options.run);
  const record = JSON.parse(readFileSync(filePath, "utf8"));
  if (record.status !== "running") {
    console.log(`cancel: run ${record.id} is already ${record.status}`);
    return 0;
  }
  const active = [...record.steps].reverse().find((step) => step.status === "running");
  if (active?.pid) {
    try {
      if (process.platform === "win32") process.kill(active.pid, "SIGTERM");
      else process.kill(-active.pid, "SIGTERM");
    } catch (error) {
      console.error(`cancel: process could not be stopped: ${String(error)}`);
    }
  }
  for (const service of record.services ?? []) {
    if (!service.pid) continue;
    try {
      if (process.platform === "win32") process.kill(service.pid, "SIGTERM");
      else process.kill(-service.pid, "SIGTERM");
    } catch (error) {
      console.error(`cancel: service ${service.id} could not be stopped: ${String(error)}`);
    }
  }
  record.status = "cancelled";
  record.verification = "inconclusive";
  record.finishedAt = new Date().toISOString();
  record.errors.push("Cancelled by operator");
  writeJsonAtomic(filePath, record);
  writeFileSync(path.join(path.dirname(filePath), "run.md"), markdownRunReport(record), { mode: 0o600 });
  console.log(`cancelled ${record.id}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  const options = normalizeOptions(args.values);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "doctor") {
    const target = options.target ?? "all";
    const result = doctor(target, options.phase ?? "build");
    if (options.json) outputJson(result);
    else printDoctor(result);
    return result.ok ? 0 : 1;
  }
  if (command === "setup") return setup(options);
  if (command === "targets") {
    const subcommand = args._[1] ?? "list";
    if (subcommand === "list") {
      outputJson(inventoryTargets(Boolean(options.showIdentifiers)));
      return 0;
    }
    if (subcommand === "register") return registerTarget(options);
    throw new Error(`unknown targets command: ${subcommand}`);
  }
  if (command === "run") return runCommand(options);
  if (command === "report") return reportCommand(options);
  if (command === "cancel") return cancelCommand(options);
  if (command === "resume") {
    const record = JSON.parse(readFileSync(locateRun(options.run), "utf8"));
    return runCommand({ ...record.options, profile: record.profile });
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`lab: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exit(1);
});
