# 07. 判断記録・未解決事項

## 継承した選択

次の3点は旧docsにユーザー回答済みと記載されていたため、本改訂でも維持する。今回、改めて回答を取得したという意味ではない。

| ID | 選択 | 初回計画への反映 |
|---|---|---|
| D1 | Node 24 LTS | M0で具体patchとnpmを固定。ホスト26を無条件に使わない |
| D2 | iOS Simulator先行 | 初回必須はSim、実機は後続。未診断の署名不足を断定しない |
| D3 | Android Emulatorのみ | 初回必須はAVD、実機は後続。APKとAVDのABIを一致させる |

## v1.1で具体化した事項

| ID | 判断 | 理由・影響 |
|---|---|---|
| D4 | 実装はroot、既存docsを保持 | 現状はdocsのみ・非Git。自動commit/pushの予定は外す |
| D5 | 元4定義をdocsに固定保存、実装開始時に単一の編集先へ移す | ZIPの所在依存と二重改変を避ける |
| D6 | 初回必須9行、実機2行は後続 | Windows、全Web browser、Sim/Emuを含む完了条件を明確化 |
| D7 | mobile前提はM0、最終リンクはM1で早期確認 | C++/SDK問題をM4まで発見できない構成を改善 |
| D8 | timeoutは全pending終了・failed化、復帰は明示的再生成 | 生きていない通信先に要求を続けない |
| D9 | 厳格field、疎配列拒否、値としての1.0/-0受理、受付時コピー | JS/JSON/Rustの差とcaller変更の影響を明確化 |
| D10 | Tauri AppManifest＋個別permission＋capability | 独自commandの既定公開範囲を確実に制限して試験 |
| D11 | 検証用静的配信でCSP/MIME/404を指定 | devサーバの偶然の挙動でWeb受入を通さない |

D6では元設計のmobile Web試験を残し、初回はSimulator内Safari / Emulator内Chromeを認める。実機ブラウザや実機nativeまで確認したとは報告しない。元4定義の関数・型・期待値は変更していない。

## v1.2の実装上の初期選択

| ID | 判断 | 反映箇所 |
|---|---|---|
| D12 | 工程を27ステップにし、編集先・依存・確認・障害時の行動を固定 | 03、詳細手順3冊、工程tracker |
| D13 | Node単体試験はVitest専用config、Web E2EはPlaywright Test、Safariは実アプリ | M0-02/M1-04/M2-01。具体版はlockへ |
| D14 | 新規Rustは2024/resolver 3を初期選択、project名はmobile生成前に固定 | M0-02/M0-04。template適合を確認して採用 |
| D15 | doctorにtools/build/run、型検査にscopeを導入 | M0-03、01/05。生成前projectやbrowserでbuildを止めない |
| D16 | 検証済み引数のC非0はCORE_FAILUREとしてfailed化 | 04、M1-02/M3-01。C単体試験のstatusは維持 |
| D17 | Web memoryは初期16MiB/最大64MiB、成功buildのbase/hashを配信外へ記録 | 05、M2-01/M2-04 |
| D18 | 再現性は同一入力と動作で判定、SDK独立性は実体のない環境で確認 | 06、M5-01 |

これらは計画精緻化で選んだ初期方針であり、実装済み・互換性検証済みという意味ではない。依存条件や実測により変更が必要なら、変更した項目・理由・影響する手順と試験を記録する。

## 着手時に解決する事項

| ID | 未決事項 | 解決する段階・担当 | 終了条件 |
|---|---|---|---|
| O1 | Node / npm / generator / Vite / TS / Tauri / Rust / cc / test runnerの具体版 | M0-02/M0-04、実装担当 | 具体版とtemplate build結果を保存 |
| O2 | emsdkの具体版とmodule exports | M2-01/M2-02、Web担当 | 実factory＋Worker試験成功、版固定 |
| O3 | NDK / Gradle / JDK / Android SDK / AVD / ABI | M0-05/M1-05、mobile担当 | 最終APKリンク、対象一致 |
| O4 | Xcode / CocoaPods / Sim runtime / deployment target | M0-05/M1-05、mobile担当 | Sim用.appリンク、署名関連の実条件を記録 |
| O5 | Windows利用先と実行担当 | M0-05から調整、M4-05で実行 | Windows側でdoctorを実行できる |
| O6 | Firefox / Safari / mobile browserと到達URL | M0-05診断、M2-04/M4-06実行 | 全必須Web行を配信buildで試験可能 |
| O7 | 不要SDKを持たない再現用のホスト/container | M0-05で候補確認、M5-01で実行 | native-only/web-onlyのR-02を実施できる。既存SDKは削除しない |

担当欄は役割名であり、別担当者やサブエージェントへの依頼を実施済みという意味ではない。

## リスクと対処

| リスク | 検出 | 最小の対処・再開条件 |
|---|---|---|
| Android NDK/C++ runtime不一致 | M1最終リンク、APKの依存確認 | target別compiler/API/runtime設定を修正 |
| iOS device/Sim archive混入 | compiler引数とMach-Oのplatform確認 | target別出力へ分離、SDK設定を修正 |
| module WorkerやCSPのbrowser差 | M2で実Safari、M4で残るbrowser | URL・配信header・固定版の設定を修正。main threadへ変更しない |
| timeout/dispose後の古い結果 | L-02/L-03 | instance世代とpendingの一度だけ終了を修正 |
| キャッシュや古い成果物で成功誤認 | C-04/R-03 | source/設定/成果物hashとno-store配信で確認 |
| Windows未確保 | M0のO5 | 他作業は継続し、N-WINは未検証。別ホスト引き継ぎを用意 |
| 範囲の拡大 | 各段階の差分レビュー | 新しい機能や独自hostを持ち込まず、必要なら別PoC候補として記録 |

OS対応を削除する、公開APIを増やす、独自hostへ変える、実機署名や公開を新たに実施する場合は、その時点のユーザー依頼の範囲を確認する。通常の設定修正を理由に、既に許可された作業を毎回止めない。
