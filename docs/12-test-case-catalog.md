# 12. 試験ケースの具体値と期待結果

この一覧は実装する試験の仕様であり、実行結果ではない。元fixtureは変更せず、追加ケースを `tests/api`、Rustのテスト、C++テストへ置く。全体の受入IDは [06](06-verification.md) の22個を維持する。

## 共通の入力試験

基準requestは `{ values: [1,2,3], multiplier: 2, offset: 1 }`。指定したfieldだけを置換する。通常の不正入力では通信せず、stateはreadyを維持する。JSONで表せるケースはTS受付・Rust command検証・Worker検証で同じ期待にする。

| ケース | 入力・変更 | 期待 | 受入ID |
|---|---|---|---|
| input-01 | 元valid10件＋maximum-length | fixtureどおりの11成功。入力不変、配列全要素/checksum一致 | C-01 |
| input-02 | 元invalid6件＋too-long | fixtureのexpectedError | A-01 |
| input-03 | offset=0.5 | INVALID_ARGUMENT | A-01 |
| input-04 | offset=2147483648 / -2147483649 | どちらもINVALID_ARGUMENT | A-01 |
| input-05 | values=null / object / string | すべてINVALID_ARGUMENT | A-01 |
| input-06 | multiplier=true / "2" / null | すべてINVALID_ARGUMENT | A-01 |
| input-07 | requestにextra=1を追加 | INVALID_ARGUMENT | A-01 |
| input-08 | offset欠落、かつvalues長4097 | 必須field検査が先。INVALID_ARGUMENT | A-01 |
| input-09 | values長4097、multiplier=0.5 | 長さ検査が先。LIMIT_EXCEEDED | A-01 |
| input-10 | values=[-0,1.0]、multiplier=1.0、offset=-0 | values=[0,1]、checksum=1 | A-01 |
| input-11 | valuesの要素/multiplier/offsetにNaN、±Infinity、undefined | 各位置でINVALID_ARGUMENT、IPC前拒否 | A-01 |
| input-12 | values=new Array(1)、または一部index欠落 | INVALID_ARGUMENT、疎配列を通さない | A-01 |
| input-13 | values要素にbigint / boolean / string / null | 各々INVALID_ARGUMENT | A-01 |
| input-14 | 必須fieldがprototype上にだけ存在 | INVALID_ARGUMENT、自身のfieldを要求 | A-01 |
| input-15 | 8要求保留中に正しい9件目 | BUSY、送信なし、既存8件は維持 | L-01 |
| input-16 | 8要求保留中に不正9件目 | INVALID_ARGUMENTまたはLIMIT_EXCEEDED。検査がBUSYより先 | A-01/L-01 |
| input-17 | dispose済みで不正入力を送る | DISPOSED。入力検査より状態検査が先 | A-01/L-03 |
| input-18 | 呼出し直後に元values/multiplierを変更 | 元の基準requestの結果[3,5,7]/15 | A-03 |
| input-19 | 結果配列を変更して次の要求を実行 | 次の結果・別の結果・入力に影響しない | C-03/A-03 |

input-11〜input-14等のJS固有表現はTSで生成する。Rustでは対応するnull/型不正/field欠落を直接検査し、JSON化できない値を送ったと偽って記録しない。input-10のRust側はraw JSON文字列に1.0/-0を含めて確認する。

## Cの検査順と書き込み

有効なpointerには実際の長さが足りる整列済み配列を用意する。出力とchecksumに既知値を入れてからエラーを試す。

| ケース | C引数の条件 | 期待 |
|---|---|---|
| core-01 | count=0、input/output=NULL、cap=0、checksum有効 | POC_OK、checksum=0 |
| core-02 | count=1、input=NULL、output/cap/checksum有効 | POC_ERR_INVALID_ARGUMENT |
| core-03 | count=1、output=NULL、input/cap/checksum有効 | POC_ERR_INVALID_ARGUMENT |
| core-04 | count=1、checksum=NULL、ほか有効 | POC_ERR_INVALID_ARGUMENT |
| core-05 | count=1、cap=0、ほか有効 | POC_ERR_BUFFER_TOO_SMALL |
| core-06 | count=4097、3pointerともNULL、cap=0 | POC_ERR_LIMIT_EXCEEDED。pointerを読む前に終了 |
| core-07 | count=1、checksum=NULL、cap=0 | POC_ERR_INVALID_ARGUMENT。capacityより先 |
| core-08 | count=1、input/output=NULL、cap=0、checksum有効 | POC_ERR_BUFFER_TOO_SMALL。input/output NULLより先 |
| core-09 | count=0、checksum=NULL | POC_ERR_INVALID_ARGUMENT |
| core-10 | 成功/失敗の入出力の前後にsentinel | 指定領域外は不変。失敗時は出力と既存checksumも不変 |

core-01〜core-09はC-02、core-10はC-03に対応する。無効pointerや実際より大きいallocationを偽る試験を作らない。

## 応答・通信・寿命

