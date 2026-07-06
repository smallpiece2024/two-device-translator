# インフラ設計（GCE デプロイ / CI）

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)（2プロセス構成）
- [GCP連携設計 (gcp-integration.md)](./gcp-integration.md)（サービスアカウント）
- [セキュリティ設計 (security-design.md)](./security-design.md)（HTTPS・環境変数）
- 要件定義: [docs/requirements.md](../requirements.md)（§4 ホスティング / NFR-1.1 HTTPS / §11①）

---

## デプロイ構成の全体像

**GCE（Compute Engine）VM 上に Next.js と WSサーバーを常時稼働**し、Caddy（リバースプロキシ＋Let's Encrypt）で HTTPS 終端とパス振り分けを行う（要件§11①）。**Vercel は使わない**（常時接続 WebSocket ＋ ストリーミング STT を維持するため）。

```text
[インターネット] ──HTTPS(443)/WSS──▶ GCE VM (e2-small)
                                       │
                                       ├─ Caddy (443/80)  ── Let's Encrypt 自動証明書
                                       │    /ws*  → 127.0.0.1:3001   (WebSocket Upgrade 自動処理)
                                       │    /*    → 127.0.0.1:3000   (Next.js)
                                       │
                                       ├─ pm2 ─ web: node .next/standalone/server.js  (127.0.0.1:3000)
                                       └─ pm2 ─ ws : node dist-server/index.js         (127.0.0.1:3001)
                                            │ アタッチされた GCP サービスアカウント(ADC)
                                            └─▶ Google Cloud / Supabase / LLM
```

- Next.js・WSサーバーは **127.0.0.1 のみで LISTEN** し外部に直接晒さない。外部公開は Caddy 経由のみ。

### VM スペック（確定・2026-07-06）

| 項目 | 決定 | 根拠 |
|---|---|---|
| リージョン | **asia-northeast1（東京）** | 音声ストリーミングの遅延がUXに直結（ユーザーは日本国内）。Supabase（ap-northeast-1）にも近接。無料枠 e2-micro は US リージョン限定のため利用しない |
| マシンタイプ | **e2-small（2 vCPU 共有 / 2GB）で検証を開始し、必要に応じて e2-medium（4GB）へリサイズ** | 常駐プロセス合計 約600〜900MB（Next.js 200-400MB + WS 100-200MB + Caddy + OS）に対し約1GBの余裕。e2-micro（1GB）は余裕がなく OOM リスク。GCE はマシンタイプ変更が容易（停止→変更→起動）なため、実測で逼迫してから上げる |
| ディスク | **pd-balanced 20GB** | OS + node_modules + ビルド成果物 + ログで 10GB は手狭。pd-standard との価格差は僅少。pm2-logrotate でログ肥大を防ぐ |
| 外部IP | **静的 IPv4 を予約してアタッチ** | 独自ドメイン + Let's Encrypt（Caddy）の DNS 安定化に必要。使用中でも課金される（約$0.004/時） |
| VM 種別 | **通常 VM（Spot 不可）** | Spot は強制終了があり、常時接続 WS + ストリーミング STT と非両立 |
| OS | Debian 12 または Ubuntu 24.04 LTS | pm2 / Caddy の定番構成 |

- 月額概算（東京、2026-07 時点）: e2-small 約 $15.7 + 使用中外部 IPv4 約 $2.9 + pd-balanced 20GB 約 $2 ≒ **合計約 $21/月**。e2 ファミリーは継続利用割引（SUD）の対象外（確約利用割引 CUD のみ。検証段階では契約しない）。
- **`next build` を VM 上で実行する場合の注意**: ビルドはピークで 1GB 超のメモリを使うため、e2-small では swap（2GB 以上）を設定するか、CI / ローカルでビルドした成果物（`.next/standalone` / `dist-server/`）を転送する方式を優先する（構築タスク bd-bg3 で確定）。

---

## ビルドと出力

| プロセス | ビルド | 実行 | ポート |
|---|---|---|---|
| Next.js（web） | `next build`（`output: 'standalone'`） | `node .next/standalone/server.js` | 3000 |
| WSサーバー（ws） | `tsc -p tsconfig.server.json` → `dist-server/` | `node dist-server/index.js` | 3001 |

