# apps — デモアプリ置き場 (製品コードではない)

このディレクトリ以下はすべてデモ・動作確認用のアプリであり、ライブラリ本体ではない。
製品として配布・再利用する処理は `packages/` に置き、`apps/` からは `@backend` 経由でのみ利用する。

- `poc-demo/` — PoC デモアプリ本体。共通 1 画面 UI (`main.ts`, `ui.ts`, `style.css`) と `self-test/runner.ts`。`@backend` 経由で `packages/` のみを使い、計算を持たない。
- `src-tauri/` (リポジトリ直下) — デモ用のネイティブシェル (Tauri 設定・権限・commands)。Tauri CLI が `src-tauri/` を既定とするため直下に置く。
- `index.html` (リポジトリ直下) — デモ画面の入口。Vite の root 規約のため直下に置く。

新しいデモを追加する場合は `apps/<目的>-demo/` の命名でこの下に置く。
