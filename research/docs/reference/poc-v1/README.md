# 元設計v1の参照定義

2026-09-08に `web_tauri_cpp_poc_design_v1.zip` から、実装に必要な4ファイルを内容を変えずに取り出した。これらは設計に付属する定義・期待値であり、アプリ実装ではない。

元ZIPのSHA-256:

```text
47e36dfe186f7ef82726aa2c238f4530bc888ad44e0553a8eeea390c284dce39
```

ZIP内の `MANIFEST.sha256` にある16ファイルのhash一致を確認済み。このフォルダの [MANIFEST.sha256](MANIFEST.sha256) は同梱4ファイルのみの一覧である。

| ファイル | 用途 |
|---|---|
| [application-api.ts](contracts/application-api.ts) | 公開APIの型・エラーcode |
| [poc_core.h](contracts/poc_core.h) | C ABI宣言・引数規則・status |
| [worker-protocol.ts](contracts/worker-protocol.ts) | Worker内部のメッセージ型 |
| [golden-vectors.json](fixtures/golden-vectors.json) | 共通期待値と不正入力例 |

ここは元定義の固定保存先であり、実行コードから直接importしない。配置先とv1.1/v1.2で補った挙動は [04-contracts.md](../../04-contracts.md) を参照する。実装側の編集をこのフォルダへ反映して過去版を上書きしない。
