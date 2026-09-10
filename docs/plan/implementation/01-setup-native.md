# 実装手順1 — M0の準備とM1のnative経路

[工程一覧](../03-implementation-plan.md)に戻る。以下のコマンドは実装着手後の手順で、今のdocsだけの作業先ではまだ動かない。`<実値>` は直前の診断や生成結果から置き換える。shell変数で引き継ぐ場合は作業用の名前を使う。

各ステップを終えたらtrackerへ結果とrun IDを記録する。通常の担当は現在の実装担当者。長時間の試験だけを共通作業方針に従ってLuna Mediumへ渡す。

<a id="m0-01"></a>
## M0-01 — 開始状態・参照定義・記録の準備

**前提:** 実装着手の依頼がある。**編集先:** root README、`.gitignore`、`.gitattributes`、`../../reports/`、参照定義の実装側配置先。

1. `pwd`、Gitの有無、branch/HEAD、変更一覧を取得する。未初期化なら実装依頼の範囲で初期化する。docsや既存 `AGENTS.md` は保持する。
2. [04の配置表](../04-contracts.md) に従って4定義をコピーし、コピー直後のhashを照合する。Worker型のimportを `../../api/application-api` に変更し、その1差分を記録する。
3. [検証表](../templates/verification-matrix.md)、[工程tracker](../templates/implementation-tracker.md)、[実行記録](../templates/run-record.md) をreportsへ用意する。相対リンクはコピー先に合わせて直す。
4. `.gitattributes` でテキストをLFにし、生成物とローカル情報をignoreする。`src-tauri/gen` 全体はignoreしない。
5. root READMEに目的、初回必須対象、docsへの入口、現在の段階を書き、未作成scriptは未作成と表示する。

**確認:** 原文4定義の一致、必須9行・後続2行、全実行結果NOT_RUN。**失敗時:** 参照hash不一致はコピー元と改行を調べ、正本を上書きしない。**終了:** 記録先と変更対象が確定。build/launchのPASSは付けない。

<a id="m0-02"></a>
## M0-02 — 版と実装上の初期選択を固定

**依存:** M0-01。**編集先:** `.node-version`、`package.json`、`package-lock.json`、`rust-toolchain.toml`、`toolchains.lock.json`、decision log。

