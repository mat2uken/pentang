import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf-8",
    ...opts,
  });
  return res;
}

export function which(cmd) {
  const res = runCmd("sh", ["-c", `command -v ${cmd}`]);
  const out = (res.stdout ?? "").trim();
  return out === "" ? null : out;
}

export function cmdVersion(cmd, versionArgs = ["--version"]) {
  try {
    const res = runCmd(cmd, versionArgs, { timeout: 15000 });
    if (res.error) return { ok: false, output: String(res.error) };
    if (res.status !== 0)
      return { ok: false, output: (res.stderr ?? "").trim() };
    const out = ((res.stdout ?? "") + (res.stderr ?? "")).trim();
    return { ok: true, output: out.split("\n")[0].trim() };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

export function loadJson(rel) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return { found: false, path: p };
  try {
    const raw = readFileSync(p, "utf-8");
    return { found: true, path: p, data: JSON.parse(raw) };
  } catch (e) {
    return { found: true, path: p, parseError: String(e) };
  }
}

export function parseKVArgs(argv) {
  const out = { _: [], kv: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      // npm経由の `-- --target ...` でもkvとして解釈できるよう読み飛ばす
      i += 1;
      continue;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.kv[a.slice(2, eq)] = a.slice(eq + 1);
        i += 1;
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.kv[key] = next;
          i += 2;
        } else {
          out.kv[key] = true;
          i += 1;
        }
      }
    } else {
      out._.push(a);
      i += 1;
    }
  }
  return out;
}
