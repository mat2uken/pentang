# 実装手順2 — M2のWeb経路とM3の異常系

[工程一覧](../03-implementation-plan.md)に戻る。入力検査、公開範囲、監視期限、disposeは最初にBackendを接続する段階から実装する。M3はそれらを故障注入で確かめて仕上げる段階である。

<a id="m2-01"></a>
## M2-01 — EmscriptenとWASM生成を固定

**依存:** M1-01。**編集先:** `scripts/build-wasm.mjs`、toolchain lock、package scripts。生成先は `web-public/wasm/`。

1. 公式emsdkの安定版から具体versionを選び、install/activateした実版を記録する。native用PATHと分け、Web build時だけ有効化する。
2. [05の引数](../05-build-run.md)を配列で組み立てる。同じcore.cpp/includeを入力にし、出力2ファイルを一時directoryへ生成する。
3. em++が非0なら旧ファイルを新成功結果として扱わない。成功後にmjs/wasmの存在とhashを確認し、組として公開先へ移す。cacheを使う場合はsource/header/flags/em++版をキーにする。
4. 初期memory 16MiB、最大64MiB、memory growth有効、通常wasm32を記録する。factoryと5つのC exports、3つのruntime要素は次ステップの実Worker内で確認する。
5. 固定済みPlaywright TestでChromium用バイナリを導入する。実SafariはOS付属アプリを使い、Playwright WebKitで代用しない。[Playwright公式](https://playwright.dev/docs/browsers)

```sh
npm run doctor -- --target web --phase build
npm run build:wasm
npm exec -- playwright install chromium
```

**確認:** コンパイル成功、2ファイル、入力/flags/出力hash。**失敗時:** emsdk有効化、固定版のflag、exportsの綴りを確認。**終了:** 実Workerでロードできる候補が作成済み。C++実行のPASSはまだ付けない。

<a id="m2-02"></a>
## M2-02 — Workerのinit・C呼び出し・heap処理

**依存:** M2-01。**編集先:** `core.worker.ts`、`wasm-types.ts`、Worker protocolの検証関数、`tsconfig.worker.json`、test用Worker harness。

1. Worker内で実行されていることを確認し、初期状態をuninitializedにする。init開始時に状態を先に変更し、同時に届く重複initを拒否する。
2. protocolVersion/id/methodと、固定配下の同一origin URLを検査する。URLにquery/hash、別origin、想定外のファイル名を許さない。
3. `import(/* @vite-ignore */ moduleUrl)`、default factory、`locateFile`、await、exportsの型検査、実ABI検査の順で進む。失敗時はINITIALIZATION_FAILED等の規定codeを返す。
4. getInfoは実C関数を読む。transformは再検証した入力からcountを決め、[04のheap手順](../04-contracts.md)で確保・実行・コピー・解放する。
5. init以外の処理は同期のC呼び出しを含めWorker内で直列処理する。途中の例外をcatchし、返信できるものはAppErrorに整形する。
6. `tests/web/worker-harness.html` と小さなtest用TS入口からWorker単独を呼ぶ。Vite web modeの開発配信でfactory、全exports、basic、empty、ABI/version、golden11件を確認する。harnessは通常buildの入口へ追加しない。

**確認:** Worker用型検査と実ブラウザでのC-01/W-01の開発配信分。**失敗時:** import→factory→wasm取得→exports→ABI→heapの順で追う。**終了:** main threadへ切り替えず実C++結果が得られる。同梱・配信buildの証明はM2-04で行う。

<a id="m2-03"></a>
## M2-03 — BrowserBackendと同じUIを接続

**依存:** M1-04とM2-02。**編集先:** `src/backends/browser/index.ts`、`request-state.ts`、Vite alias、`tsconfig.web.json`、typecheck/build scripts。

1. Backend factoryでWorkerを1個作る。event listenerとpendingを先に用意してからinitを送る。initの15秒timerにmodule/wasm取得時間も含める。
2. pendingにはid、method、transformの期待する出力長、resolve/reject、timerを保持する。Worker返信とnative invoke完了はそれぞれのBackendで検査し、共通の終了処理に渡す。
3. 不正id・未発行id・method不一致・payload不正は全pendingをTRANSPORT_ERRORで終了する。発行済みで完了済みのidだけを破棄する。
4. ready後のgetInfo/transformは合計8件まで。UIに見せるRuntimeInfoのbrowser/backend/executionは固定値を付け、core情報はWorkerの実C結果を使う。
5. web modeの `@backend` をBrowserBackendへ向け、同じ `src/main.ts/ui.ts` を使う。native/web/worker/nodeの型検査を完成し、`typecheck` の既定をallへ変更する。
6. `dev:web` をWASM生成→Vite web配信として提供し、UIから基本変換とself-testを行う。native buildも再実行し、WASMを要求しないことを確認する。

**確認:** 同じUI・fixtureで両経路一致、初期化失敗表示、dispose基本動作。**失敗時:** alias/paths、WorkerのURL、要求と返信の対応を順に確認。**終了:** C++経路が2本とも実在し、公開APIにWorker型を追加していない。

<a id="m2-04"></a>
## M2-04 — 配信buildとChromium/実Safari

**依存:** M2-03。**編集先:** `scripts/build-web.mjs`、`scripts/serve-web.mjs`、Playwright config、`tests/web`、root README。

1. build:webは型検査→WASM生成→Vite web buildを直列に行う。`--base` は `/` または末尾slash付き絶対pathのみ。全工程成功後にその出力を試験対象とする。
2. preview:webは指定したdistだけを同じprefixで配信する。MIME、CSP、no-store、strict 404を適用する。path traversalを拒否し、任意directoryを公開しない。
3. root buildを作り、Chromiumと実Safariで版情報・基本計算・self-testを実行する。HTML、Worker JS、mjs、wasmの応答とWorker実行記録を保存する。
4. 配信を停止してsubpath用に再buildし、`/poc/` から同じ操作を行う。URLだけ変えてroot buildを流用しない。
5. 別作業コピーでcore版を一時変更し、native/Webの両方に伝わることを確認する。試験後に採用sourceの版とhashが元のままであることを確認する。
6. 通常のbuildにtest harnessや故障注入設定が入っていないことを確認し、READMEのM0 bootstrap手順を最終scriptへ置き換える。

```sh
npm run typecheck
npm run build:web -- --base /
npm run test:web -- --project chromium
npm run preview:web -- --base / --port 4173
# 上のserverを停止してから別runを開始
npm run build:web -- --base /poc/
npm run preview:web -- --base /poc/ --port 4173
```

**確認:** C-04/W-01/W-02の対象browser分、crossOriginIsolated=false。**失敗時:** base→404/MIME→CSP→glue/wasm一致を確認。**終了:** 開発サーバ固有の挙動に頼らず実C++を呼べる。残る3つのWeb行はM4。

<a id="m3-01"></a>
## M3-01 — 入力・応答・確保失敗の検査

**依存:** M2-04。**編集先:** TS/Rust/Workerの検証関数と試験。公開型・元fixtureは変更しない。

1. [12の入力ケース](../12-test-case-catalog.md)を両Backend受付、Rust command検証、Workerへ適用する。JSONで表せない値をRustへ無理に送らない。
2. 呼び出し直後の入力変更、結果配列の変更、複数不備の優先順位を検査する。callerの配列と結果の共有があれば修正する。
3. RustのJSON出力はRuntimeInfo/TransformResult/AppErrorの規定fieldと型であることを試す。TSでも型assertだけでなく実値を検査する。
4. Cを直接呼ぶ試験ではheaderのstatusを照合する。一方、検証済み引数でCがエラーを返した場合はwrapperのCORE_FAILUREとして失敗終了する。
5. Workerのtest用allocatorで1/2/3回目の_mallocを0にし、既に確保したpointerが1回だけ解放されることを確かめる。count=0はchecksumの1回だけを試す。
6. 実WASMのtest用instanceで最大64MiB内の確保を行いmemory growthを発生させ、古いheap viewを保持しないことを確認する。通常の4096要素計算も別に成功させる。
7. test用freeも失敗させ、CORE_FAILUREでWorkerを終了することを確認する。回収不能な状態をOUT_OF_MEMORYとして継続させない。

**確認:** A-01〜A-04とC-03。**失敗時:** 検査/コピー/status変換/freeの該当部分だけを直す。**終了:** codeと継続可能/failedの扱いが一致し、試験のために本番APIを増やしていない。

<a id="m3-02"></a>
## M3-02 — 通信競合と監視期限の検査

**依存:** M3-01。**編集先:** `request-state.ts`、両Backend、`tests/api/*backend*.test.ts`、Workerの試験。

1. 返信を保留するtest transportを用意し、getInfoとtransform合計8件を受理した状態で9件目BUSYを確認する。
2. 8件を逆順で返し、各Promiseが自分の結果だけを受け取ることを確かめる。成功後pending/timer数は0にする。
3. fake clockで4999ms/5000ms、14999ms/15000msを試し、期限到達時に全pendingが1回だけTIMEOUTで終了することを確認する。
4. Worker error、messageerror、postMessageの同期throw、invoke rejection、壊れた返信を別ケースで注入する。全pending終了と後続操作の同じ失敗を確認する。
5. 完了済みid、未発行id、method不一致、protocol不一致、id上限を [12](../12-test-case-catalog.md) の期待に合わせる。壊れた要求と壊れた返信を別ケースで試す。
6. 実Workerを応答前に停止する試験も行う。terminate後のerrorイベントを前提にせず、通知が来ない場合はTIMEOUTで検知する。disposeによる停止はDISPOSEDで即時終了する。[Worker terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)

**確認:** L-01/L-02、unhandled rejectionなし。**失敗時:** pending登録が送信より後になっていないか、delete/clearTimeout/rejectの一度だけ実行を確認。**終了:** 壊れた通信先へ要求を続けない。テスト内のclock設定は製品の5秒/15秒を変更しない。

<a id="m3-03"></a>
## M3-03 — 破棄・再生成とUI状態

**依存:** M3-02。**編集先:** UIの世代管理、dispose、self-test、寿命試験。

1. ready、要求中、failedの各状態でdisposeを2回呼ぶ。getInfo/transformの後続DISPOSEDを確認する。
2. factory待ちの間にUI世代が変わるケースを作り、古いfactory成功時は旧instanceをdisposeし、新UIへ渡さない。
3. 初期化中は計算を受け付けず、初期化失敗後は再初期化できるようにする。self-test中の破棄では残りのself-test要求を発行しない。
4. macOS/Chromium/実Safariで20回の破棄・再生成を行う。test内部で生成/終了Worker数、pending、timer、listenerを数える。
5. 同一instanceで小入力1000回を順次実行する。結果全件一致、未解放割当数/byte数が増加しないことを確認する。

**確認:** L-03/L-04。**失敗時:** UI世代、古いlistener、reject後のfinally、self-test loopの停止条件を確認。**終了:** 最後のdispose後はWorker/pending/timerが0、旧結果によるUI更新なし。RSSだけで合否を決めない。

<a id="m3-04"></a>
## M3-04 — 権限・CSP・生成物分離

**依存:** M3-03。**編集先:** Tauri権限/CSP、test専用設定、生成物チェック、Web試験。

1. macOSのtest専用非許可windowから2commandをinvokeし、main成功/非許可window拒否を記録する。Tauri自身の拒否とアプリの入力拒否を区別する。
2. test専用windowを持たない通常buildを作り、capability/remote設定とCSPを再確認する。不要なdefault/opener等がないことを確認する。
3. Webのtest配信でmjs欠落、wasm欠落、ABI不一致を作り、Chromium/実Safariでエラー表示する。異常用ファイルは通常distに戻さず、別出力として扱う。
4. 実HTTP応答のHTML/Worker/mjs/wasmのCSP/MIMEと404を保存する。CSPを外すことで試験を通さない。
5. native出力にWASM/mjs/Worker chunkがないこと、Webの実行import graphにTauri APIがないこと、両方にtest入口がないことを確認する。

**確認:** S-01/S-02/W-03のmacOS・Web分。**失敗時:** AppManifest登録/使用capability、base/publicDir/alias、応答headerを確認。**終了:** M4へ渡す通常buildの設定と、故障注入用の設定が明確に分かれる。
