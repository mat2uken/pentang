# 04. API・C ABI・通信仕様

## 正本の配置と変更方法

元定義は [reference/poc-v1](reference/poc-v1/README.md) に原文のまま保存する。v1.1/v1.2は型の追加ではなく、未記載だった挙動の具体化を行う。公開API/C ABI/Worker protocolは版1を維持する。

| 元定義 | 実装開始時の配置先・以後の編集先 |
|---|---|
| `contracts/application-api.ts` | `src/api/application-api.ts` |
| `contracts/poc_core.h` | `cpp/include/poc_core.h` |
| `contracts/worker-protocol.ts` | `src/backends/browser/worker-protocol.ts` |
| `fixtures/golden-vectors.json` | `tests/fixtures/golden-vectors.json` |

配置時にhash一致を確認する。Worker型の相対importだけを配置先のAPIへ変更し、その差分を記録する。以後、実行用の型/header/fixtureを単一の編集先とし、参照版は変更しない。型・数値・意味を変える場合は本文、実装、試験、decision logを一緒に更新し、API/ABI/protocol版の更新要否を判断する。

## 公開APIと数値

完全な型は [application-api.ts](reference/poc-v1/contracts/application-api.ts) を参照する。

```ts
interface ApplicationApi {
  getInfo(): Promise<RuntimeInfo>;
  transform(request: TransformRequest): Promise<TransformResult>;
  dispose(): Promise<void>;
}
```

`APPLICATION_API_VERSION=1`、`CORE_ABI_VERSION=1`、`MAX_VALUES=4096`。factoryはABI確認済みのインスタンスだけを返す。`getInfo` は実C関数のABIと版文字列を取得し、`apiVersion / backend / hostOs / execution / core` を返す。初期core版は `0.1.0`、互換性判定はABIで行う。

- 入力は `values: readonly number[]`、`multiplier`、`offset`。全数値をsigned int32に制限する。
- C++で `int64(v) * int64(multiplier) + int64(offset)` を求め、int32へclampする。この入力範囲の積と和はint64内に収まる。
- checksumは出力をuint32として加算したmod 2^32。結果の配列とchecksumは完全一致で比較する。
- emptyは成功し、出力empty、checksum=0。入力は不変。返す配列は入力、他要求、WASM heapから独立する。
- wireは通常の `number[]`。Int32Arrayへの暗黙変換、転送後の切り詰め、JS/Rustによる計算の代替は禁止する。

## 入力検証の順序

UIでの説明に加え、両Backendの受付、Rust command、Workerが同じ入力規則を検査する。TS型の付いた値も実行時に検査する。

1. インスタンスがdisposedならDISPOSED、failedなら保存した失敗を返す。通信しない。
2. requestはnullでないobjectかつarrayではない。自身の必須field `values / multiplier / offset` を持ち、未知fieldはINVALID_ARGUMENTとする。
3. valuesは通常のArray。長さ4096超はLIMIT_EXCEEDED。型が違えばINVALID_ARGUMENT。
4. valuesの全indexが自身の要素として存在し、要素・multiplier・offsetがnumber、finite、整数、int32範囲であることを検査する。疎配列を `every` の飛ばし処理で通さない。
5. `-0` は0として受理する。JSONの `1.0` も整数値として受理する。RustでJSON数値の内部表現だけを理由にこれらを拒否しない。
6. 検査済み入力を最初のawaitより前にコピーし、呼び出し後のcallerの変更から切り離す。
7. 未完了8件なら新しい要求をBUSYで拒否し、送信・キュー追加しない。受理した要求だけにidとtimerを割り当てる。

NaN / Infinity / undefined / bigint / string / null / 欠落要素はJSON化やHEAPコピーより前に拒否する。複数の不備がある場合もこの順序に従う。通常のvalidation失敗でインスタンスをfailedへ移さない。

Rust commandは `request: serde_json::Value` 等で受けて明示的に検査する。TauriBackendからは常に正しい外側のIPC引数形を送る。command名の誤り、外側の引数欠落、権限拒否等のTauri自身の失敗は入力データのINVALID_ARGUMENTと混同せずTRANSPORT_ERRORへ整形する。

## native IPCの形

| 呼び出し | 引数 | 成功値 |
|---|---|---|
| `invoke('poc_get_info')` | なし | 完全なRuntimeInfo |
| `invoke('poc_transform', { request: snapshot })` | requestを1段包む | TransformResult |

RustのRuntimeInfoは `apiVersion`、`backend`、`hostOs`、`execution`、`core`。coreは `abiVersion` と `version`、TransformResultは `values` と `checksum`。serdeでcamelCaseへ揃え、snake_caseのfieldをwireへ出さない。