| ケース | 発生させる状況 | 期待code・state・後処理 | 受入ID |
|---|---|---|---|
| life-01 | getInfo/transform合計8件を逆順で返す | すべて対応するPromiseへ。終了後pending/timer=0 | L-01 |
| life-02 | 通常要求を4999msまで保留、5000msへ進める | 期限前未完了、期限で全pending TIMEOUT、failed | L-02 |
| life-03 | initを14999msまで保留、15000msへ進める | factory TIMEOUT、Worker/listener/timerを回収 | L-02 |
| life-04 | Worker error | WORKER_FAILED、全pending終了、failed | L-02 |
| life-05 | messageerror / postMessageの同期throw | TRANSPORT_ERROR、全pending終了、failed | L-02 |
| life-06 | Tauri invokeが未知のstring/Errorでreject | TRANSPORT_ERROR、全pending終了、failed | L-02 |
| life-07 | 正規のAppError INVALID_ARGUMENTを返信 | 当該要求だけreject、ready維持 | A-03 |
| life-08 | output長不一致、int32外、checksumが負/小数/uint32外 | TRANSPORT_ERROR、failed。C++計算の再実装で修復しない | A-03 |
| life-09 | RuntimeInfoのfield型不正、host/backend/executionの組み合わせ不正 | TRANSPORT_ERROR、failed | A-03 |
| life-10 | 形が正しいCoreInfoのABIが1以外 | ABI_MISMATCH、failed | W-03 |
| life-11 | Worker返信のprotocol不一致、不正id、未発行id、pendingとmethod不一致 | TRANSPORT_ERROR、全pending終了 | L-02 |
| life-12 | 既に完了した発行済みidを重複返信 | 破棄し、新しい要求やUIを変更しない | L-02 |
| life-13 | 次idが安全整数の上限を超える | 送信せずTRANSPORT_ERROR、failed | L-02 |
| life-14 | pending中にdisposeを2回 | disposeは両方成功、pendingはDISPOSEDで1回だけ終了 | L-03 |
| life-15 | dispose後のgetInfo/transform | DISPOSED、通信なし | L-03 |
| life-16 | failed後に操作、次にdispose | 操作は保存した失敗、disposeは成功しdisposedへ | L-03 |
| life-17 | 旧factoryが新UI世代の後に成功 | 旧instanceをdispose、新UIを上書きしない | L-03 |
| life-18 | 実Workerを応答前に停止、終了通知なし | TIMEOUTで検知。disposeによる停止はDISPOSED | L-02 |
| life-19 | 初期化済みWorkerへ重複init/ready前の通常要求 | INITIALIZATION_FAILED。初期化を重ねて開始しない | A-02 |
| life-20 | 正常な検査済み引数なのにCが非0を返す | CORE_FAILURE、failed。C単体のstatus試験とは別 | A-04 |
| life-21 | Workerへ送る要求自体のprotocol/id/methodが不正 | Workerがfailedとなりerror通知、BrowserBackendはWORKER_FAILED | A-02/L-02 |

タイマー単体試験はfake clockを使い、同時刻の成功と期限イベントは処理された順で一度だけsettleする。実Worker試験は本来の15秒/5秒を使い、browserの背景tabでの時刻精度を要件にしない。

## 割当・回収と配信

| ケース | 手順 | 期待 | 受入ID |
|---|---|---|---|
| memory-01 | count>0で1/2/3回目のmallocだけ0返却 | OUT_OF_MEMORY、先行成功分を各1回free、C呼出しなし | A-04 |
| memory-02 | count=0 | 入出力mallocなし、checksum確保/解放1回、Cを実行しempty/0 | C-03 |
| memory-03 | 最大64MiB内で実WASM memoryを成長させる | 再取得したHEAPで入出力を扱い、旧viewを公開しない | C-03 |
| memory-04 | dispose/recreate20回、最後にdispose | Worker/pending/timer=0、listener未回収なし | L-03 |
| memory-05 | 同じinstanceで小入力1000回 | 全結果一致、未解放pointer/byteが増加しない | L-04 |
| memory-06 | test用freeを失敗させる | CORE_FAILURE、Workerを終了しmoduleごと回収。readyを維持しない | A-04 |
| serve-01 | 正常root/subpath build | 指定baseの同一originファイルだけを取得し計算成功 | W-02 |
| serve-02 | mjs/wasmを別runで欠落させる | 404、HTMLの200代替なし、INITIALIZATION_FAILED表示 | W-03 |
| serve-03 | HTML/Worker/mjs/wasmの応答を取得 | 規定CSP/MIME/no-store、crossOriginIsolated=falseで動作 | W-02/S-02 |
| serve-04 | test用ABI違いの同一組glue/wasm | ABI_MISMATCH。古いwasmやJS計算へ変更しない | W-03 |

故障注入はprivateなtest helper、test専用Worker、別のtest配信出力で行う。公開3メソッドや通常bundleへ故障注入の操作を追加しない。実FFI/実Workerの正常試験と制御した通信単体試験の結果は別に記録する。