- `next.config.ts` に `output: 'standalone'` を設定し、`.next/standalone` に自己完結した成果物を出す（依存を同梱、配布が軽い）。
- WSサーバーは本番では `tsx` 実行ではなく **tsc でビルドした JS を node で実行**（起動安定性・依存最小化）。開発時は `tsx --watch`（プロトタイプ踏襲）。
- `@google-cloud/*` は WSサーバー側のみの依存。Next.js standalone に含めない（tsconfig 分離、[app-architecture.md](./app-architecture.md#tsconfig-分離方針) 参照）。`next.config.ts` の `serverExternalPackages` に `@google-cloud/*` を保険で記載してよい（設計上 Next.js からは import しない）。

---

## プロセス管理（pm2）

`ecosystem.config.js` で web / ws の2アプリを管理する。

```js
// ecosystem.config.js （設計指針）
module.exports = {
  apps: [
    { name: "web", script: ".next/standalone/server.js", env: { PORT: 3000, HOSTNAME: "127.0.0.1" } },
    { name: "ws",  script: "dist-server/index.js",        env: { WS_PORT: 3001 } },
  ],
};
```

- `pm2 startup` + `pm2 save` で VM 再起動後の自動起動を設定。
- 環境変数は pm2 の env またはプロセス起動元の `.env`（VM 上、コミットしない）で供給。
- ログは pm2 のログ（`pm2 logs`）。本番用ログ基盤は当面導入しない（YAGNI）。
- systemd での管理も可（要件は pm2/systemd 等）。本設計は pm2 を基本とする。

---

## リバースプロキシ（Caddy + Let's Encrypt）

```caddyfile
# Caddyfile （設計指針）
{$APP_DOMAIN} {
    encode gzip
    # WebSocket は Upgrade を Caddy が自動処理
    reverse_proxy /ws* 127.0.0.1:3001
    reverse_proxy 127.0.0.1:3000
}
```

- Caddy は Let's Encrypt の証明書を**自動取得・更新**（`APP_DOMAIN` に DNS を向ける）。HTTPS 化により `getUserMedia`（マイク）が動作する（NFR-1.1）。
- `/ws*` を WSサーバーへ、それ以外を Next.js へ。Caddy は WebSocket Upgrade を明示設定なしで通す。
- nginx を使う場合は `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` を明示（本設計は Caddy を基本とする）。
- クライアントの `NEXT_PUBLIC_WS_URL` は `wss://{APP_DOMAIN}/ws` を指す（同一ホスト・同一ポート443、Caddy がパスで振り分け）。

### 開発時の HTTPS（実機確認）

- ローカル実機（スマホ）確認は開発トンネル（cloudflared / ngrok）で HTTPS を得る（NFR-1.1）。開発の常用は `localhost`（セキュアコンテキスト扱い）。

---

## GCP サービスアカウント

- 本番は VM に**サービスアカウントをアタッチ**し、ADC をメタデータサーバー経由で取得（鍵ファイル不要、[gcp-integration.md](./gcp-integration.md#認証adc--サービスアカウント) 参照）。
- 必要ロール（最小権限）: Speech-to-Text / Translation / Text-to-Speech の利用ロール。
- `GOOGLE_CLOUD_PROJECT` を環境変数で供給。鍵 JSON をリポジトリ・イメージに含めない。

---

## 環境変数一覧

`.env`（VM 上・ローカル）はコミットしない。`.env.example` を用意しコミットする（`.gitignore` に `.env*` 済み）。

| 変数 | 利用プロセス | クライアント露出 | 説明 |
|---|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | ws | 不可 | GCP プロジェクトID |
| `GOOGLE_APPLICATION_CREDENTIALS` | ws | 不可 | （鍵ファイル利用時のみ）本番は原則不要（アタッチSA） |
| `WS_PORT` | ws | 不可 | WSサーバー待受（既定 3001） |
| `ENABLE_TTS` | ws | 不可 | `false` で音声合成を無効化（プロトタイプ由来） |
| `GCP_MODE` | ws | 不可 | **E2Eテスト専用**。`mock` で STT/翻訳/TTS を決定的モック（`server/gcp/mockGcp.ts`）に切替。**本番・開発の通常運用では設定禁止**（未設定＝実GCP。誤設定検出のため mock 時は起動ログに明示される）（bd-713 で追加） |
| `AUTH_MODE` | ws | 不可 | **E2E・開発専用**。`insecure` で WS接続時のtoken検証をスキップ（Phase1互換）。**本番では設定禁止**（未設定＝strict＝本検証。有効時は起動ログに警告）（bd-0jy で追加） |
| `APP_BASE_URL` | web | 不可 | 招待URL等の組み立てに使う公開ベースURL（例 `https://{domain}`）。**本番では必須**（未設定時は Host ヘッダにフォールバックするが、Host Headerポイズニング防御のため本番はフォールバックさせない）（bd-jny で追加） |
| `AUTO_END_THRESHOLD_MS` | ws | 不可 | 在室1人以下が継続したら自動終了するまでのミリ秒（既定 600000=10分）（bd-e3p で追加） |
| `SUPABASE_URL` | web/ws | 不可 | Supabase プロジェクトURL |
| `SUPABASE_SERVICE_KEY` | ws / 一部 Route Handler | **不可** | service_role キー（[supabase-design.md](./supabase-design.md#service_role-の使用箇所) 参照） |
| `NEXT_PUBLIC_SUPABASE_URL` | web | 可 | ブラウザ用 Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | 可 | anon キー（RLS 前提で露出可） |
| `GUEST_COOKIE_SECRET` | web/ws | **不可** | ゲストJWT 署名鍵（jose/HS256、共有） |
| `LLM_PROVIDER` | web/ws | 不可 | `claude` / `openai` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | web/ws | **不可** | LLM APIキー |
| `LLM_MODEL` | web/ws | 不可 | 既定モデル（省略可） |
| `NEXT_PUBLIC_WS_URL` | web(client) | 可 | WS接続先（例 `wss://{domain}/ws`） |
| `APP_DOMAIN` | Caddy | - | 公開ドメイン |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI（開発者ローカルのみ） | 不可 | Supabase CLI 実行用トークン。下記「環境変数の管理方針」参照。本番VMには置かない |

- **`NEXT_PUBLIC_` を付けてよいのはブラウザに見えても問題ない値のみ**（Supabase URL/anon、WS URL）。GCP/LLM/service_role/ゲスト署名鍵には絶対に付けない（[security-design.md](./security-design.md#環境変数と認証情報の扱い) 参照）。
- `GUEST_COOKIE_SECRET` は Next.js と WSサーバーで**同一値**を共有する（同じ JWT を両者が検証、[supabase-design.md](./supabase-design.md#ゲストのクッキー識別との連携) 参照）。

### 環境変数の管理方針（bd-7sg）

開発端末は複数プロジェクト共用のため、**マシン全体の環境変数（`setx` やOSのシステム環境変数）には環境変数を置かない**。プロジェクト直下の `.env`（`.gitignore` 済み、コミットしない）に集約する。

- **Next.js（web）**: `next dev` / `next start` が `.env` を自動読込する（Next.js標準機能）。追加設定は不要。
- **WSサーバー（ws）**: 開発時は `dev:ws`（`tsx --watch --env-file-if-exists=.env server/index.ts`）が Node.js の `--env-file-if-exists` で `.env` を読み込む。本番は `pm2` の `env_file`、または `systemd` の `EnvironmentFile=` で同じ `.env` を読み込む（下記「プロセス管理（pm2）」参照）。
- **Supabase CLI**: `npm run sb -- <subcommand>`（例: `npm run sb -- projects list`）経由で実行する。`sb` スクリプトは `dotenv -o -e .env -- npx supabase` で、プロジェクトの `SUPABASE_ACCESS_TOKEN` を **override（`-o`）** 付きで注入する。これにより、マシンに残留した `supabase login` の共有トークン（誤アカウント接続の原因になった）よりも `.env` の値が必ず優先される。`supabase` CLI 自体は devDependency に追加せず `npx` のキャッシュに委ねる（バイナリが大きく CI が遅くなるため）。
- **GCE 本番**: `.env` をアプリディレクトリ（VM上、コミットしない）に配置し、`pm2` の `env_file` オプションまたは `systemd` の `EnvironmentFile=` で読み込む。`SUPABASE_ACCESS_TOKEN`（Supabase CLI 管理用のトークン）は実行時に不要なため**本番VMには置かない**。GCP認証は VM にアタッチしたサービスアカウント（ADC、メタデータサーバー経由）を使うため環境変数は不要。

---

## CI（GitHub Actions）

既存 `.github/workflows/ci.yml` と CLAUDE.md「CI」節に整合する。**エージェントのローカル検証と独立したセーフティネット**であり、レビュー・判定などの知的作業は持ち込まない。

- トリガー: push（`dev`, `feature/**`）と PR（`main` 向け）。
- 内容: lint / typecheck（web）/ typecheck:server / Jest（単体・結合）/ build。
- 検証コマンドの単一情報源は package.json の npm スクリプト（`lint` / `typecheck` / `typecheck:server` / `test` / `build`）。**Phase1 の雛形作成時にこの5スクリプトを必ず定義**（Jest は `--passWithNoTests`）。
- コードが無い間（`package.json` なし）はスキップして green を維持（既存 ci.yml の挙動）。
- **CI に GCP / LLM / Supabase の本物を呼ばない・シークレットを置かない**。外部APIは抽象化層でモック（[server-design.md](./server-design.md#テスト方針概要) / [ai-assistant-design.md](./ai-assistant-design.md#テスト方針概要) 参照）。
- E2E（Playwright）は毎 push では回さない。main への PR 時に追加予定（CI への組込みは未実施）。

### E2E テスト構成（bd-713 で実装）

- `npm run test:e2e`（`playwright test`）。テストは `e2e/`、設定は `playwright.config.ts`。Jest とは分離（`jest.config.js` の `testPathIgnorePatterns` で `e2e/` を除外）。
- `webServer` で Next.js（port 3000）と WSサーバー（port 3001、`GCP_MODE=mock`）を自動起動。フェイクマイクは Chromium の `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`。
- モック仕様: STT は音声チャンク4回目で言語別固定フレーズの final を発火、翻訳は `[{target}] {text}` 形式、TTS は極小無音MP3（[gcp-integration.md](./gcp-integration.md#テスト方針gcp連携) 参照）。実GCP API は呼ばない。
- `reuseExistingServer: false`: 起動済みの `npm run dev`（実GCP構成）を誤って再利用しないよう fail-fast にしている。**`test:e2e` 実行前に dev サーバーを停止すること**。
- 再接続シナリオ（サーバー再起動またぎ・指数バックオフ・fatal後の抑止）は本E2Eのスコープ外（別タスクで管理）。

### npm スクリプト（雛形定義対象）

| スクリプト | 内容 |
|---|---|
| `lint` | ESLint（src・server・shared） |
| `typecheck` | `tsc --noEmit`（`tsconfig.json`: src + shared） |
| `typecheck:server` | `tsc --noEmit -p tsconfig.server.json`（server + shared） |
| `test` | `jest --passWithNoTests` |
| `build` | `next build`（standalone）。WS ビルドは別途 `build:server`（`tsc -p tsconfig.server.json`） |
| `dev` | `concurrently` で `next dev` と `dev:ws`（プロトタイプ踏襲） |
| `dev:ws` | `tsx --watch --env-file-if-exists=.env server/index.ts`（`.env` からWSサーバーの環境変数を読込、bd-7sg） |
| `sb` | `dotenv -o -e .env -- npx supabase`。`npm run sb -- <subcommand>` で Supabase CLI を `.env` の `SUPABASE_ACCESS_TOKEN` で実行（bd-7sg） |

---

## CD（対象外）

**CD（GCE への自動デプロイ）は当面導入しない**（CLAUDE.md CI 節）。デプロイは手動（VM 上で `git pull` → `npm ci` → `build` → `build:server` → `pm2 reload ecosystem.config.js`）。手動デプロイが苦になった段階（Phase2 以降）で検討する。本設計では CD パイプラインを定義しない。

### 手動デプロイ手順（VM 上、1コマンドずつ）

```text
git pull
npm ci
npm run build
npm run build:server
pm2 reload ecosystem.config.js
```

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | ローカル2プロセス起動（`npm run dev`）、CI の5スクリプト定義。デプロイは任意（動作確認は localhost/トンネル） |
| Phase 2 | GCE VM 構築、Caddy + Let's Encrypt、pm2、サービスアカウント、環境変数整備 |
| Phase 3 | 変更なし（AI/履歴の env 追加のみ）。CD は引き続き対象外 |
