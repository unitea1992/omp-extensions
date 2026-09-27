# magic-router

通常の指示文から必要な実行モードを軽量かつ決定論的に判定し、OMP本体のmagic keyword（`ultrathink` / `orchestrate` / `workflowz`）を**現在のターンだけ**自動付与する拡張です。OMP本体の `jevify` も手動指定として認識し、その場合は自動判定を行いません。

OMP本体の推論強化、オーケストレーション、ワークフローは再実装しません。入力時に必要なキーワードを補うだけに留め、キーワード検出とnoticeの追加はOMP本体へ任せます。

## 動作

- `input` フックで現在のプロンプトを評価し、必要なキーワードだけを末尾（`\n` + keyword）へ追加します。
- 内部判定は2軸に分離します。
  - 推論強化: `none | ultrathink`
  - 作業委譲: `none | orchestrate | workflowz`
- 自動出力は `none`、`ultrathink`、`orchestrate`、`ultrathink + orchestrate`、`workflowz`、`ultrathink + workflowz` のみに限定します。`orchestrate` と `workflowz` は互いに独立に判定し、固定の優先順位はありません。両方に該当する場合は作業委譲を付けず `none` とします（`ultrathink` は独立に付与できます）。
- `ultrathink` は作業委譲の判定とは独立して追加できます。
- 作業委譲は保守的に判定します。`orchestrate` と `workflowz` をそれぞれ独立に評価し、該当条件を高い確度で読み取れる場合だけ付与し、曖昧なら `none` を優先します。
- 判定材料はOMP本体の `maskNonProse()` を通した通常文章だけです。コードブロック、インラインコード、一般XML・HTML内の文言（貼り付けたREADMEやコード例など）は判定材料にしません。コード例内の `local://paste-N.md` や同形の `<attachment>` も添付経路として解釈しません。ただしOMPの長文貼り付け機能 **Attach as a wrapped block** が生成する通常文章上の厳密な `<attachment>…</attachment>` は、判定用にだけ本文を展開します。
- `workflowz` は、調査・計画・実装・検証の区分で3段階以上かつ広がり（breadth）の両方を要求します。広がりとは、広範・幅広・包括・横断・大規模・全体的・全面的・リポジトリ全体・コードベース全体などの範囲表現、全体＋調査/見直し/改修/移行/設計/把握/テスト、複数範囲、終端不明の一覧作業（2つ以上の対象を伴う場合）、広がりを伴う調査・複数観点レビュー・大規模移行のいずれかです。単なる「調査→修正→テスト」の3段階だけでは付けません。参照物への言及、`最新`・`比較`・`詳細`・`敵対`・`安全に`・`段階的`・`step-by-step`、体系的・multi-stage・end-to-end・一気通貫などの多段階表現、単一範囲への言及だけでは `workflowz` を付けません。
- `orchestrate` は、2つ以上の対象と明示的な並列実行と独立性の3点すべてを要求します。対象は箇条書きまたは `N件/つ/個/tasks` 等の言及で数え、並列実行は「並列に/で＋進め・実行・調査・対応・作業・処理・実施」または `in parallel`、独立性は独立・independent・independence または workstream の言及です。「並列化できるか確認して」のような確認だけでは付けません。
- `ultrathink` は、アーキテクチャの検討・判断・選定・設計、根本原因調査、難しいデバッグ、トレードオフ判断、敵対監査・敵対検証・敵対レビューなどを強い判定材料とします。「アーキテクチャ図のファイル名」のような単なる言及では付けません。
- 参照物への言及（例: `Issue #123`、`PR #45`、`plan.md` 等）と作業引き継ぎ表現だけでは `workflowz` を付けません。`要約して`、`読んで` だけの読み取り要求で発火しないのはもちろん、`作業して`・`対応を完了して` を伴う場合も単独では判定材料にしません。ネットワーク取得は行いません。
- 元入力にOMP本体のmagic keywordが1つでも明示されている場合は自動判定を行わず、入力を変更しません。判定には本体の `hasMagicKeyword()` を使います。
- 「単独で作業」「サブエージェントを使わない」「do not delegate」などの明示は、自動 `orchestrate` / `workflowz` に対する強制停止条件です。`ultrathink` の自動付与は許可します。この指定は参照物からの作業引き継ぎより常に優先し、ユーザー自身が入力したmagic keywordは削除・書き換えません。
- スラッシュコマンド（`/`）、Bash（`!`）、Python（`$` / `$$`）、yield queue（`->` / `=>`）、継続ショートカット（`.` / `c`）、空入力は判定対象外としてそのまま通します。
- 判定処理は決定論的なローカル処理だけで、追加のLLM呼び出しやネットワーク取得は行いません。通常文章の抽出と手動キーワード検出にはOMP本体の補助関数を直接使い、ローカル複製を持ちません。

