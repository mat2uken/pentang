import { defineConfig } from "vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// mode別に backend alias / outDir / publicDir を分ける (docs/02)。
// M0の空画面はBackendをimportしない。alias解決はM1/M2接続時に使う。
export default defineConfig(({ mode }) => {
  const isTauri = mode === "tauri";
  return {
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    resolve: {
      alias: isTauri
        ? { "@backend": "/src/backends/tauri/index.ts" }
        : { "@backend": "/src/backends/browser/index.ts" },
    },
    build: {
      outDir: isTauri ? "dist/native" : "dist/web",
      emptyOutDir: true,
    },
    publicDir: isTauri ? false : "web-public",
    worker: {
      format: "es" as const,
    },
  };
});
