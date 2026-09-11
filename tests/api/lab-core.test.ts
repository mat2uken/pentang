import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyChangedFiles,
  createRunRecord,
  finalRunState,
  hashFileList,
  markdownRunReport,
  parseArgs,
  redactedIdentifier,
  selectProfiles,
  sourceHash,
  validateRunRecord,
} from "../../scripts/lab-core.mjs";

describe("validation lab core", () => {
  it("parses flags without shell evaluation", () => {
    expect(parseArgs(["run", "--profile", "affected", "--changed", "--preview-port=4174"])).toEqual({
      _: ["run"],
      values: { profile: "affected", changed: true, "preview-port": "4174" },
    });
  });

  it("classifies affected paths and selects the smallest required profiles", () => {
    const classification = classifyChangedFiles(["apps/demo/ui.ts", "tests/tauri/basic.e2e.mjs"]);
    expect(classification.code).toBe(true);
    expect(classification.web).toBe(true);
    expect(classification.native).toBe(true);
    expect(selectProfiles({ profile: "affected", changedFiles: ["docs/README.md"] })).toEqual(["fast"]);
    expect(selectProfiles({ profile: "affected", changedFiles: ["apps/demo/ui.ts"] })).toEqual(["fast", "web", "packaged"]);
    expect(selectProfiles({ profile: "affected", changedFiles: ["scripts/verify-android-device.mjs"] })).toEqual(["fast", "web", "devices"]);
    expect(selectProfiles({ profile: "devices" })).toEqual(["devices"]);
  });

  it("hashes file names and bytes deterministically while ignoring lab output", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pentang-lab-"));
    try {
      writeFileSync(path.join(root, "b.txt"), "B");
      writeFileSync(path.join(root, "a.txt"), "A");
      writeFileSync(path.join(root, "ignored.txt"), "ignored");
      const first = hashFileList(root, ["b.txt", "a.txt"]);
      const second = hashFileList(root, ["a.txt", "b.txt"]);
      expect(first).toBe(second);
      expect(sourceHash(root, ["a.txt", "ignored.txt"])).not.toBe(sourceHash(root, ["a.txt"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates and finalizes a run record", () => {
    const record = createRunRecord({
      id: "20260910-000000-test",
      profile: "fast",
      profiles: ["fast"],
      source: { branch: "feature/test", head: "a".repeat(40), dirty: false, sourceHash: "b".repeat(64) },
    });
    expect(validateRunRecord(record).ok).toBe(true);
    expect(finalRunState(["passed", "blocked"])).toEqual({ status: "blocked", verification: "blocked" });
    expect(finalRunState(["passed", "failed"])).toEqual({ status: "failed", verification: "failed" });
    expect(finalRunState([])).toEqual({ status: "blocked", verification: "blocked" });
    record.steps.push({ id: "typecheck", status: "passed", durationMs: 10, detail: "ok" });
    record.status = "passed";
    record.verification = "passed";
    record.finishedAt = new Date().toISOString();
    expect(markdownRunReport(record)).toContain("| typecheck | passed |");
  });

  it("redacts short and long target identifiers predictably", () => {
    expect(redactedIdentifier("emulator-5554")).toBe("emul…5554");
    expect(redactedIdentifier("75B31423-51DF-4BC0-95B5-E12E073A9409")).toBe("75B3…9409");
    expect(redactedIdentifier("local")).toBe("<local>");
    expect(redactedIdentifier("")).toBe("");
  });
});
