# GCPスペシャリスト 最新化メンテナンスガイド

**この文書は2026年6月時点の知見に基づく。GCPはサービス・MCP提供状況の変更が速いため、棚卸し時には下記の権威ソースで最新を必ず確認すること。**

GCP対応の「常に最新に更新できる体制」は2層で成り立つ。

| 層 | 仕組み | 更新の性質 |
|---|---|---|
| **日常（ランタイム）** | `gcp-specialist` が **Developer Knowledge MCP** で公式ドキュメントをライブ参照 | 自動・常時最新 |
| **定期（棚卸し）** | このガイドのチェックリストで、エージェント定義の静的部分とMCP設定の差分を追従 | 手動・四半期ごと推奨 |

日常はライブ参照で十分だが、エージェント定義に直書きした「対応サービス一覧」「既知の制約」「MCPエンドポイント」「認証方式」は、サービス側の仕様変更で陳腐化する。これを定期棚卸しで補正する。

---

## 権威ソース（棚卸し時に確認する一次情報）

| ソース | URL | 確認内容 |
|---|---|---|
| Google Cloud MCP servers 概要 | https://docs.cloud.google.com/mcp/overview | MCP全体方針・認証・バージョン |
| 対応プロダクト一覧 | https://docs.cloud.google.com/mcp/supported-products | リモートMCP対応サービスの増減・エンドポイント |
| AIアプリ設定（Claude Code） | https://docs.cloud.google.com/mcp/configure-mcp-ai-application | Claude Codeへの接続手順・OAuth設定の変更 |
| Developer Knowledge MCP | https://developers.google.com/knowledge/mcp | 知識MCPのエンドポイント・ツール・認証方式 |
| gcloud-mcp（補助・preview） | https://github.com/googleapis/gcloud-mcp | ローカル操作MCPの提供状況・破壊的変更 |

> 注意: 上記ページの認証ヘッダー名・エンドポイント・セットアップコマンドは変わりうる。`gcp-specialist.md` や `CLAUDE.project.template.md` に書いた具体値は、棚卸し時に必ずこの一次情報と突き合わせること。

---

## 四半期チェックリスト

- [ ] **対応プロダクト一覧**を確認し、`gcp-specialist.md` の「専門領域」に追記すべき新サービス／非推奨サービスがないか
- [ ] **Developer Knowledge MCP のエンドポイント・ツール名・認証方式**に変更がないか（`search_documents` / `get_documents` / `answer_query`、`X-Goog-Api-Key` ヘッダー等）
- [ ] **Claude Code への接続手順**（OAuthカスタムコネクタ / リモートMCP）に変更がないか
- [ ] **gcloud-mcp** が preview から正式化したか、破壊的変更がないか
- [ ] `gcp-specialist.md` 冒頭の「2026年6月時点」の日付と内容を更新
- [ ] このガイド冒頭の日付を更新

---

## 棚卸しの実行手順（プロンプト例）

Claude Code でこのリポジトリを開き、以下を依頼する:

```
references/gcp-maintenance.md の権威ソースを WebFetch で確認し、
dot_claude/agents/gcp-specialist.md と
dot_claude/CLAUDE.project.template.md のGCP関連記述に
差分（新サービス・廃止・エンドポイント変更・認証方式変更）がないか棚卸しして。
変更があれば該当ファイルを更新し、両ファイル冒頭の「時点」日付も更新して。
```

---

## スケジュール化（任意）

定期実行を自動化したい場合は、Claude Code のスケジュール機能（`/schedule`）でこの棚卸しを四半期ごとに走らせる routine を作れる。
- 例: 3か月ごとに上記「棚卸しの実行手順」のプロンプトを実行する routine
- スケジュール実行はクラウド側でコストが発生するため、導入はユーザーの明示判断で行う

---

## 関連ファイル

- `dot_claude/agents/gcp-specialist.md` — GCPスペシャリスト本体（Developer Knowledge MCP をライブ参照）
- `dot_claude/CLAUDE.project.template.md` — GCP利用時のMCP設定・APIキー環境変数の説明
