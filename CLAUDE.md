# プロジェクト開発ワークフロー（ベース定義）

このファイルはPM（プロジェクトマネージャー）としてメイン会話で動作するためのベース定義です。
PMはサブエージェントを逐次呼び出し、ワークフローを制御します。

**注意: このファイルは直接編集しないでください。`scripts/setup.sh` により `CLAUDE.project.md` と結合されて `CLAUDE.md` が生成されます。**

## Bashコマンド実行ルール（厳守）

**これはすべてのエージェントに適用される絶対ルールである。詳細は `rules/bash-single-line.md` を参照。**

1. **コマンドチェイン禁止** — `&&`, `;`, `|` でのチェインは禁止。1つずつ個別に実行
2. **単一行実行** — ヒアドキュメント、バッククォート内改行は禁止
3. **複数行引数は外部ファイル経由** — `tmp/` に一時ファイルを書き出して参照
   - `git commit -F tmp/commit-msg.txt`
   - `bd create --body-file tmp/bd-body.md`
   - `bd update {id} --body-file tmp/bd-body.md`

## エージェント呼び出しルール

- PMはメイン会話として動作し、サブエージェントを逐次呼び出す
- サブエージェントは他のサブエージェントを呼び出せない（Claude Codeの制約）
- 各サブエージェントはgit操作を行わない（Git管理者のみが行う）
- 各サブエージェントはBeads操作を行わない（Beads管理者のみが行う）
- 依存関係のないタスクは、同一メッセージ内で複数のAgent呼び出しにより並列実行する

## バグ報告・改善要望のトリアージ（PM必須手順）

ユーザーから複数のバグや改善要望を受け取った場合、**beads-managerに渡す前にPM自身が分解判断を行う**こと。beads-managerはCLI操作の専門家であり、分解の判断はPMの責務である。

### 手順
1. **調査**: 報告された各項目について、関連コードをRead/Grepで確認する
2. **判断**: 以下の基準で分離・統合・依存関係を決定する
3. **指示**: 判断結果に基づき、beads-managerに個別のタスク作成を指示する

### 分解の判断基準

| 状況 | 判断 | 例 |
|---|---|---|
| 修正箇所が異なるファイル/モジュール | **分離** | API側のバグとCSS崩れ |
| 同一関数・同一原因の可能性が高い | **統合** | 同じバリデーション処理に起因する2つの症状 |
| 一方を直さないと他方が確認できない | **依存関係を設定して分離** | DB修正が先、API修正が後 |
| 判断がつかない | **分離を優先** | 後から統合するより、分離しておく方がリスクが低い |

### 注意事項
- ユーザーの報告が「1つの問題」に見えても、修正箇所が複数モジュールにまたがる場合は分離する
- ユーザーの報告が「複数の問題」に見えても、根本原因が同一と判断できれば統合してよい
- 迷った場合は分離を選ぶ（1タスク=1エージェントが1セッションで完了できる粒度）

## ワークフロー

各フェーズの詳細手順はコマンドとして定義されている。PMはコマンドを実行してワークフローを進める。

### フェーズ1: 設計 → `/design`
要件定義→スペシャリスト相談→設計ドキュメント作成→タスク分解

### フェーズ2: 開発開始 → `/dev-start`
`bd ready`で実行可能タスクを取得し、並列実行可能なものはworktreeで並列処理

### タスク開発パイプライン → `/dev-task <id>`
準備→実装→コードレビュー→テスト実装→テストレビュー→テスト実行→テスト結果判定→完了
- コードレビューNG: 2回まで再実装、3回目以降はロールバック
- テスト結果NG: 同上

### ロールバック → `/dev-rollback <id>`
旧タスククローズ→新タスク作成→依存関係付け替え→ブランチ破棄（3回まで、4回目は停止）

### バグ・改善要望の修正 → `/fix-issue <問題の説明>`
Beadsタスク化→ブランチ作成→**失敗するテスト作成（Red）**→修正実装→**テスト成功確認（Green）**→仕様書追記→devマージ
- TDD フローを厳守（「簡単な修正」でもテスト作成を省略しない）
- 対応内容は仕様書漏れとして `docs/requirements.md` または `docs/design/` に追記する

### 並列実行ルール
- `bd ready` で依存なしタスクを取得し、worktreeで並列実行
- 同じファイルを編集する可能性がある場合は順次実行に切り替え

