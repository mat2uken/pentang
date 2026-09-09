import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@backend": "/src/backends/tauri/index.ts",
    },
  },
  test: {
    include: ["tests/api/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        // main.tsは起動結線のみでE2E/実機で検証するため unit 計測から除外する。
        "src/main.ts",
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
