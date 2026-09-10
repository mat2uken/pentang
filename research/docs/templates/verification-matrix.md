# PoC検証表

初期テンプレート。全行未実行。`../../reports/verification-matrix.md` にコピーして使用する。実施した内容をrun記録に紐付け、未実行をPASSへ変更しない。

- 採用source / commit: 未確定
- toolchain lock hash: 未確定
- 総合判定: NOT_RUN
- 計画版: docs v1.2

| ID | 必須/後続 | CPU・OS・SDK・browser | Build | Launch | C++ self-test | native同梱起動 | 共通試験 | run ID・理由 |
|---|---|---|---|---|---|---|---|---|
| N-MAC | 必須 | arm64 Mac、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | |
| N-IOS-SIM | 必須 | arm64 Sim、runtime未選定 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | |
| N-ANDROID-EMU | 必須 | AVD/API/ABI未選定 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | |
| N-WIN | 必須 | Windows 11 x64、ホスト未選定 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | |
| W-CHROMIUM | 必須 | desktop、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | N/A | NOT_RUN | root/subpath |
| W-FIREFOX | 必須 | desktop、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | N/A | NOT_RUN | root/subpath |
| W-SAFARI | 必須 | 実Safari、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | N/A | NOT_RUN | root/subpath |
| W-IOS | 必須 | Sim Safari可、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | N/A | NOT_RUN | root/subpath |
| W-ANDROID | 必須 | Emu Chrome可、実版未記録 | NOT_RUN | NOT_RUN | NOT_RUN | N/A | NOT_RUN | root/subpath |
| N-IOS-DEVICE | 後続 | 未選定 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | 初回はSim先行 |
| N-ANDROID-DEVICE | 後続 | 未選定 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | 初回はEmulatorのみ |

「共通試験」列は対象に適用する試験IDの集計。詳細は下表とrun記録へ記載する。W系列のroot/subpath結果はrunを分ける。Web buildを共用する場合は同じ成果物hashを参照する。

| 試験ID | 対象・条件 | 結果 | run ID | 未完了理由・次操作 |
|---|---|---|---|---|
| C-01〜C-04 | C++・FFI・WASM | NOT_RUN | | |
| A-01〜A-04 | 入力・応答・確保 | NOT_RUN | | |
| N-01 / W-01〜W-03 | 実経路・配信 | NOT_RUN | | |
| L-01〜L-04 | 通信・寿命 | NOT_RUN | | |
| P-01 | native同梱起動 | NOT_RUN | | |
| S-01〜S-02 | 権限・CSP | NOT_RUN | | |
| R-01〜R-03 | 再現性・記録 | NOT_RUN | | |

実行時は試験ID・対象・条件ごとに行を分ける。PASS / FAIL / BLOCKED / NOT_RUNの定義は [検証計画](../06-verification.md) を参照。コピー後はこのリンクを `../docs/06-verification.md` に変更する。