内部判定の例:

```text
reasoning=ultrathink delegation=none veto=solo-intent reasons=[veto:solo-intent,root-cause,reasoning-score:2]
```

この内部判定はデバッグログへ1行だけ出します。通常の対象ターンでは会話履歴への通知ではなく、ステータス行 / フッターへ判定結果を表示します。

```text
Magic Router: ultrathink
Magic Router: orchestrate
Magic Router: ultrathink + workflowz
Magic Router: none
Magic Router: manual
Magic Router: enabled
Magic Router: disabled
```

`ultrathink` / `orchestrate` / `workflowz` / `jevify` が表示される場合、そのキーワード部分だけOMP本体の `highlightMagicKeywords()` と同じ静的グラデーションで描画します。独自配色は持ちません。テーマや強調表示機能を利用できない場合は通常文字へ戻し、自動判定自体は継続します。

`Magic Router: none` は、**`input` フックと判定処理は動いたが自動キーワードを選ばなかった**ことを示します。通常の判定対象ターンでステータス自体が出ない場合は、プラグインが読み込まれていないか、その入力が対話TUIの `input` フックを通っていない可能性があります。`Magic Router: manual` は、元プロンプトにOMP本体のmagic keywordがあり、自動判定を省略した状態です。

ステータスは回答完了後も残し、直前ターンの判定を確認できるようにします。**次の判定対象ユーザーターンが送信された時点**で前の表示を消し、新しい判定結果へ更新します。スラッシュコマンド、Bash、Python、継続ショートカットなど対象外入力だけでは前の表示を消しません。session switch / branch / tree / shutdownでは古い表示を避けるため消去します。明示的に有効・無効を切り替えたセッションへ `session_switch` で戻った場合は、`enabled` / `disabled` 状態だけ復元し、過去ターンの判定結果は復元しません。

## セッション単位の有効・無効切替

`/magic-router` で**現在のセッションだけ**自動判定を有効・無効化できます。

```text
/magic-router
```

- セッションの初期値は `enabled`。
- 引数なし `/magic-router` だけが `enabled` ↔ `disabled` を切り替える。
- `/magic-router status` など引数付き実行は `warning` 通知だけ出し、状態を変えない。例: `Magic Router: unknown argument (this session) — usage: /magic-router`
- 状態は `sessionId` ごとに保持し、別セッションへ漏らさない。
- セッションAを無効化してBへ移動し、Aへ戻ってもAは無効のまま。戻った直後はフッターへ `Magic Router: disabled` または `enabled` を復元する。
- `disabled` 中は判定処理、添付確認、プロンプト書き換えを行わない。
- 無効化直後は `Magic Router: disabled (this session)`（`info`、1回のみ）とフッター `Magic Router: disabled` を表示する。再有効化直後は対応する `enabled` 表示を行う。
- 再有効化後、次の判定対象ターンで通常の判定表示へ更新する。通常ターンでは通知を増やさない。
- 操作UIのためだけにuser / assistantメッセージや永続セッションメッセージを追加しない。
- セッション終了時は保持状態を破棄する。

## 長文貼り付けと添付

OMPの長文貼り付けメニューにある3方式をすべて判定対象にします。OMP本体の転送方式は置き換えず、公開 `input` フックへ届く形式だけを補完します。

