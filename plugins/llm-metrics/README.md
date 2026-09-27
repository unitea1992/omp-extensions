# llm-metrics

OMPのメインUIステータスへ、vLLM / SGLangサーバーが公開する `/metrics` の現在値を表示します。

```text
vLLM  │ Queue 2 │ Gen 500.0 t/s │ Draft 40% │ KV 12%
SGLang │ Queue 1 │ Gen 86.5 t/s │ Draft 62% │ KV 28%
```

メインターンと、OMP共通EventBusで観測できるTaskサブエージェントのモデルを対象にします。利用中の対象がある間だけ定期取得し、最後の対象が外れた時点でタイマーと表示を消します。サブエージェントやヘッドレスセッション自身では取得しません。

## 対応バックエンド

`/metrics` の名前空間から対応可否を判定します。

| バックエンド | 対応する現在の指標 |
| --- | --- |
| vLLM | `vllm:*` |
| SGLang | `sglang:*` |

OMP本体には推論サーバーの待機数、スループット、Speculative Decoding受理率、KV使用率をステータスへ表示する機能がないため、このプラグインの責務は残します。OMPのステータス行そのものやOpenTelemetryは再実装しません。

## 表示する指標

### vLLM

| 表示 | 情報源 |
| --- | --- |
| `Queue N` | `vllm:num_requests_waiting` |
| `Gen X.X t/s` | `vllm:generation_tokens_total` のカウンター差分 |
| `Draft N%` | `vllm:spec_decode_num_accepted_tokens_total` / `vllm:spec_decode_num_draft_tokens_total` の差分比 |
| `KV N%` | `vllm:kv_cache_usage_perc` |

現在のvLLM指標だけを対象にします。廃止済みの `gpu_cache_usage_perc`、`generation_tokens`、Speculative Decodingカウンターの `_total` なし名称へは戻しません。vLLM自身の指標廃止方針に従い、古い名称をプラグイン内で恒久互換化しない方針です。

### SGLang

| 表示 | 情報源 |
| --- | --- |
| `Queue N` | `sglang:num_queue_reqs` |
| `Gen X.X t/s` | `sglang:gen_throughput` |
| `Gen X.X t/s` の代替 | `sglang:generation_tokens_total` のカウンター差分 |
| `Draft N%` | `sglang:spec_accept_rate` |
| `KV N%` | `sglang:token_usage` |

SGLangのEAGLE / MTP / DFLASHなどを方式名で分岐しません。現在のスケジューラが公開する共通 `spec_accept_rate` を使います。

TP / PP / EPランクが同じスケジューラ負荷を重複表現する場合はrank 0を代表値とし、独立したDPランクだけをQueue / Genへ合算します。優先度キュー有効時は `priority=""` の合計系列だけを使います。`spec_accept_rate` は複数DP系列を正しく重み付けする分母がないため、その場合は `Draft` を表示しません。

## 鮮度と失敗時の扱い

ステータスへ出すのは**直近の取得に成功した値だけ**です。

- HTTPエラー / タイムアウト / 通信失敗: 対象の表示値を即座に消し、次回取得で再試行
- 指標欠落: 0や過去値で補わず、その表示だけ消す
- 最後の利用対象が外れた時: 対象状態を破棄し、表示を消す
- サーバー再起動によるカウンター初期化: 新しい基準値から再計算
- 未対応の `/metrics` 応答: その対象への確認を停止

指標取得の失敗はLLM生成、ツール実行、権限・承認へ影響しません。

## 定期取得とライフサイクル

- 取得間隔: 1秒
- 取得タイムアウト: 2秒
- セッション全体でタイマーは1つ
- 対象ごとに同時要求を1本へ制限
- 同一サーバーをメインと複数サブエージェントが使う場合は同じ対象を共有
- 未使用時は取得0回
- `session_shutdown` でEventBus購読、タイマー、状態、表示をすべて破棄

1秒間隔はステータス表示の追従性を保つため維持します。常時取得ではなく利用中だけで、遅いエンドポイントは同時要求を1本へ制限するため要求が積み上がりません。

## エンドポイントの扱い

`baseUrl` が `/` または `/v1` で終わる単純なOpenAI互換URLの場合だけ、同一オリジンの `/metrics` を導出します。

確認対象:

- 標準の `vllm` / `sglang` Provider
- `http://` の自己ホスト型カスタムエンドポイント

HTTPSの非標準カスタムProviderへ推測で `/metrics` を要求しません。`/metrics` 要求へモデルAPIキー、OAuth認証情報、Authorizationヘッダーは送りません。

## 複数サーバーの集計

- Queue: 合計
- Gen: 合計
- KV: 最大値
- Draft: 利用中対象が1つの場合だけ表示
- vLLMとSGLangが混在する場合の接頭辞: `LLM`

## インストール

```bash
omp plugin marketplace update omp-extensions
omp plugin install llm-metrics@omp-extensions
```

## 開発

```bash
bun run check
```

単体テストでは指標解析、SGLangランク集計、古い値の消去、利用状態の後始末など公開挙動を検証します。
