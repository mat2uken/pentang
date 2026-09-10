# 06. 検証・受入・記録

## 判定の単位

対象は [00-overview.md](00-overview.md) の初回必須9行と後続2行を使う。初期値は全てNOT_RUN。試験を実装したことと、実際の実行結果を分ける。

| 状態 | 意味 |
|---|---|
| PASS | 指定した対象・source・条件で試験成功、記録あり |
| FAIL | 試験を実行して失敗。想定した拒否応答が正しければその試験自体はPASS |
| BLOCKED | 必要な前提が不足し開始できない。具体的な不足と再開条件あり |
| NOT_RUN | 未着手。後続扱い・未選定も理由欄で区別 |
| N/A | その列が適用されない場合のみ。Webのnative同梱起動列など |

各行のbuild / launch / self-test / native同梱起動を別々に記録する。Webのbuildは同じdistを再利用できるが、各browserのlaunchとself-testは個別実測する。初回PoC完了には各行の該当列と以下の共通試験が全てPASSであることが必要。

## 試験一覧と実施場所

| ID | 試験 | 実施する層・環境 | 終了条件 |
|---|---|---|---|
| C-01 | 共通期待値 | ホストRust FFI、Web Worker、全アプリ内self-test | valid 10＋4096要素、配列全要素・checksum完全一致 |
| C-02 | Cの引数・数値制限 | CMakeのC++試験 | NULL、count0、capacity、4097、int32極値、規定status・順序 |
| C-03 | メモリの扱い | C++、Rust FFI、Worker | 入力不変、独立出力、sentinel不変、エラー時checksumも不変 |
| C-04 | 再ビルド・リンク | nativeとWebの生成手順 | 同一header/source、変更反映、実C symbolの最終リンク |
| A-01 | 不正入力 | 両Backend、Rust command検証関数、Worker | 元invalid 6＋too-long＋nonJson 4＋追加ケースのcode一致 |
| A-02 | 検証の回避試験 | Rust commandとWorkerをテストから直接呼ぶ | UI/TS検証を通さなくても不正入力を拒否 |
| A-03 | 入力コピー・結果検査 | 両Backend | 呼出し直後のcaller変更の影響なし。壊れた応答を拒否 |
| A-04 | Cエラー・確保失敗 | FFIのstatus変換、Worker確保処理 | capacity内部不備はCORE_FAILURE、部分確保の解放、OOM整形 |
| N-01 | 実native経路 | 各nativeアプリ | 実CのABI/version、basic、C-01を画面から実行 |
| W-01 | 実Worker/WASM経路 | 5つのWeb行 | Worker内実行、mjs/wasm取得、factory後のC呼出し、C-01 |
| W-02 | 配信の互換性 | 5つのWeb行、rootとsubpath | MIME、404、CSP、crossOriginIsolated=falseで成功 |
| W-03 | module / wasm欠落、ABI不一致 | 少なくともChromiumと実Safari | init失敗を表示し、JS計算や別Backendへ切り替えない |
| L-01 | 8要求・9件目・順序逆転 | 両Backendの通信試験、実経路のsmoke | 8要求対応付け、9件目BUSY、pending解放 |
| L-02 | 監視期限・error・messageerror・不正id/method | 制御した通信試験、実Worker障害 | 全pendingが規定codeで一度だけ終了、failedへ移る |
| L-03 | dispose・再生成20回 | macOS native、Chromium、実Safari | dispose2回成功、後続DISPOSED、古い結果でUI更新なし |
| L-04 | 小入力1000回 | ホストFFI、実Worker/WASM | 全結果一致、pending/listener/Workerの未回収増加なし |
| P-01 | 同梱起動 | 初回native4行 | Vite停止後に導入アプリを起動しC-01、破棄・再生成も成功 |
| S-01 | command公開範囲 | macOS実Tauri、mobile設定確認と実invoke | main許可、テスト用非許可window拒否、不要権限なし |
| S-02 | CSP・経路分離 | native同梱build、Web配信build | CSP無効化なし、nativeにWASMなし、WebにTauri実行importなし |
| R-01 | クリーンな作業コピー | 使用するビルドホストごと | 同じsource/設定/lockで再buildし、同じ動作を確認。新成果物をhashで識別 |
| R-02 | SDKの独立性 | native-only / web-onlyの環境 | nativeはemsdkなし、WebはRust/NDK/Xcodeなしでbuild成功 |
| R-03 | 記録の整合 | 全初回必須行 | 同一採用版への紐付け、未実行と成功を区別 |

ASan/UBSanは利用できるホストで追加する補助試験で、初回mobileの必須条件にはしない。寿命の詳細試験は表の指定環境で行い、他環境はP-01のsmokeを行う。OSやbrowser固有の不具合が出た場合だけ詳細試験を追加する。

