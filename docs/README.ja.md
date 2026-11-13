<p align="center"><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <b>日本語</b></p>

# pi-efficient-tool-use

[Pi](https://github.com/earendil-works/pi) のエージェントに、互いに依存しない検索を一つずつではなくまとめて送るよう促し、それがどれだけ効いたかをフッターに表示します（`⚒ 2/3 batched`：3 回のリマインダーのうち 2 回で、次のバッチに複数の呼び出しが入った）。あわせて、無駄なツール呼び出しのいくつかをその場で直します。

<p align="center"><img src="../assets/demo.png" alt="A real Pi session: three files read one at a time, the reminder, then three files read together in one turn; the footer shows ⚒ 1/1 batched" width="70%"></p>

```bash
pi install npm:pi-efficient-tool-use
```

## 機能

- **まとめ送りのリマインダー**：検索（read、grep、find、ls など）を 3 回続けて一つずつ送ると、最後の結果でモデルに独立した検索をまとめるよう伝えます。前の結果を使う検索は対象外です。
- **時間の通知**：15、30、60 分といった節目で、リクエストがどれだけ続いているか、時間が何に使われたかをモデルに伝えます。
- **bash の再帰 grep を止める**（grep ツールが有効なときだけ）：呼び出しを拒否し、grep ツールを案内します。
- **編集のヒント**：sed、perl、スクリプトでソースファイルを書き換えようとすると、edit ツールを勧めます。
- **もしかして**：`copy_bash` のように崩れたツール名には正しい名前を返します。
- **bash 出力を短く**：バイナリ出力と、パスや数字だけが違う行の長い連続を、それぞれ 1 行にまとめます。

## 効果はある？

少しだけ。私自身の Pi ログでは、リマインダーが出る場面（単独の検索が 3 回続いたとき）で、gpt-5.6-sol が次のバッチで複数の呼び出しを送った割合は、導入前が 13%、リマインダー後が 30% でした。5 バッチ後には差がなくなります。モデルが忘れるからです。1 週間で見ると、まとめ送りで最大 19 時間減らせる待ち時間のうち、約 1 時間を減らせた計算です。

<p align="center"><img src="../assets/effect.png" alt="Next batch 13% before install vs 30% after a reminder; next five batches 22% vs 24%; about 1.1 of at most 19.2 hours saved per week" width="100%"></p>

## 自分のログで確かめる

```bash
npx pi-efficient-tool-use
```

`~/.pi/agent/sessions` にある Pi のセッションを読み（何も外部に送りません）、モデルごとに同じ比較を表示します：導入前、リマインダー後、導入後でリマインダーなし。数千セッションで 2 分ほどかかります。

## 開発

```bash
npm install && npm test
```

## コントリビュート

まだ勉強中なので、アイデア、issue、pull request を大歓迎します。

## ライセンス

MIT
