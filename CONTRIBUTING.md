# Contributing

## 開発環境

Bunを使用します。

```bash
bun install --frozen-lockfile
bun run check
bun run audit
```

変更したプラグインについては、必要に応じて現在サポートするOMPで実際にロード・操作して確認してください。OMP本体や上流ツールに同等機能がある場合は、独自実装を増やさず上流機能の利用を優先します。

`bun run audit` は、開発用OMP SDKが持つoptional / peerのML・音声スタックを除外し、このリポジトリの検証に必要な依存グラフを監査します。Marketplaceプラグインは `node_modules` を配布物へ同梱しません。optional / peer側はOMP upstreamの更新へ追従し、ここで独自overrideを追加しません。

## 秘密情報

APIキー、OAuthトークン、Cookie、秘密鍵、ローカル専用認証情報をコミットしないでください。

Betterleaksを導入している場合、このリポジトリ同梱のpre-commit hookを有効化できます。

```bash
git config core.hooksPath .githooks
```

hookはstaged内容をBetterleaksで検査し、検出またはスキャン失敗時はコミットを停止します。

## Pull Request

- 変更理由とユーザーから見える挙動を明確にする
- OMP本体や上流実装との重複がないか確認する
- 実行時挙動が変わる場合は対象プラグインのSemVerを更新する
- `bun run check` を通す
- 新しい依存関係は、既存機能や標準機能では解決できない場合だけ追加する