具体的な入力・期待code・タイマー時刻は [12のケース一覧](12-test-case-catalog.md)、担当工程は [03](03-implementation-plan.md)、前回の指摘との対応は [11](11-review-traceability.md) を参照する。UIの成功計算は11件、APIで拒否した件数は別表示とする。

## 試験の具体化

### 数値とAPI

- C-02は単一不備だけでなく、上限超過＋NULL等の複合不備でも規定順になることを確認する。
- C-03は出力とchecksumを既知値にしてからエラーを発生させ、両方不変かを見る。偽の有効pointerやallocationより大きなcapacityは渡さない。
- A-01はoffset小数/範囲外、空field、string/null/boolean、疎配列、余分field、`-0 / 1.0`、複数不備の優先順位を含む。
- 画面self-testはC-01と公開APIで再現できるA-01を実行し、件数と失敗IDを表示する。NULL pointer試験等をUIへ公開しない。

### 通信と寿命

9件目のBUSY試験は、返信を明示的に保留するtest transportを使い、8件が未完了の間に9件目を送る。実計算の偶然の遅さに依存させない。timerはテスト内部で短縮・制御できるようにするが、公開APIに故障注入methodを追加しない。

制御したテストで順序逆転、遅い旧id、不正method、Worker error、timeoutを発生させる。これは通信処理の検査であり、実C++経路の証明はN-01/W-01で別に行う。実WorkerでもWASM取得失敗と強制終了により、無限待ちにならないことを確認する。

Workerの無通知停止はTIMEOUTで検知する。terminateしたら必ずerrorが来るという試験は作らない。disposeによる停止はその場でDISPOSEDにする。期限イベントと成功イベントが同時刻なら先に処理した方だけで終了し、後続イベントを破棄する。

20回再生成・1000回計算では、test内部のpending/timer/listener数とWorkerの生成・終了数を対応付ける。WASMの割当/解放byte数も試験用に集計する。JSのGC時期やRSSの一時的増加だけでleakを断定しない。最大64MiBのheapは縮まらなくてもよいが、要求ごとの未解放増加は不合格。

### 実経路と同梱起動

版情報ラベルだけで実C++経路を証明しない。source参照・compiler/linkログ・ブラウザのWorker/Network記録と、実アプリ内のfixture成功を組み合わせる。

nativeはVite停止後に自己完結する成果物を起動する。試験記録の取得に必要なadb等まで一律切断する必要はない。開発UI配信への依存がないことを確認し、可能ならネットワーク切断後にも再起動する。Webのoffline再起動は対象外。

### 権限とCSP

macOSではtest専用の非許可windowから2commandをinvokeして拒否を確認する。mobileでは同じAppManifest/capabilityが適用され、許可されたUIから2commandが動くことを確認する。テスト専用window・設定を同梱する本採用buildに残さない。

Webでは実際の応答headerを保存し、欠落wasmの404やWorker自身のCSPも検査する。CSPを外して成功した結果はS-02のPASSに使わない。

## 証拠の保存と集計

[verification-matrix雛形](templates/verification-matrix.md) を `../reports/verification-matrix.md`、[run-record雛形](templates/run-record.md) をrunごとにコピーする。履歴は追記し、失敗記録を成功で消さない。

必須記録はrun ID、日時とtimezone、対象ID、source commitとdirty状態、toolchain lockのhash、実コマンドと終了code、成果物のhash/配置先、OS/CPU/SDK/browser/WebView、試験ID、画面/ログ参照、次の操作である。

ファイルはSHA-256、.appやdist等のdirectoryは相対pathと各ファイルのSHA-256を整列したmanifestで識別する。symlinkは参照先文字列を記録し、外部directoryを辿らない。このmanifest自体は対象directoryの外へ置き、自己参照を作らない。

Git未初期化・未commit時はその事実とsource一覧/hashを記録し、架空SHAを書かない。採用版は共通sourceと設定を固定して識別し、異なるSHAの成功を合算しない。文書のみの変更で再実行を省略する場合は、build入力が同じであることを明示する。

R-01は同一入力からの再ビルドと動作再現を確認する。署名やtimestampを含む成果物のbyte完全一致は求めず、各成果物のhashは識別に使う。R-02は不要SDKを持たない環境で確認し、PATH遮断だけの結果は依存がないことの補助確認として区別する。

共有するmatrix/要約ではrepository相対pathとrun IDを使う。端末serial・ユーザー名入り絶対path・署名情報・生ログは `../reports/local/<run-id>/` 等のGit対象外へ置く。成果物の実pathが必要な実行記録はローカル版に保持し、共有版は伏せたpathとhashにする。

初回必須行の不足が残る場合は「ローカル先行検証完了」「実装済み、N-WIN未検証」等の正確な範囲を記載する。過去の成功は現在の採用版の成功として転記しない。