1. 既存のNode管理手段で、この作業用shellにNode 24の具体patchを選ぶ。実際のnode/npmを記録し、ホスト全体の既定版は変更しない。
2. Node 24で使える安定版のTauri 2 CLI/API、公式generator、Vite、TypeScriptを候補にし、公開メタデータのenginesと依存条件を確認する。prereleaseは選ばない。
3. 単体試験はVitest、Web E2EはPlaywright Testを使う。M0では対応する具体版を固定し、browserバイナリの導入はM2で行う。VitestはVite設定を暗黙に読むため、後で専用configに分ける。[Vitest公式](https://vitest.dev/guide/)
4. Rustは確認済み1.96.1を最初の候補とし、採用templateとの適合を確認して固定する。新規crateはedition 2024、virtual workspaceはresolver 3。template側に制約があれば具体的な理由を記録して合わせる。[Cargo公式](https://doc.rust-lang.org/cargo/reference/workspaces.html)
5. npm依存は具体版で記述してlockを生成する。Tauri関連のnpm/crateを同じpatchへ機械的に揃えない。emsdkはM2-01、target SDKは使用前に解決する。
6. 初期名はproduct `Common Core PoC`、package `poc-app`、Rust lib `poc_app_lib`、bundle ID `dev.example.commoncorepoc`、window label `main` とする。mobile生成前に決め、生成後に名前だけ変更しない。

**確認:** Nodeの実版と設定一致、依存の解決成功。template build適合はM0-04で判断。**失敗時:** 最初のengine/依存エラーを保存し、競合した依存だけ互換な安定版へ変更する。latestの再解決を繰り返さない。**終了:** 選んだ版と未解決SDKが区別される。

<a id="m0-03"></a>
## M0-03 — Node scriptsとdoctorを用意

**依存:** M0-02。**編集先:** `scripts/doctor.mjs`、`scripts/typecheck.mjs`、`scripts/build-ui.mjs`、必要なNode共通関数、package scripts。

1. [05のscript表](../05-build-run.md) を実装開始順に登録する。存在しないscriptを成功扱いのダミーにしない。Web最終buildはM2まで未提供でよい。
2. doctorに `--target` と `--phase tools|build|run` を用意する。既定はbuild。toolsは外部tool、buildは生成済みproject/lockを含むビルド前提、runは成果物と実行環境を診断する。
3. `doctor -- --target native --phase tools` から始める。mobile tools診断は生成Gradle/Xcode projectの不存在で失敗させない。Web buildにbrowserがないことをビルド不能としない。
4. 子processは引数配列で起動し、cwdをrootへ固定する。exit codeと標準出力/エラーを維持し、失敗を握りつぶさない。Windowsの.cmd/.bat対応はSDK起動部分に限定する。
5. 型検査のscopeを `native|web|all` にする。M0はnativeだけを提供し、M2でweb/allを追加する。生成WASMを型検査の入力にしない。

**確認:** 正常なtools診断、存在しない実行path/不一致版の診断、unknown引数の非0終了。**失敗時:** PATH、選択版、生成前の項目を混ぜていないかを確認。**終了:** 不足項目と必要な次操作が分かる。空projectのbuildは次ステップ。

<a id="m0-04"></a>
## M0-04 — Tauri/Viteの空画面を成立させる

**依存:** M0-03。**編集先:** 公式template由来の `src-tauri/`、`index.html`、`src/main.ts`、CSS、Vite/TS設定、Cargo workspace。

1. 固定した `create-tauri-app` のhelpを確認して別の一時directoryへ生成する。選択はnpm、Vanilla、TypeScript。2種類のgeneratorをrootへ重ねて実行しない。
2. 必要なtemplateファイルだけrootへ移し、M0-02の名称に揃える。固定済みpackage.json/lockを生成版で置換せず、必要なscript/依存だけ統合する。不要なgreet/openerとサンプル画像を取り除き、mobile entry、crate-type、main→libのrunを保持する。
3. この時点のCargo workspace memberは存在する `src-tauri` のみ。FFI crateはM1-02で追加する。rootにCargo.lockをまとめる。
4. Viteはtauri/web modeを明示し、outDir/publicDirを分ける。M0の `src/main.ts` は空画面だけを描き、未作成Backendをimportしない。fake RuntimeInfoや計算結果は作らない。
5. `tsconfig.base.json`、`tsconfig.native.json`、`tsconfig.node.json` を作る。strict/noEmit、Node用とDOM用のlibを分ける。`@backend` のnative aliasはM1接続時に使用する。
6. native用build/dev hookとCSPの基準を設定する。Web最終buildは使わず、次のbootstrap用コマンドで空画面だけを確認する。

```sh
npm run typecheck -- --scope native
npm run build:native-ui
npm run tauri -- dev
# 別の実行として、Viteだけの静的UIを確認
npm exec -- vite build --mode web
npm exec -- vite preview --mode web
```

**確認:** macOS空window、Web静的画面、mode別出力。これらはW-01/N-01のPASSではない。**失敗時:** hookのcwd、固定CLI、Vite port、desktop entryを調べる。**終了:** emsdkなしでbootstrapできる。M2完了後はREADMEのbootstrap手順を通常の `build:web` 手順に置き換える。

<a id="m0-05"></a>
## M0-05 — mobile hostと実行環境を選定する

**依存:** M0-04。**編集先:** `src-tauri/gen/android`、`gen/apple`、target別設定、toolchain lock、ローカルの実行先記録。

1. iOS/Androidのtools診断を行い、Xcode/SDK/CocoaPods、JDK/単一NDK/SDKの実値を保存する。
2. iOSはApple Silicon用Sim、Androidは使用ホストで動くAVDを1台ずつ選ぶ。候補が複数なら既存の利用可能なarm64環境を優先し、runtime/API/ABIを固定する。新規imageの導入が必要なら必要な1種類に絞る。
3. 固定Tauri CLIで `ios init` / `android init` を初回だけ実行する。生成内容を確認してからbuild phaseのdoctorを行い、空アプリを対象用にbuildする。
4. team入力が必要ならSimulatorの対象・CLI/SDK設定を調べる。未診断のまま実機署名不足と結論しない。独自iOS hostを作らない。
5. Windows実行先と担当、desktopの3browser、Sim Safari/Emu Chromeの有無を記録する。SDK独立性R-02に使える既存ホスト/containerも候補を確認する。利用できない項目には不足内容と再開条件を書く。

**確認:** Sim/AVDの識別情報と空アプリのbuild結果。**失敗時:** SDK不足、署名設定、生成host、compiler/linkを分けて記録。**終了:** 両mobileの成功または具体的な障害記録がある。障害があってもM1-01〜M1-04は進められる。

<a id="m1-01"></a>
## M1-01 — 共通C++とC単体試験

**依存:** M0-04。**編集先:** `cpp/src/core.cpp`、`cpp/tests/core_test.cpp`、root `CMakeLists.txt`、`scripts/test-core.mjs`。

1. headerを変更せず、3関数を定義する。ABI=1、静的UTF-8版文字列=0.1.0を返す。
2. transformの検査を規定順に書き、検査完了後だけ出力へ書く。積・和はint64、clamp後のchecksumはuint32加算にする。
3. CMakeは単体試験用に限定し、製品用archiveを外部directoryへ置く方式にしない。CTestで [試験ケース表](../12-test-case-catalog.md) のC系列を実行する。
4. `test:core` はconfigure→build→CTestを順に行い、Debug/Release等のconfigを明示する。assertが無効になるbuildでも検査が消えない実装にする。

**確認:** C-02/C-03、基本変換、正負飽和、極値、empty、4096/4097、検査順、sentinelとchecksum不変。**失敗時:** 最初の相違でC++を修正し、期待値を実装に合わせて変更しない。**終了:** ホストC++試験PASS、OS依存header・動的確保なし。

<a id="m1-02"></a>
## M1-02 — Cargo workspaceとsafe FFI

**依存:** M1-01。**編集先:** `crates/poc-core-ffi/{Cargo.toml,build.rs,src/lib.rs,tests/golden.rs}`、root Cargo設定。

1. workspaceにFFI crateを追加し、Tauri非依存にする。C ABI宣言はprivateな `unsafe extern "C"` にまとめる。
2. build.rsは同じcore.cppをC++17でコンパイルする。`CARGO_MANIFEST_DIR / TARGET / OUT_DIR` を使用し、header/sourceの再ビルド条件を設定する。compiler/SDK引数をverboseログで確認する。
3. safe APIは `get_info() -> Result<CoreInfo, CoreError>` と `transform(&[i32], i32, i32) -> Result<TransformResult, CoreError>` を基本とする。入力上限、別領域出力、checksumの寿命を保証する。
4. 出力Vecは `try_reserve_exact` で確保失敗を捕捉し、resizeで初期化してからpointerを渡す。未初期化の要素を安全なsliceとして扱わない。版文字列はコピーする。[Rust Vec公式](https://doc.rust-lang.org/std/vec/struct.Vec.html#method.try_reserve_exact)
5. golden.rsはrepositoryの単一fixtureを実行時/compile時に参照し、同じJSONの別コピーを持たない。生成4096ケースも展開する。

```sh
cargo test -p poc-core-ffi --locked
cargo build -p poc-core-ffi --locked -vv
```

**確認:** C-01〜C-03のFFI分、header/source変更で再compile、最終リンク。**失敗時:** Rust宣言と固定幅、count/capacity、ccのtargetを確認。**終了:** unsafeをprivateに封じ、C++から返った予期しないstatusをCORE_FAILUREとして扱える。成果物hashを記録する。

<a id="m1-03"></a>
## M1-03 — Rust command・DTO・公開範囲

**依存:** M1-02。**編集先:** `src-tauri/src/commands.rs`、`src/lib.rs`、Cargo依存、Tauri build.rs/permissions/capabilities。

1. `commands.rs` にIPC DTO、validation、エラー変換を置く。package名を `poc-app` とし、shared libのrunから2commandを登録する。
2. `poc_get_info` は実FFIの版情報から完全なRuntimeInfo形を返す。`poc_transform` は `request: serde_json::Value` を検査してFFIへ渡す。JSON field、null、1.0等の扱いは [04](../04-contracts.md) に合わせる。
3. Rustの応答は `#[serde(rename_all = "camelCase")]` 等で公開field名に揃える。AppError codeは大文字の指定文字列、messageは説明用とする。C++計算をRustへ再実装しない。
4. `AppManifest::commands`、`allow-poc-api`、mainのcapabilityを**command公開と同時に**導入する。M3まで無制限公開を残す手順にしない。
5. DTO/validation/serializationのRust試験を追加する。外側のIPC引数欠落はTauriの拒否、内側のrequest不正はAppErrorと分ける。

```sh
cargo test -p poc-app --lib --locked
npm run tauri -- build --debug --target aarch64-apple-darwin --bundles app
```

**確認:** RustからのJSON形、拒否code、mobile entryからも同じcommand登録。**失敗時:** field名、invoke引数、Tauri build.rsの既存処理を失っていないかを確認。**終了:** 実FFIを呼ぶ2commandと公開範囲が揃う。非許可windowの実拒否はM3-04で追加確認する。

<a id="m1-04"></a>
## M1-04 — TauriBackend・共通UI・self-test

**依存:** M1-03。**編集先:** `src/api/{validation,errors}.ts`、`src/backends/request-state.ts`、`src/backends/tauri/index.ts`、UI、`src/self-test/`、`tests/api/`。

1. validationと即時入力コピーを実装する。TauriBackendの公開factoryは引数なし。test用のinvoke/clock注入は内部関数だけに設ける。
2. `request-state.ts` は今回の3種類の要求だけを扱い、単調id、Map、8件制限、15秒/5秒、finish/fail/disposeを担当する。汎用method registryや別のRPC APIにしない。
3. factoryはinit扱いで実getInfoを待ち、応答/ABI検査後にresolveする。invoke開始前にpending登録し、成功/失敗でtimerを片付ける。
4. UIから `@backend` をimportして接続する。initializing/ready/failed/disposed、基本入力、実行結果、破棄と再初期化を実装する。8要求・破棄規則はM3まで未実装にしない。
5. self-testは単一fixtureを読み、API経由で成功11件を順次比較する。入力不正の件数は別表示し、C++を実行していない拒否試験を成功計算件数に含めない。
6. 専用Vitest configで `tests/api` のみを実行する。Node testがViteの未知modeエラーやWorkerのDOM型に巻き込まれないようにする。

```sh
npm run typecheck -- --scope native
npm run test:api
npm run tauri -- dev
```

**確認:** N-MACのN-01、C-01、基本的なdispose。画面上のC++情報と結果の記録。**失敗時:** command登録→外側request→Rust検証→FFI→返信の順でログを追う。**終了:** 同じUIが実C++を呼び、表示名だけの成功でない。

<a id="m1-05"></a>
## M1-05 — mobile向け最終リンクを先に確認

**依存:** M0-05とM1-04。**編集先:** target別のbuild設定。core.cppはOS別に分けない。

1. 対象のdoctorをbuild phaseで実行し、選んだSDK/NDK/ABIを確認する。
2. iOS Simは `aarch64-sim`、AndroidはAVDに対応する短いtarget名でTauri buildする。
3. compileログに同一core.cpp、正しいtarget/sysroot、出力directoryがあることを確認する。Appleではobjectのplatformも調べ、CPUだけで判定しない。
4. Android APK内の.soのABI・必要なC++ runtime、iOSのSim用.appを確認する。RustやC++のcompileだけで止めず、最終リンクを通す。
5. mobileの画面操作はM4で全項目を行う。ここで余力があればbasicを実行し、その限定した試験だけ記録する。

**確認:** 両mobileのbuild結果、C-04のtarget別確認。**失敗時:** AndroidはNDK/API/CXX/AR/runtime、iOSはSDK/Sim-device混入/deployment targetの順で切り分ける。**終了:** 成功したtargetだけDONE。未解決targetは障害と再開条件を記録し、独立するM2は続行する。mobile行を未実測のままPASSにはしない。