nativeのbackend/executionは `tauri-native / native-ffi`、hostOsはコンパイル対象から `macos / windows / ios / android` へ写す。未対応OSを別OS名へ偽装せず初期化失敗にする。WebはWorkerからCoreInfoを受け、BrowserBackendが `browser / wasm-worker / dedicated-worker` を付ける。

Rust commandは `Result<成功DTO, AppError>` を返す。TauriBackendは拒否値が既知codeとstring messageを持つ場合だけAppErrorとしてコピーし、それ以外のstring/Error/未知codeをTRANSPORT_ERRORへ変換する。入力エラーmessageの文言一致は受入条件にしない。

## エラーの対応

公開する失敗はPromise rejectionの `{ code, message }`。メッセージは表示用で、試験判定はcodeを使う。IPCでErrorオブジェクトやスタック全体を返さない。

| 原因 | AppError code | 要求終了後の状態 |
|---|---|---|
| 入力の型・値・field不備 | INVALID_ARGUMENT | ready維持 |
| 4096超 | LIMIT_EXCEEDED | ready維持 |
| 9件目の要求 | BUSY | ready維持 |
| factory / module取得失敗 | INITIALIZATION_FAILED | failed、初期化を終了 |
| ABIが1以外 | ABI_MISMATCH | failed |
| 明示的に捕捉できる確保失敗 | OUT_OF_MEMORY | 当該要求失敗、ready維持 |
| Cの予期しないstatus、内部capacity不足、WASM trap | CORE_FAILURE | failed |
| Workerの未捕捉error | WORKER_FAILED | failed |
| 壊れた返信、messageerror、IPC送受信失敗 | TRANSPORT_ERROR | failed |
| init 15秒 / 通常要求5秒の監視期限 | TIMEOUT | failed |
| dispose後・dispose時の未完了要求 | DISPOSED | disposed |

C単体試験ではheaderのstatus値をそのまま検査する。製品のRust/Worker wrapperは入力と有効領域を先に検査するため、その後にCが非0を返す場合は引数エラーを含めCORE_FAILUREとし、failedへ移す。callerの入力不正はCを呼ぶ前にINVALID_ARGUMENT/LIMIT_EXCEEDEDとして返す。この区別により、wrapper不具合を通常の入力ミスとして継続させない。OOM試験は捕捉可能な失敗を注入し、OSによるプロセス強制終了までAppError化できるとは主張しない。

応答にも実行時検査を行う。結果配列の長さ・全要素のint32、checksumのuint32、版情報の型とbackend/host/executionの組み合わせを確認する。fieldの欠落・余分field・不正な型はTRANSPORT_ERROR、形が正しくABIだけ違う場合はABI_MISMATCHとする。公開APIの実装でchecksumを再計算しない。配列全体の計算一致はfixture試験が担当する。

ready維持の規則は通常要求に適用する。creating中はOOM等もfactoryの失敗として終了し、timer/listener/Workerを片付ける。初期化に失敗したインスタンスを公開APIとして返さない。

## 寿命と通信状態

```text
creating → ready → disposed
    |         |
    └→ failed ←┘
         |
         └→ disposed
```

- creatingではUI操作を止める。初期化はインスタンスごとに1回だけ。Webはfactoryをawaitして実ABIを確認してからready。
- 1インスタンスあたり `getInfo + transform` の未完了要求を合計8件までとする。初期化中の1件は別枠で、公開APIはまだ返さない。
- 監視は送信から計測し、キュー待ちも含む。性能の閾値ではなく停止検知用で、フォアグラウンドで検証する。
- TIMEOUTや通信の致命的失敗では全pendingを同じ原因codeで1回だけrejectし、timerを解除する。Webはlistener解除とWorker終了まで行う。以後の操作は保存した失敗を返す。
- disposeは常に冪等で、既にfailedでも成功する。未完了PromiseをDISPOSEDで終了し、後続のgetInfo/transformもDISPOSED。nativeの同期FFIや既に送ったinvokeを強制中断・unloadする約束はしない。
- 再初期化は新インスタンスを作る操作。自動再送はない。UIは世代番号を持ち、古いfactory完了・返信・エラーで新UIを更新しない。古いfactoryが後で成功した場合もそのインスタンスをdisposeする。
- UIが保持する有効Backendは1個。再生成では旧Backendのdispose完了を待つ。生成待ちの連打を抑止する。

## Worker内部のメッセージ

完全な型は [worker-protocol.ts](reference/poc-v1/contracts/worker-protocol.ts)。`protocolVersion=1`、安全な正整数id、method、ok/dataまたはerrorで対応付ける。

