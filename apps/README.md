# apps — ライブラリ利用側 (PoC デモ)

- `demo/` — 共通 1 画面 UI (`main.ts`, `ui.ts`, `style.css`) と `self-test/runner.ts`。`@backend` 経由で `packages/` のみを使い、計算を持たない。
- `src-tauri/` (リポジトリ直下) — ネイティブシェル (Tauri 設定・権限・commands)。Tauri CLI が `src-tauri/` を既定とするため直下に置く。
- `index.html` (リポジトリ直下) — デモ画面の入口。Vite の root 規約のため直下に置く。
