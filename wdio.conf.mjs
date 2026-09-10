import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const appBinaryPath = path.resolve(
  process.env.PENTANG_TAURI_BINARY ?? "src-tauri/target/debug/poc-app",
);

/**
 * Packaged Tauri E2E configuration.
 *
 * The embedded provider is used on macOS and can also be selected explicitly
 * on Windows/Linux. The application binary is supplied by the build step so a
 * stale binary cannot be silently selected by the runner.
 */
export const config = {
  runner: "local",
  specs: ["./tests/tauri/**/*.e2e.mjs"],
  maxInstances: 1,
  logLevel: process.env.WDIO_LOG_LEVEL ?? "warn",
  bail: 1,
  baseUrl: "tauri://localhost",
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: [["spec", { showPreface: false }]],
  mochaOpts: {
    timeout: 120000,
  },
  services: [
    ["@wdio/tauri-service", {
      appBinaryPath,
      driverProvider: "embedded",
      autoInstallTauriDriver: false,
      autoDownloadEdgeDriver: false,
      logDir: path.join(root, ".lab-state", "wdio-logs"),
    }],
  ],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: appBinaryPath,
    },
  }],
};