## エージェント一覧

### オーケストレーション層
| エージェント | ファイル | 役割 |
|---|---|---|
| 設計エージェント | `design-architect.md` | 要件→設計ドキュメント作成 |
| Beads管理者 | `beads-manager.md` | タスク作成・更新・依存関係・ロールバック管理 |
| Git管理者 | `git-manager.md` | ブランチ・コミット・マージ・Worktree管理 |

### フレームワーク/プラットフォームスペシャリスト層
| エージェント | ファイル | 役割 |
|---|---|---|
| Next.jsスペシャリスト | `nextjs-specialist.md` | Next.js固有の設計・実装アドバイザー |
| React+Viteスペシャリスト | `react-vite-specialist.md` | React+Vite (SPA) 固有の設計・実装アドバイザー |
| GCPスペシャリスト | `gcp-specialist.md` | GCP固有の設計・実装アドバイザー（公式ドキュメントをライブ参照） |

### 実装層
| エージェント | ファイル | 役割 |
|---|---|---|
| フロントエンドエンジニア | `frontend-engineer.md` | Reactコンポーネント、ページ実装 |
| バックエンドエンジニア | `backend-engineer.md` | API/データアクセス層、サーバーサイドロジック |
| DB設計エンジニア | `db-designer.md` | 汎用スキーマ設計、マイグレーション戦略 |
| Supabaseスペシャリスト | `supabase-specialist.md` | DB実装+Auth+RLS、Supabase MCP操作 |
| WEBデザイナー | `web-designer.md` | CSS Modules、レスポンシブ、ビジュアル |
| インフラエンジニア | `infra-engineer.md` | デプロイ設定、CI/CD、環境変数 |
| セキュリティスペシャリスト | `security-specialist.md` | 脆弱性監査、認証/認可レビュー |

### レビュー層
| エージェント | ファイル | 役割 |
|---|---|---|
| FEコードレビュアー | `frontend-code-reviewer.md` | フロントエンドコード品質・設計レビュー |
| BEコードレビュアー | `backend-code-reviewer.md` | バックエンドコード品質・設計レビュー |

### テスト層
| エージェント | ファイル | 役割 |
|---|---|---|
| FEテストエンジニア | `frontend-test-engineer.md` | フロントエンドテスト設計・実装・実行 |
| BEテストエンジニア | `backend-test-engineer.md` | バックエンドテスト設計・実装・実行 |

### テスト検証層
| エージェント | ファイル | 役割 |
|---|---|---|
| FEテストレビュアー | `frontend-test-reviewer.md` | フロントエンドテスト設計の十分性チェック |
| BEテストレビュアー | `backend-test-reviewer.md` | バックエンドテスト設計の十分性チェック |
| FEテストジャッジ | `frontend-test-judge.md` | フロントエンドテスト結果の判定・失敗分析 |
| BEテストジャッジ | `backend-test-judge.md` | バックエンドテスト結果の判定・失敗分析 |

---

# プロジェクト固有設定

two-device-translator — 2つのデバイスでそれぞれ別言語を話し、相手のデバイスで相手の言語に翻訳・表示・発話する、対面向けリアルタイム通訳ウェブサービス。技術検証用プロトタイプ `simple-translator` をベースに、2デバイス対応・認証・履歴永続化・AI機能を追加する。

> 要件の詳細は `docs/requirements.md` を参照。

## 技術スタック

### フレームワーク / サーバー
- フレームワーク: **Next.js (App Router)** / React / TypeScript
- **自前 WebSocket サーバー**: Node.js / TypeScript（`ws`、zod でメッセージ検証）。Next.js と同一リポジトリで、GCE 上に常時稼働する。2デバイス間のリアルタイム同期と音声処理の中継を担う（**Supabase Realtime は使用しない**）。
- マイク入力: MediaRecorder API（クライアント）

### 音声処理（Google Cloud、サーバー側のみ）
- **Speech-to-Text（Streaming）** / **Translation** / **Text-to-Speech**
- GCP client library（`@google-cloud/*`）はサーバー側でのみ使用する。**GCP 認証情報をブラウザに置かない**（`NEXT_PUBLIC_` を付けない）。
- 認証: 開発時は ADC（`gcloud auth application-default login`）、GCE 本番はサービスアカウント。

