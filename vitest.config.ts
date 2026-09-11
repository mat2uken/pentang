import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@backend": "/packages/backends/tauri/index.ts",
    },
  },
  test: {
    include: ["tests/api/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["packages/**/*.ts", "apps/**/*.ts"],
      exclude: [
        "packages/**/*.d.ts",
        "apps/**/*.d.ts",
        // main.tsは起動結線のみでE2E/実機で検証するため unit 計測から除外する。
        "apps/demo/main.ts",
        // bench-runner.tsは計測ハーネス自体で、?bench=1 のE2E/実機で検証する。
        // 報告先解決などの純粋部品は tests/api/bench-report.test.ts で cover する。
        "apps/demo/self-test/bench-runner.ts",
        // bench-runner.tsは計測ハーネス自体で、?bench=1 のE2E/実機で検証する。
        // 報告先解決などの純粋部品は tests/api/bench-report.test.ts で cover する。
        "apps/poc-demo/self-test/bench-runner.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
