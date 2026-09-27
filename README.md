# omp-extensions

oh-my-pi（OMP）の任意拡張をまとめるマーケットプレイスです。OMP本体や上流ツールで解決できる機能は重複実装せず、実運用で確認できた具体的な不足だけを小さなプラグインとして補います。

## プラグイン

| プラグイン | 概要 | 前提 |
| --- | --- | --- |
| [`nous-portal`](plugins/nous-portal/README.md) | Nous PortalをOMPの `/login` と動的モデル取得へ統合 | Nous Portalアカウント |
| [`free-models`](plugins/free-models/README.md) | Nous Portal / OpenRouter / OpenCode Zenの現在の提供元情報から、確認済み無料モデルの選択と状態診断を提供 | 対象ProviderをOMPで利用可能 |
| [`llm-metrics`](plugins/llm-metrics/README.md) | vLLM / SGLangの待機数、生成速度、Speculative Decoding受理率、KV使用率をステータス行へ表示 | 対応する自己ホスト推論サーバー |
| [`magic-router`](plugins/magic-router/README.md) | 通常の指示文からOMP本体のmagic keywordを決定論的に自動選択 | — |
| [`expert-review`](plugins/expert-review/README.md) | 現在までの会話コンテキストを設定済み高性能モデルへ1回だけ査読させ、元モデルへ戻して指摘を査定 | `modelRoles.advisor` |

各プラグインは独立して導入・更新できます。

## インストール

マーケットプレイスを追加します。

```bash
omp plugin marketplace add https://github.com/unitea1992/omp-extensions
```

必要なプラグインだけインストールしてください。

```bash
omp plugin install nous-portal@omp-extensions
omp plugin install free-models@omp-extensions
omp plugin install llm-metrics@omp-extensions
omp plugin install magic-router@omp-extensions
omp plugin install expert-review@omp-extensions
```

更新:

```bash
omp plugin marketplace update omp-extensions
omp plugin upgrade nous-portal@omp-extensions
omp plugin upgrade free-models@omp-extensions
omp plugin upgrade llm-metrics@omp-extensions
omp plugin upgrade magic-router@omp-extensions
omp plugin upgrade expert-review@omp-extensions
```

拡張モジュールの更新後はOMPを再起動してください。

## 設計方針

新しい機能が必要になった場合は、次の順で解決できるか確認します。

1. 現行OMP本体の機能で解決できるか
2. 対象ツールやProviderの公式連携で解決できるか
3. 既存のコミュニティ製プラグインで解決できるか
4. それでも具体的な不足が残る場合だけ、このリポジトリで補う

OMP本体のオーケストレーション、権限管理、Provider基盤、ステータス行そのものなどを別実装しません。上流へ同等機能が入った場合は、独自実装を維持するより削除・移行を優先します。

## 開発

Bunを使用します。

```bash
bun install --frozen-lockfile
bun run check
```

秘密情報の誤コミットを防ぐため、[Betterleaks](https://github.com/betterleaks/betterleaks) を導入している環境では、このリポジトリ同梱のpre-commit hookを有効化できます。

```bash
git config core.hooksPath .githooks
```

hookを有効化した状態でBetterleaksがPATHにない場合は、コミットを停止します。GitHub上ではSecret scanning / Push protectionも併用してください。

詳細は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。脆弱性や秘密情報に関わる報告は [SECURITY.md](SECURITY.md) に従ってください。

## ライセンス

MIT Licenseです。第三者実装を基にした箇所の帰属情報は各プラグインのREADME / LICENSEに記載しています。

## 参考

- Nous Portal Provider: <https://github.com/TerrifiedBug/omp-nous-portal-provider> (MIT)
- Hermes Agent: <https://github.com/NousResearch/hermes-agent>