| 項目 | 規則 |
|---|---|
| id | インスタンス内で単調増加、再利用なし。次idが安全整数上限を超えるなら送信せずTRANSPORT_ERRORで失敗終了 |
| init | 最初に1回。moduleUrl / wasmUrlは実装が組み立て、両側で同一originの固定配下を検査 |
| init競合 | 初期化Promiseを1個に固定。重複initやready前の通常要求はINITIALIZATION_FAILEDで拒否 |
| 通常処理 | Worker内で直列。getInfoも実C関数を読む |
| 返信検査 | version、id、method、okとpayloadを検査。pendingのmethod不一致はTRANSPORT_ERROR |
| 遅い・重複した返信 | 発行済みでpendingにないidは破棄。未発行id・不正idはTRANSPORT_ERROR |
| 失敗 | Worker側で返信できる例外は整形。送信自体が壊れた場合もerror/messageerrorか監視期限で全pendingを終了 |

通常要求の致命的失敗はC/transport/Worker/ABI/timeoutの規定codeで全pendingを終了する。Workerを外からterminateしたときにerrorが来るとは仮定せず、無通知なら監視期限で検知する。disposeはtimerを待たず自分でDISPOSED終了してからWorkerを停止する。

Workerに届いた要求のprotocol/id/method自体が壊れている場合は、対応付け不能な返信を捏造せず、Workerをfailed状態にしてerrorで通知する。BrowserBackendはWORKER_FAILEDとして終了する。正しいメッセージ形の内側にあるpayload不備はINVALID_ARGUMENT/LIMIT_EXCEEDED、重複init等はINITIALIZATION_FAILEDの返信にする。壊れた**返信**をBrowserBackendが受けた場合のTRANSPORT_ERRORと区別する。

## C ABIとメモリ

正確な宣言・status値は [poc_core.h](reference/poc-v1/contracts/poc_core.h) を使う。公開C関数は3個のみ。Rust 2024 editionを採る場合の `unsafe extern "C"` 等は選んだeditionに合わせる。

検査順は `count上限 → checksum NULL → output_capacity不足 → count>0でinput/output NULL`。全検査が終わる前に出力・checksumを書かない。エラー時は両方不変。count=0ではinput/outputにNULLを渡せるがchecksumは有効な1要素が必要。

callerは実際に有効な整列領域を用意し、input/output/checksumを重ねない。Cはpointerを保持しない。静的UTF-8版文字列は解放せず、Rust/JS所有文字列へコピーする。無効pointer・過大なcapacityを偽る試験で未定義動作を起こさない。

Workerは次の順序を守る。

1. count>0なら入力と出力各 `count * 4` byte、常にchecksum 4 byteを確保する。count=0では入力/出力確保を省く。
2. 各_mallocの0返却を検査し、途中失敗でも確保済み領域をfinallyで解放する。
3. 全確保後に `Module.HEAP32 / HEAPU32` を取得し、入力をコピーして実C関数を呼ぶ。
4. 戻り値を検査し、必要ならviewを再取得して出力を通常配列へコピーする。WASM上のsubarrayを外へ返さない。
5. 成功・失敗のいずれも全確保領域を1回ずつ_freeする。

runtime自体が壊れて_freeも失敗する場合はCORE_FAILUREを保ってWorkerを終了し、moduleごと回収する。通常のOOMでは成功済み確保分を解放できた場合にだけreadyを維持する。terminate後にWorker内のfinallyが実行されることは前提にしない。

memory growthでtyped array viewが更新される点は [Emscripten公式](https://emscripten.org/docs/tools_reference/settings_reference.html#allow-memory-growth) に従う。

## 共通期待値と追加ケース

元fixtureはvalid 10件、invalid 6件、generated 2件、nonJson指示4件。レビューではvalid 10件と4096件生成ケースの期待値を独立した整数計算で照合済み。実C++/WASM成功の証拠ではない。

Rust FFI / Worker-WASM / UI self-testは同じ成功fixtureを使う。不正入力は該当するAPI層で試し、C単体試験はNULL・capacity等を別に扱う。v1.1で追加する試験は別テストデータに置き、元fixtureを静かに書き換えない。offsetの小数・範囲外、疎配列、余分field、`-0 / 1.0`、呼出し後の入力変更、複数不備の優先順位、入力の型不備を含める。

個々の入力と期待code、通信の順序、タイマーの時刻は [12-test-case-catalog.md](12-test-case-catalog.md) に定義する。成功計算11件と、Cを呼ばずに拒否した件数はself-test結果で分ける。
