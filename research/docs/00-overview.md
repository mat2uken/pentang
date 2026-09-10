# 00. 目的・対象・完了条件

## 検証する仮説

**同じUI、同じApplication API、同じC++ソースを共有し、iOS / Android / Windows / macOS / Webで実C++処理を呼べる。** OSごとの業務処理を増やさずに成立するかが判断対象である。

| 仮説 | 必要な証拠 |
|---|---|
| UIとAPIを共有できる | 共通UIから同じ入力・同じself-testを実行し、両経路で一致 |
| nativeで共通C++を使える | 同一header/sourceのビルド記録、実FFIリンク、各アプリ内の結果 |
| Webで共通C++を使える | 通常ブラウザで実Worker内のEmscripten factory・WASMを実行 |
| mobileでも構成を維持できる | Tauri標準hostと共通Rust/C++でビルド・起動。アプリ固有Swift/Kotlin処理なし |
| 手順を別ホストで再現できる | 固定版、クリーンな作業コピー、開発サーバ停止後のnative起動 |

音声の実時間処理、大量データ転送、Slintとの統合、電力・性能の優劣、最低対応OS、ストア公開の可否は、この小さな計算の成功から結論しない。

## 作るもの・作らないもの

作るものは1画面のVanilla TypeScript UI、`getInfo / transform / dispose` の3メソッド、native用Backend、Web用BackendとWorker 1個、C++コア1個、試験・ビルド・記録手順とする。nativeは4OSとも `TauriBackend → 共通Rust wrapper → C ABI → C++`、Webは `BrowserBackend → Dedicated Worker → Emscripten → 同じC++` を使う。

次は初回対象外とする。

- 音声・MIDI・HTTPサービス・ファイルAPI・暗号・BLE・課金・カメラ・QR・Slint・独自Canvas描画。
- PWA / Service Worker、AudioWorklet、pthread / SIMD、SharedArrayBuffer、C++からJSへのcallback、バックグラウンド継続。
- 汎用Job / Plugin / RPC基盤、将来用の空module、Tauri以外の独自host、アプリ固有Swift/Kotlinアダプター。
- 商用配布、署名済みinstaller、審査、更新機構、任意URLや不要なOS権限。

## 初回の必須対象を固定する

旧計画のユーザー回答を踏襲して、初回はmobileのSimulator / Emulatorを使う。元設計の実機試験は後続項目として残す。手元にない環境を理由に必須対象を消さない。

| ID | 対象 | 初回の扱い | 使用環境 |
|---|---|---|---|
| N-MAC | macOS native | 必須 | Apple Silicon実Mac、arm64 |
| N-IOS-SIM | iOS native | 必須 | Apple Silicon上のarm64 Simulator。機種・runtimeはM0固定 |
| N-ANDROID-EMU | Android native | 必須 | Emulator 1台。AVD / API / ABIはM0固定 |
| N-WIN | Windows native | 必須 | Windows 11 x64、MSVC、実Windowsセッション |
| W-CHROMIUM | Web | 必須 | desktop Chromium系1種、実版記録 |
| W-FIREFOX | Web | 必須 | desktop Firefox、実版記録 |
| W-SAFARI | Web | 必須 | macOS実Safari。Playwright WebKitで代用しない |
| W-IOS | Web | 必須 | iOS Simulator内Safariで可。nativeアプリとは別に試験 |
| W-ANDROID | Web | 必須 | Android Emulator内Chromeで可。nativeアプリとは別に試験 |
| N-IOS-DEVICE | iOS実機 | 後続 | 署名・対象端末を選択後、別途実施 |
| N-ANDROID-DEVICE | Android実機 | 後続 | Emulatorのみという初回選択に従い未着手 |

Windows利用先は未確認。利用不能と分かった場合は理由付きBLOCKEDとし、その行が通るまで初回PoC全体は未完了。署名を調べていないiOS実機を、あらかじめ「署名失敗」「BLOCKED」と断定しない。

## 完了の判定

| 呼び方 | 必要条件 |
|---|---|
| 計画改訂完了 | 本文・参照定義・期待値・試験手順を点検済み。コード完成を意味しない |
| ローカル先行検証完了 | N-WIN以外の初回必須行と、該当する共通試験がPASS |
| 初回5環境の検証完了 | 初回必須9行と共通試験が同じ採用版でPASS。mobileはSim/Emuと明記 |
| 元設計の実機確認完了 | 後続2行も追加実測済み。初回PoC完了とは別に記録 |

実装準備、build、launch、アプリ内self-test、native同梱起動を分ける。UI表示やC++単体試験だけを全体PASSにしない。結果は [06-verification.md](06-verification.md) の規則で集計する。

## 実装時の配置と変更範囲

rootに実装を置き、既存docsを保持する。Gitを使う段階では最初に状態を再確認し、未初期化ならその時点の実装依頼の範囲で初期化する。branch名の候補は `feature/common-core-poc`。段階ごとにレビュー可能な差分を作るが、commitとpushはそれぞれ明示された依頼に従う。

native/webでheader・アルゴリズムを複製しない。失敗時の他Backendへの切り替え、Rust/JSによる代替計算は禁止する。nativeビルドはemsdkを要求せず、WebビルドはRust/NDK/Xcodeを要求しない。
