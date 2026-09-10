# 11. 指摘対応の再確認 v1.2

前回の12件は、対応する説明が存在するだけでなく、実装ステップ・確認方法・終了条件へつながっているかを再点検した。**12件すべて文書上の対処を確認済み。アプリ側の試験は全件未実施である。**

DOC_ADDRESSEDは計画上の対処が具体化された意味で、実動作のPASSではない。未固定のtoolchainや未確保のWindows、SDK独立性用の環境は [07のO1〜O7](07-decisions-risks.md) で追跡する。

## 前回の12件

| 指摘 | 対処を確認した文書 | 実装するステップ | 確認方法 | 文書判定 | 実動作 |
|---|---|---|---|---|---|
| R1 必須対象・完了判定 | [00](00-overview.md)、[検証表](templates/verification-matrix.md) | M0-01、M4-01〜M4-06、M5-03 | 9必須/2後続の一致、P-01/W-01/R-03 | DOC_ADDRESSED | NOT_RUN |
| R2 未診断のBLOCKED断定 | [01](01-environment.md)、[07](07-decisions-risks.md) | M0-03、M0-05 | target/phase別診断、不足理由と再開条件 | DOC_ADDRESSED | NOT_RUN |
| R3 外部ZIP依存・正本移行 | [04](04-contracts.md)、[元定義](reference/poc-v1/README.md) | M0-01、M5-03 | 同梱hash、移行先とimport差分、R-03 | DOC_ADDRESSED | NOT_RUN |
| R4 Tauri独自commandの公開範囲 | [02](02-architecture.md)、[手順1](implementation/01-setup-native.md#m1-03) | M1-03、M3-04、M4-03〜M4-04 | S-01、main許可/別window拒否、mobile適用 | DOC_ADDRESSED | NOT_RUN |
| R5 mobileリンク確認が遅い | [工程](03-implementation-plan.md)、[手順1](implementation/01-setup-native.md#m1-05) | M0-05、M1-05 | 空host→実C++を含む最終リンク、C-04 | DOC_ADDRESSED | NOT_RUN |
| R6 timeout/dispose/古いfactory | [04](04-contracts.md)、[具体ケース](12-test-case-catalog.md) | M1-04、M2-03、M3-02〜M3-03 | L-01〜L-04、全pending一度だけ終了 | DOC_ADDRESSED | NOT_RUN |
| R7 入力変更・疎配列・JSON差 | [04](04-contracts.md)、[具体ケース](12-test-case-catalog.md) | M1-03〜M1-04、M2-02、M3-01 | A-01〜A-04、各値と検査順の一致 | DOC_ADDRESSED | NOT_RUN |
| R8 SDK一括固定・Sim署名前提 | [01](01-environment.md)、[script仕様](05-build-run.md) | M0-02〜M0-05、M2-01 | tools/build/runの分離、対象別lock、R-02 | DOC_ADDRESSED | NOT_RUN |
| R9 subpath/CSP/404/対象導入 | [05](05-build-run.md)、[手順3](implementation/03-platform-verification.md) | M2-04、M4-02〜M4-06 | W-02/W-03/P-01、実URL/UDID/serial | DOC_ADDRESSED | NOT_RUN |
| R10 compiler名による誤判定 | [05](05-build-run.md)、[手順1](implementation/01-setup-native.md#m1-05) | M1-02、M1-05、M4-05 | target/sysroot/object/最終リンク、C-04 | DOC_ADDRESSED | NOT_RUN |
| R11 BUSY・leakの再現方法 | [06](06-verification.md)、[具体ケース](12-test-case-catalog.md) | M3-01〜M3-03 | 保留8件/9件目、割当解放、L-01〜L-04 | DOC_ADDRESSED | NOT_RUN |
| R12 記録path・commitの混同 | [08](08-handoff.md)、[run雛形](templates/run-record.md) | M0-01、M4-01、M5-03 | ローカル記録と共有要約、source/成果物のR-03 | DOC_ADDRESSED | NOT_RUN |

## 再点検で補った8項目

| 指摘 | v1.1に残っていた不足 | v1.2の対処・担当ステップ |
|---|---|---|
| R13 | M0の空画面確認で最終build:webを使うと、未作成C++/emsdkが必要 | M0-04はVite単独のbootstrap、M2-04から最終scriptへ移行 |
| R14 | 作業名はあるが編集先・依存・実コマンド・障害時の行動が足りない | 27ステップへ分解し、工程trackerと3冊の詳細手順を追加 |
| R15 | Rust JSON形と検証済み入力に対するCエラーの扱いが曖昧 | 04で応答形・camelCase・正規化・CORE_FAILUREを定義。M1-03/M3-01 |
| R16 | validation/権限をM3まで後回しにできる読み方 | M1/M2の接続時から導入し、M3は検証・修正の段階と明記 |
| R17 | doctorが生成前projectや未導入browserまで必須にして開始を止め得る | tools/build/runを分け、M0-03から段階別の必須項目を明示 |
| R18 | test runnerやtsconfig/Vite test modeの扱いが未選択 | Vitest専用configとPlaywrightを初期選択、型検査scopeと導入段階を固定 |
| R19 | 再現性が署名付きbundleのbyte一致とも読め、PATH遮断だけのSDK独立性は弱い | R-01は同一入力と動作、R-02はSDKを持たない環境で検証。M5-01 |
| R20 | timeoutの正確な期待、Worker無通知停止、全試験の値/条件が不足 | 12のケース表とM3-02へ条件・code・state・回収を明記 |

追加8項目もDOC_ADDRESSED。ここに実装・実機試験の成功を記載していない。

## 実装開始後の閉じ方

1. 各ステップの終了条件を満たし、trackerへ実コマンドとrun参照を記録する。
2. 上表の確認方法に対応する実行結果を集める。実行不足はNOT_RUN、前提不足はBLOCKED、実行失敗はFAIL。
3. 共有sourceを修正した場合は影響する試験を新runで実施する。
4. M5-03で全対象を集計し、文書の対処完了とアプリでの対処確認を別々に報告する。