| OMPの選択肢 | 送信時の形式 | magic-routerの扱い |
| --- | --- | --- |
| **Attach as a wrapped block** | `<attachment>\n...\n</attachment>` | OMPが生成する厳密な囲みの本文だけを判定材料へ追加。実プロンプトの囲みは保持 |
| **Attach as local file** | `local://paste-N.md` | 公開 `ExtensionContext.localProtocolOptions` でセッション内ファイルを解決し、本文を判定材料へ追加 |
| **Paste inline** | 貼り付け内容が送信時に本文へ展開 | `event.text` に本文がすでに入るため追加処理なし |

メニュー閾値未満の通常貼り付けやメニュー取消時も、OMPは本文内添付として処理するため **Paste inline** と同じ経路で判定できます。

囲みブロックやローカルファイルから読み出した本文は判定にだけ使い、実際のユーザープロンプトへ二重挿入しません。手動magic keywordの優先判定やスラッシュコマンド判定など、入力経路に関わる意味は元プロンプトだけを基準にします。そのため添付本文内に `workflowz` などがあるだけでは、ユーザーの手動指定とは扱いません。

添付だけが渡された場合や、`この指示に従ってください: local://paste-1.md` のように添付内容を作業指示として明示した場合は本文を判定します。一方、外側が `このIssue本文を要約して` のような読み取り要求なら、添付は資料として扱い、本文内の作業動詞や段階だけで自動委譲を発火させません。公開入力だけでは完全に区別できない混在ケースは既知の制限とします。

**Paste inline** は送信前にOMPが本文を `event.text` へ展開するため、公開 `input` フック上では手入力と区別できません。貼り付け本文中の単独magic keywordは手入力と同様に手動指定として扱われ、作業説明も自動判定材料になります。これを避けたい場合は囲みブロックまたはローカルファイル方式を使うか、本文表現を変更してください。

一般のXML / HTMLを自動展開しません。囲みブロックはOMPが生成する厳密な `<attachment>\n...\n</attachment>` 形式のうち通常文章上の出現だけ、ローカルファイルは通常文章上の `local://paste-N.md` だけを対象にします。コードブロックやインラインコード中の同形文字列は添付経路として解釈しません。任意のファイルシステムパスや一般 `local://` リソースも読みません。公開 `input` フック上では手入力の同形囲みと区別できないため、通常文章として完全同一の囲みを手入力した場合も同様に判定材料としますが、プロンプトへ再挿入はしません。

判定用追加本文は、囲みブロック最大4件、ローカル貼り付け最大4参照、1件512 KiB、合計1 MiBまでです。解決・読込に失敗した場合は元プロンプトだけで判定を続けます。

## 対応する入力経路

- 対話TUIの入力で動作します。現行OMPでは `input` フックが対話送信経路から呼ばれます。
- RPC / ACP / print / focused subagent sessionなど、同じ公開フックを通らない経路は対象外です。これらまで覆うためにOMP本体の挙動を複製・修正しません。
- Orca上でOMP TUIを使う場合も同じ `input` フックとステータス表示を利用します。

## 意図的にしないこと

- OMP本体のオーケストレーション、ワークフロー、推論強化の再実装
- `jevify` の自動選択。現在はユーザーの明示指定を尊重するための検出だけ行う
- 追加LLM呼び出しによるプロンプト分類
- Issue / PR本文の事前ネットワーク取得
- ユーザーが入力したmagic keywordの上書き・補強・削除
- 永続的な監視情報や独自トークン集計
- 毎ターンの会話履歴通知
- 任意ファイル添付や任意XMLの自動読込
- 有効・無効状態の永続保存（セッション中だけ保持）
- ユーザー意図を無視した積極的な作業委譲
- プロンプト長だけによる複雑さ判定

## 失敗時

判定処理や添付確認に失敗した場合は元入力をそのまま通します。ログ記録（`pi.logger.debug()`）とステータス表示（`ctx.ui.setStatus()`）は補助扱いで、失敗してもすでに計算済みの判定結果は破棄しません。ステータスのグラデーション描画失敗も表示上の問題として扱い、自動判定は継続します。

## インストール

マーケットプレイス登録後:

```bash
omp plugin install magic-router@omp-extensions
```

更新:

```bash
omp plugin marketplace update omp-extensions
omp plugin upgrade magic-router@omp-extensions
```

拡張更新後はOMPを再起動してください。
