# free-models

OMPのモデル選択画面に見えている無料モデル候補をProviderの**現在の情報**と照合し、Provider側の根拠で現在無料と確認できたモデルだけを選べる拡張です。

対象Provider:

- Nous Portal（`nous-portal`）
- OpenRouter（`openrouter`）
- OpenCode Zen（`opencode-zen`）

## 目的

OMPのモデル一覧にはProviderからの動的取得やキャッシュがありますが、期間限定無料SKUの終了時刻と一覧更新のタイミングは一致しない場合があります。このプラグインはOMPのモデル一覧自体を書き換えず、`/free-model` 実行時点のProvider情報と照合します。

- 通常実行: OMP側の候補と現在のProvider情報の両方で確認できた無料モデルだけを選択画面へ表示
- `status`: `STALE` / `NOT-FREE` / `LIVE-ONLY` などの差分をUIだけで診断
- 実推論による確認要求は送信しない
- プラグイン独自のモデルDBや過去状態キャッシュは持たない

## インストール

```bash
omp plugin marketplace update omp-extensions
omp plugin install free-models@omp-extensions
```

拡張モジュールの追加後はOMPを再起動してください。

### 0.2.x以前からの移行

旧プラグイン名 `free-model-availability` は廃止済みです。旧版を導入済みの場合は、同じコマンドを二重登録しないよう先に削除してください。

```bash
omp plugin uninstall free-model-availability@omp-extensions
omp plugin marketplace update omp-extensions
omp plugin install free-models@omp-extensions
```

## 使い方

### 現在無料と確認できたモデルを選ぶ

```text
/free-model
```

`/free-model` は実行ごとに全対応Providerの現在情報を取得し、無料と確認できたモデルだけを表示します。選択後はOMP公開APIの `pi.setModel()` 経路で現在のセッションモデルを切り替えます。

- `STALE` / `NOT-FREE` / `UNKNOWN` / `LIVE-ONLY` は通常の選択画面へ出さない。
- 情報取得に失敗したProviderからはモデルを選ばない。
- 現在のモデルが候補に含まれる場合は初期選択位置にする。
- Provider側の根拠だけでは、アカウント固有の利用枠、権利、地域制限までは保証しない。

### 状態診断

```text
/free-model status
```

`/free-model status` は全対応Providerを対象に、`OK` / `STALE` / `NOT-FREE` / `UNKNOWN` / `LIVE-ONLY` をモデル名込みで全件表示します。

診断結果は `ctx.ui.notify` でUIにだけ表示します。セッションへ独自メッセージを保存しないため、後続ターンのモデルコンテキストへ診断結果を混ぜません。

## 判定

| 状態 | 意味 |
| --- | --- |
| `OK` | 現在のProvider一覧に存在し、無料である根拠も確認できた |
| `STALE` | OMP側では無料候補だが、現在のProvider一覧から消えている |
| `NOT-FREE` | 無料候補として残っているが、Provider側の現在無料という根拠と一致しない |
| `UNKNOWN` | Providerの現在情報を取得できず、状態を断定できない |
| `LIVE-ONLY` | Provider側では現在無料だが、OMPセッションのモデル一覧には見えていない |

## Providerごとの正本

### Nous Portal

- モデル一覧: `https://inference-api.nousresearch.com/v1/models`
- 無料価格: `pricing.prompt` / `pricing.completion` が明示的に両方0
- 現在無料の補助情報: `https://portal.nousresearch.com/api/nous/recommended-models` の `freeRecommendedModels`

Nous ResearchのHermes Agent現行版も `freeRecommendedModels` を現在無料の情報として利用しています。モデル一覧と推奨情報は並列取得し、推奨情報だけ失敗した場合は価格0による判定を継続します。

OMP Provider ID `nous-portal` とNous APIの生のモデルIDは別物です。たとえば選択子 `nous-portal/stepfun/step-3.7-flash:free` の生IDは `stepfun/step-3.7-flash:free` です。

### OpenRouter

- 情報源: `https://openrouter.ai/api/v1/models`
- `pricing.prompt` / `pricing.completion` が明示的に両方0なら無料の根拠とする

OpenRouterは `:free` 付きの種類を公式に定義していますが、`openrouter/free` のように接尾辞を持たない無料ルーターもあるため、現在の価格0を正本にします。`:free` の印はOMP側に残った候補の `STALE` / `NOT-FREE` 診断にだけ使います。

### OpenCode Zen

- 情報源: `https://opencode.ai/zen/v1/models`
- このエンドポイントは価格や無料フラグを返さないため、Providerが定義する `-free` SKU表記だけを機械判定可能な無料根拠として扱う

公式料金文書では `big-pickle` のように接尾辞なしでも無料と案内されるモデルがあります。ただし `/v1/models` からその状態を機械的に確認できないため、このプラグインはモデルIDの固定一覧やHTML解析を追加しません。その種のモデルは自動選択対象外とし、独自の正本を持たない方を優先します。

## 失敗時の方針

- `/free-model` をユーザーが明示実行した時だけProviderへアクセスする。
- 各要求は5秒タイムアウト、8MiB応答上限。
- Provider間は並列取得し、Nousの2情報源も並列取得する。
- 429 / 5xx / タイムアウト / 解析失敗を `STALE` 判定へ使わず、そのProviderを `UNKNOWN` 側へ倒す。
- プラグイン独自キャッシュや最終正常値は保持しない。過去状態を「現在無料」の判定へ再利用しないため。
- `/chat/completions` などの実推論確認は実行しない。課金、レート制限、副作用を避けるため。
- OMPの `cost === 0` だけでは無料と判定しない。モデル一覧のメタデータは現在価格の契約ではなく、価格欠落時の代替値0もあり得るため。

## OMP標準 `/model` への自動反映

古い無料モデルをOMP本体の `/model` 一覧から自動除外する機能は実装していません。OMP現行版には、認証情報に依存せず一覧全体へ適用できる拡張用フィルターフックがありません。

必要な拡張点は `can1357/oh-my-pi#10051` で提案済みです。フックが導入された場合は、組み込みProviderの再登録や非公開状態の変更をせず、公開APIで実現できるか再評価します。

## 開発

```bash
bun run check
```

単体テストではProviderのHTTP応答を模擬し、外部ネットワークへ接続しません。
