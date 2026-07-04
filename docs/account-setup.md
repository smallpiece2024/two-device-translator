# 外部アカウント準備（ユーザー作業）

本プロジェクトの開発・運用に必要な外部サービスアカウントの準備手順。
**これらはすべてユーザー（オーナー）が行う作業**であり、エージェントは実施しない。

> **大原則: CI に外部アカウントは不要。**
> CI（GitHub Actions）はシークレットゼロで動く設計（外部APIはモック）。ここに挙げるアカウントは「ローカル開発」と「本番運用」のためのもの。**CI に GCP キー等を追加したくなっても追加しない**（`CLAUDE.md` の CI 節を参照）。

---

## 1. 必要なアカウント一覧

| # | サービス | 用途 | 補足 |
|---|---|---|---|
| 1 | GitHub | リポジトリ・CI | ✅ 準備済み（public リポジトリ、main ブランチ保護済み） |
| 2 | Google Cloud | STT/翻訳/TTS API、GCE（本番VM）、Google OAuth クライアントID | 既存 Google アカウントで可。**課金有効化が必須**（無料枠内でも音声APIは課金アカウントが必要） |
| 3 | Supabase | DB（PostgreSQL）＋ Auth | 新規作成（GitHub ログインで作成可能） |
| 4 | Anthropic（Claude API） | AI話題提供・終了時要約 | まず既定プロバイダの片方だけで良い（コスト面では Claude Haiku で十分と試算済み）。OpenAI は切替が必要になってから |
| 5 | ドメインレジストラ | 本番URL用ドメイン | GCE での Let's Encrypt HTTPS は**ドメイン必須**（素のIPには証明書を発行できない）。お名前.com / Cloudflare 等で1つ（年約1,500円〜） |

- Google OAuth は独立したアカウントではなく、GCP 内で「OAuth 同意画面＋クライアントID」を作成して Supabase Auth に設定する作業。
- 監視（Sentry等）・Docker Hub 等はこの規模では不要。必要になったら追加を検討する。

---

## 2. 環境分離の方針: 「本番 / 開発」の2面。ステージングとテスト用は作らない

| 環境 | GCP | Supabase | LLM | 備考 |
|---|---|---|---|---|
| 本番 (prod) | プロジェクト `two-device-translator-prod`（GCE VM＋音声API＋サービスアカウント） | クラウドプロジェクト①（Pro化は商用化時） | 本番用APIキー | ドメインを向ける |
| 開発 (dev) | プロジェクト `two-device-translator-dev`（音声APIのみ、認証はADC） | クラウドプロジェクト② または Supabase CLI のローカル環境（Docker、無料） | 開発用APIキー | ローカルPC＋トンネル（cloudflared/ngrok）で実機確認 |
| テスト (CI/Jest) | 不要（モック） | 不要（モック。結合テストはローカルCLI） | 不要（モック） | **アカウントゼロが正解** |
| ~~ステージング~~ | — | — | — | **作らない**。GCE VM がもう1台必要になり（+約$13/月）、1人開発の規模では過剰。dev ローカル＋トンネルで代替。必要になったら Phase 2 以降で検討 |

### 分離のポイント
- **GCP は「アカウント」ではなく「プロジェクト」で分離する**（プロジェクト作成は無料）。dev/prod で APIキー・クォータ・コストが分離され、開発中の事故が本番に混ざらない。無料枠（STT 60分/月 等）はプロジェクトごとに効く。
- **Supabase も「1アカウント複数プロジェクト」**。Free プランは2プロジェクトまで＆1週間未使用で一時停止するため、日常開発は CLI ローカル、クラウド②は Google OAuth 連携の確認用と割り切る。
- **LLM は環境ごとに「キー」を分ける**（アカウントは1つ）。dev 用キーには低めの利用上限を設定する。

---

## 3. 作成手順（依存関係順・フェーズ対応）

**今すぐ必要なのは 3-1（GCP の dev プロジェクト）だけ。** 残りはフェーズ進行に合わせて作れば良い。

### 3-1. GCP dev プロジェクト（Phase 1 のローカル開発に必要）
- [x] GCP の課金を有効化する
- [x] **予算アラートを設定する（例: 月$10）** ← 従量課金の事故防止。最初にやる
- [x] プロジェクト `two-device-translator-dev` を作成する
- [x] API を3つ有効化する: Cloud Speech-to-Text / Cloud Translation / Cloud Text-to-Speech
- [x] ローカル認証: `gcloud auth application-default login` → `gcloud auth application-default set-quota-project <dev-project-id>`

### 3-2. Supabase（Phase 2 の認証・DB実装までに）
- [ ] Supabase アカウントを作成する（GitHub ログイン可）
- [ ] プロジェクト①（prod想定）を作成する ※dev は CLI ローカルを基本とする
- [ ] GCP で OAuth 同意画面＋クライアントID を作成し、Supabase Auth の Google プロバイダに設定する
- [ ] `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` を `.env` に設定する（コミットしない）

### 3-3. Anthropic（Phase 3 の AI 機能までに）
- [ ] Anthropic アカウント＋APIキーを作成する（dev/prod でキーを分ける）
- [ ] **月次支出上限を設定する**（dev は低めに）

### 3-4. ドメイン＋GCP prod（初回デプロイまでに）
- [ ] ドメインを1つ取得する（例: お名前.com / Cloudflare）
- [ ] GCP プロジェクト `two-device-translator-prod` を作成し、API 有効化＋サービスアカウントを作成する
- [ ] GCE VM を作成する（e2-micro 無料枠 〜 e2-small）
- [ ] DNS をVMに向け、リバースプロキシ（Caddy/nginx）＋ Let's Encrypt で HTTPS 化する

---

## 4. セキュリティ注意（全フェーズ共通）

- APIキー・サービスアカウントキーは `.env` 等に置き、**リポジトリにコミットしない**（`.env*` は `.gitignore` 済み。リポジトリは public なので特に厳守）
- GitHub Actions の Secrets には**何も登録しない**（CD を導入する Phase 2 以降に、キーレスの Workload Identity Federation を検討）
- 課金系は作成直後にアラート/上限を設定する（GCP 予算アラート、Anthropic 支出上限）