### DB / 認証
- **Supabase（PostgreSQL）**: 会話履歴・アカウント・ルーム・招待を永続化。アクセスは supabase-js（RLS）、スキーマは Supabase CLI。
- **Supabase Auth**: オーナーはメール+パスワードと Google OAuth。ゲストはアカウント不要（QR＋署名付きクッキー識別、名前は任意）。

### デプロイ
- **GCE（Compute Engine）** に Next.js + WebSocket サーバーを常時稼働（プロセス管理は pm2/systemd 等）。
- HTTPS はリバースプロキシ（Caddy/nginx）＋ Let's Encrypt で終端する。**Vercel は使用しない**（常時接続 WebSocket ＋ ストリーミング STT を維持するため）。

### 共通
- スタイリング: **CSS Modules**（**Tailwind CSS は禁止**）
- タスク管理: **Beads**
- テスト: **Jest**（単体・結合）＋ **Playwright**（E2E）

### クラウド
- GCP（Compute Engine / Speech-to-Text / Translation / Text-to-Speech / IAM 等）を使うため `gcp-specialist` が助言する（公式ドキュメントをライブ参照）。

## 外部連携が必要なエージェント / 環境変数のセットアップ

一部のエージェントは外部サービス連携（MCP・環境変数）が必要です。具体的な設定手順は各エージェント定義 `agents/*.md` の「セットアップ / 前提条件」節を参照してください。
環境変数は `.env` 等に置き、リポジトリにはコミットしない（`.env*` は `.gitignore` 済み）。

| エージェント / 用途 | 必要な設定 | 詳細 |
|---|---|---|
| `supabase-specialist` | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | `agents/supabase-specialist.md` |
| `gcp-specialist` | `GOOGLE_DEV_KNOWLEDGE_API_KEY` | `agents/gcp-specialist.md`（最新化体制は `references/gcp-maintenance.md`） |
| 音声API（実行時） | `GOOGLE_CLOUD_PROJECT`（＋ ADC / サービスアカウント） | STT/翻訳/TTS の呼び出しに使用 |
| WebSocket サーバー（実行時） | `WS_PORT`, `ENABLE_TTS`, `NEXT_PUBLIC_WS_URL` | プロトタイプ由来の設定を継承 |

## Git戦略

### ブランチ構成
- `main`: 正式版ブランチ（エージェント操作禁止）
- `dev`: 開発ブランチ（feature ブランチのマージ先）
- `feature/bd-{beads-id}`: タスクごとのブランチ

### ルール
- Git Worktree を使い、並行で進められるタスクは並行で進める
- feature ブランチは Beads の ID を使って命名する
- main ブランチはエージェントが操作しない（checkout / merge / push すべて禁止）
- feature→dev のマージはエージェント（git-manager）が行い、**マージ後は必ず `git push origin dev` を実行して CI を起動する**（リモート未設定の間は省略し、その旨を報告する）
- **dev→main は Pull Request 経由**。エージェントは `gh pr create --base main --head dev` で PR 作成までを行い、CI green の確認とマージはユーザーが行う
- **force push（`--force` / `-f`）は全ブランチで禁止**（settings.json でも deny 済み）
- コミットメッセージは Conventional Commits（`feat:`, `fix:`, `docs:` 等、日本語可）

## CI（GitHub Actions）

`.github/workflows/ci.yml` に定義。**エージェントのローカル検証と独立したセーフティネット**であり、レビュー・判定などの知的作業は持ち込まない。

### 実行内容とトリガー
- トリガー: push（`dev`, `feature/**`）と PR（`main` 向け）
- 内容: lint / typecheck（web・server 両方）/ Jest（単体・結合）/ build
- コードが存在しない間（`package.json` なし）は自動スキップして green を維持する

### 運用ルール（形骸化防止）
- **CI が red の間は新しいタスクに着手しない。** `/fix-issue` で最優先修正する
- 検証コマンドの単一情報源は package.json の npm スクリプト（`lint` / `typecheck` / `typecheck:server` / `test` / `build`）。ローカル・エージェント・CI は必ず同じコマンドを使う。**Phase 1 の雛形作成時にこの5つのスクリプトを必ず定義する**（Jest は `--passWithNoTests` を設定し、テストゼロ時代も green を保つ）
- flaky（たまに落ちる）テストは容認しない: 発見したら即 skip ＋ Beads タスク化し、修正または削除する。リトライ設定でごまかさない
- CI の検証に `continue-on-error` や `|| true` を入れない

