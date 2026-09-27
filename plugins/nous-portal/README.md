# nous-portal

Nous PortalをOMPのProviderとして追加します。OMP本体のProvider / OAuth APIを利用するため、導入後は通常の `/login` Provider一覧から **Nous Portal** を選択できます。

TerrifiedBug/omp-nous-portal-provider（MIT）をOMP 18向けに取り込んだ実装です。

## インストール

マーケットプレイスを更新してから導入します。

```bash
omp plugin marketplace update omp-extensions
omp plugin install nous-portal@omp-extensions
```

導入後、次のコマンドで `nous-portal@omp-extensions` が表示されることを確認します。

```bash
omp plugin list
```

表示されない場合は、マーケットプレイスのキャッシュと実行時登録を作り直します。

```bash
omp plugin marketplace update omp-extensions
omp plugin install --force nous-portal@omp-extensions
omp plugin list
```

拡張モジュールの追加後はOMPを完全に終了し、新しいプロセスとして起動してください。

## ログイン

OMPで `/login` を実行して `Nous Portal` を選択します。Provider IDを指定する場合は次でも開始できます。

```text
/login nous-portal
```

Nous PortalのDevice OAuthページが開きます。承認後、OMPの認証情報ストアへ更新トークンが保存され、短命な推論用トークンは必要に応じて更新されます。

## Provider IDとモデルID

OMP内部のProvider IDは `nous-portal` です。これはOMP側の接続先名前空間であり、Nous APIが返すモデルIDの一部ではありません。

Nous `/v1/models` はOpenRouter互換のモデルID（例: `minimax/minimax-m2.7`）を返します。この場合、OMPの選択子は次の形です。

```text
nous-portal/minimax/minimax-m2.7
```

OMPは先頭の `nous-portal` で接続先Providerを決め、推論要求のモデルIDにはNousのモデル一覧から得た `minimax/minimax-m2.7` を使います。Nous側のモデルIDに `nous-portal` が含まれている必要はありません。

## APIキーを直接使う場合

Portalの推論キーを直接使う場合は、OMP起動前に `NOUS_API_KEY` を設定します。

```bash
export NOUS_API_KEY=sk-nous-...
omp --model nous-portal/<model-id>
```

## 動的モデル取得

モデル一覧はNous inference APIの公開 `/v1/models` を、OMPの `fetchDynamicModels` 経由で取得します。モデル一覧取得にはOAuthアクセストークンや `NOUS_API_KEY` を送信せず、固定モデル一覧も持ちません。これにより、Nous側で追加・削除されたモデルをOMP標準のモデルキャッシュ・更新経路で追随しつつ、モデル探索へ不要な認証情報を渡しません。

画像・推論能力は `/models` が返す `architecture` / `supported_parameters` などの現在のメタデータを正本にします。メタデータがないモデルをモデルIDやベンダー名から推測せず、保守的にテキスト専用・推論機能なしとして扱います。

このプラグインは**無料モデルだけを判定・選別する機能**や、OpenRouter / OpenCode Zenなど他Providerの古い無料モデルを除外する機能を持ちません。無料枠や可用性の同期は複数Providerに共通する別問題なので、Nous固有のProvider実装へ混ぜません。

また、OMPの `ProviderModelConfig.cost` は数値必須のため、Nousの `/models` 応答に価格情報がない項目は0で補います。この値だけを「現在無料」の判定には使いません。

## 設定

| 変数 | 用途 | 既定値 |
| --- | --- | --- |
| `NOUS_API_KEY` | 推論APIキーを直接利用 | 未設定 |
| `NOUS_PORTAL_BASE_URL` | Portal OAuth API | `https://portal.nousresearch.com` |
| `NOUS_INFERENCE_BASE_URL` | OpenAI互換推論API | `https://inference-api.nousresearch.com/v1` |
| `NOUS_CLIENT_ID` | OAuth device flow client ID | `hermes-cli` |
| `NOUS_MIN_TOKEN_TTL_SECONDS` | OAuth更新の余裕時間（秒） | `120` |

## 責務範囲

`nous-portal` の責務は次に限定します。

- OMP `/login` へのNous Portal OAuth統合
- OAuthトークン更新と `NOUS_API_KEY` への代替
- Nous `/v1/models` の動的取得とOMPモデルメタデータへの変換

次は対象外です。

- Portalのキャンペーン用free / recommended一覧によるモデル絞り込み
- 他Providerを含む無料モデルの生存確認
- 一時的な429 / 5xx / アカウント固有限制を理由にしたモデル非表示

## 開発

リポジトリ直下で実行します。

```bash
bun run check
```

単体テストは外部ネットワークへ接続せず、OAuthと `/models` の応答を模擬します。

## 出典

OAuth / モデル探索実装は [TerrifiedBug/omp-nous-portal-provider](https://github.com/TerrifiedBug/omp-nous-portal-provider)（MIT）を基にしています。Nous Portalの認証プロトコルはNous ResearchのHermes Agent実装と照合しています。