### やらないこと（過剰装備防止）
- CI では本物の GCP / LLM / Supabase を呼ばない。**CI にシークレットを置かない**（外部 API は抽象化層でモックする）
- E2E（Playwright）は毎 push では回さない（main への PR 時に追加予定: フェイクマイク `--use-fake-device-for-media-stream` ＋ モック STT）
- カバレッジ閾値ゲート・OS/Node マトリクス・npm audit ゲート・GCE への自動デプロイ（CD）は当面導入しない（CD は Phase 2 以降、手動デプロイが苦になってから）

## 要件定義ドキュメント

- 配置先: `docs/requirements.md`

## 設計ドキュメント構成

設計エージェント(`design-architect`)が `docs/design/` 以下に作成する設計ドキュメントの一覧。

- `docs/design/overview.md`: 設計概要（各ドキュメントへのリンク集、要件要約、全体アーキテクチャ方針）
- `docs/design/app-architecture.md`: 全体構成、Next.js ページ構成、状態管理、フロント/WebSocketサーバーの責務分担
- `docs/design/websocket-protocol.md`: WebSocket メッセージ仕様（client→server: join/start/audio/stop/commit 等、server→client: transcript_interim/transcript_final/translation/audio/participant/summary/error 等）
- `docs/design/server-design.md`: WebSocket サーバー処理仕様（ルーム/セッション管理、話者識別、発話バッファ、発話区切り判定、配信ルーティング、再接続、不在/終了判定）
- `docs/design/gcp-integration.md`: Speech-to-Text(Streaming) / Translation / Text-to-Speech の実装方針、音声形式、ADC/サービスアカウント認証
- `docs/design/db-design.md`: スキーマ設計（User / Room / Participant / Message / Summary / Invite）、ER図、インデックス戦略
- `docs/design/supabase-design.md`: RLS ポリシー、Auth 設定、ゲストのクッキー識別との連携
- `docs/design/frontend-design.md`: コンポーネント設計（Recorder / LanguageSelector / ChatTimeline / TTSトグル / AIアシスタント / SettingsPanel）、LINE風UI、音声入出力、状態表示
- `docs/design/styling-design.md`: CSS Modules によるデザイントークン・レイアウト
- `docs/design/ai-assistant-design.md`: LLM プロバイダ抽象化（Claude / OpenAI 切替）、話題提供・終了時要約のプロンプト設計とトリガー
- `docs/design/infra-design.md`: GCE デプロイ、リバースプロキシ＋Let's Encrypt、プロセス管理、環境変数、CI/CD
- `docs/design/security-design.md`: 認証フロー（Supabase Auth ＋ ゲストクッキー）、GCP/LLM 認証情報のサーバー限定、脆弱性対策

## プロジェクト固有ルール

- **GCP / LLM の認証情報をクライアント（ブラウザ）側に含めない。** GCP client library はサーバー側でのみ使用する（`NEXT_PUBLIC_` を付けない）。
- **音声データは永続保存しない。** 永続化対象はテキスト（原文・翻訳）と要約のみ。
- 翻訳・音声合成は、原則として確定した発話区切り単位で行う。interim（認識途中）結果は画面表示のみに使い、翻訳・発話しない。
- 発話（TTS）はトグル ON 時のみ。テキスト表示はトグルに関係なく常に行う。
- 各デバイスは会話全体をそのデバイス利用者の言語で表示する（自分の発話は原文、相手の発話は翻訳）。
- 言語検出モードは常時ではなく、デフォルトと異なる言語で話したいときにユーザーが有効化して使う。
- 対応言語は MVP では日本語・英語（ja-JP / en-US）。言語追加が可能な構成にする。
- 会話履歴の永続閲覧はオーナーのみ。終了時要約は終了時点で両者（オーナー・ゲスト）に表示する。
- MVP は 1対1（オーナー1＋ゲスト1）。データモデル・ルーティングは 1対多（1:N）へ拡張可能に設計する。
- デプロイは **Vercel ではなく GCE**。Vercel 前提機能（Edge Middleware 等）に依存しすぎない。
- 仕様の変更・追加は `docs/requirements.md` または `docs/design/` に追記する。
