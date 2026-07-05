# セキュリティ設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [Supabase設計 (supabase-design.md)](./supabase-design.md)（RLS・Auth・ゲスト連携）
- [サーバー設計 (server-design.md)](./server-design.md)（接続時認証）
- [GCP連携設計 (gcp-integration.md)](./gcp-integration.md)（認証情報）
- [インフラ設計 (infra-design.md)](./infra-design.md)（HTTPS・環境変数）
- 要件定義: [docs/requirements.md](../requirements.md)（NFR-1 セキュリティ・プライバシー）

---

## 最重要原則

| 原則 | 根拠 |
|---|---|
| GCP / LLM の認証情報をブラウザに渡さない | NFR-1.2 / CLAUDE.md 固有ルール |
| 音声データは永続保存しない | NFR-1.4 |
| ゲスト識別クッキーは署名付き・HttpOnly・Secure | NFR-1.3 |
| パスワードはハッシュ化保存（Supabase Auth が担保） | NFR-1.5 |
| マイク利用のため HTTPS 必須 | NFR-1.1 |

プロトタイプ [`simple-translator` の security-design.md](../../../simple-translator/docs/design/security-design.md) は「GCP認証情報をブラウザに漏らさない」に絞っていた。本サービスは**ユーザー認証・認可・履歴のプライバシー**が加わるため、認証フローと RLS・脆弱性対策を拡張する。

---

## 認証フロー

2系統の認証が並立する。**認証方式が違うためルートグループで境界を分ける**（[app-architecture.md](./app-architecture.md#next-js-ページ構成とルーティング) 参照）。

| 主体 | 認証手段 | セッション | 検証場所 |
|---|---|---|---|
| オーナー | Supabase Auth（メール+PW / Google OAuth） | Supabase セッション（`sb-*` クッキー） | middleware（Edge）+ Server Component + WSサーバー |
| ゲスト | 自前の署名付きクッキー（jose/HS256） | `gtt_guest` クッキー | Server Component / Route Handler（Node）+ WSサーバー |

### オーナー認証

```text
/login → Supabase Auth（メール+PW / Google OAuth）
  Google の場合: /auth/callback (Route Handler) で exchangeCodeForSession
  → セッション確立（sb-* クッキー）
(owner) ルートグループ:
  middleware.ts（Edge）: createServerClient で supabase.auth.getUser() 確認、未ログインは /login へ
  Server Component: supabase.auth.getUser() + ルームの owner_user_id 一致確認（不一致は redirect/notFound）
  WS接続: join.token に Supabase アクセストークン → WSサーバーが supabaseAdmin.auth.getUser(token) で検証
```

### ゲスト認証（ゲストクッキー）

- Supabase の匿名認証は**使わない**。自前の署名付きクッキーで Supabase セッションと完全分離する（Next.jsスペシャリスト助言 §5）。
- Cookie 名は `sb-*` と衝突しない `gtt_guest`。
- ペイロード: `{ roomId, participantId, exp }` の JWT（jose `SignJWT` / HS256 / `GUEST_COOKIE_SECRET`）。
- 属性: `HttpOnly; Secure; SameSite=Lax; Path=/`（NFR-1.3）。
- `participantId` に DB の安定 ID（`participants.id`）を載せ、再接続・再開時の同一参加者復帰に使う（FR-3.2 / FR-12.3、[db-design.md](./db-design.md#participants参加者) 参照）。
- 有効期限はルームのライフサイクルに合わせる（例: 作成から24〜48時間）。
- 検証ロジックは `shared/auth/guestToken.ts` に置き、**Next.js 側と WSサーバー側の両方が同一実装を参照**する（二重管理・実装差異を防ぐ）。

### ゲストクッキー（`shared/auth/guestToken.ts`）

```ts
// 設計指針（jose のみ依存。Edge/Node 両対応）
import { SignJWT, jwtVerify } from "jose";
const secret = new TextEncoder().encode(process.env.GUEST_COOKIE_SECRET);

export async function signGuestToken(p: { roomId: string; participantId: string; expSec: number }) {
  return new SignJWT({ roomId: p.roomId, participantId: p.participantId })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime(`${p.expSec}s`).sign(secret);
}
export async function verifyGuestToken(token: string) {
  const { payload } = await jwtVerify(token, secret); // 期限切れ/改竄は例外
  return payload as { roomId: string; participantId: string };
}
```

- **jose のみ使用**。`jsonwebtoken` / `bcrypt` / `bcryptjs` は使わない（Edge Runtime 非対応・実装統一のため）。
- `GUEST_COOKIE_SECRET` は Next.js と WSサーバーで同一値を共有（サーバー専用 env、`NEXT_PUBLIC_` 禁止）。

---

## Edge Runtime 制約

`middleware.ts` は Edge Runtime で動くため、Node 版 `crypto` / `fs` 等は使用不可。これを設計制約として明記する。

| 用途 | 実行場所 | ライブラリ |
|---|---|---|
| Supabase セッション refresh/確認 | `middleware.ts`（Edge） | `@supabase/ssr`（fetchベース、Edge対応） |
| ゲストクッキーの署名/検証 | middleware でも Route Handler / Server Component でも | **`jose` のみ**（Edge/Node 両対応） |
| WSサーバー側の同トークン検証 | `server/`（Node.js） | 同じ `shared/auth/guestToken.ts` |

- `middleware.ts` の `matcher` は **オーナー領域のみ**（`/rooms/:path*`, `/history/:path*`）。`(public)`（`/login`, `/join/*`, `/room/*`, `/auth/callback`）は対象外。ゲスト検証は各ページの Server Component（Node.js Runtime）で行う。
- middleware でエラーは `console.error` でログし握りつぶさない。未ログインは `/login` へ redirect。
- GCE デプロイのため Vercel 専用機能（Edge Middleware の高度な依存）に寄りかからない（CLAUDE.md 固有ルール）。middleware は Supabase セッション確認の最小用途に留める。

---

## GCP/LLM 認証情報のサーバー限定

| 原則 | 実装 |
|---|---|
| GCP client library はサーバーのみ | `@google-cloud/*` を import するのは `server/gcp/` のみ。`src/` からは一切 import しない |
| LLM APIキーはサーバーのみ | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` を WSサーバー / Route Handler のサーバー env にのみ置く |
| バンドル混入防止 | `server/` を Next.js の `tsconfig.json` include から除外（[app-architecture.md](./app-architecture.md#tsconfig-分離方針) 参照） |
| service_role キー | WSサーバー / 一部 Route Handler のみ（RLS バイパス、[supabase-design.md](./supabase-design.md#service_role-の使用箇所) 参照） |

ブラウザが GCP / LLM に到達する経路は無い（WS / Route Handler 経由のサーバーのみ）。

---

## 環境変数と認証情報の扱い

- `NEXT_PUBLIC_` を付けた変数はブラウザバンドルに埋め込まれる。**付けてよいのは公開可の値のみ**（Supabase URL/anon、WS URL）。
- **絶対に `NEXT_PUBLIC_` を付けない**: `GOOGLE_CLOUD_PROJECT`、`SUPABASE_SERVICE_KEY`、`GUEST_COOKIE_SECRET`、`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。
- 一覧は [infra-design.md](./infra-design.md#環境変数一覧) に集約。`.env*` はコミットしない（`.env.example` のみ）。

---

## WebSocket の取り扱い

- 本番は WSS（Caddy が TLS 終端、127.0.0.1:3001 は外部非公開、[infra-design.md](./infra-design.md#リバースプロキシcaddy--lets-encrypt) 参照）。
- **接続時認証を必須**にする: `join` を受けるまで他メッセージを受理しない。token 検証失敗は `fatal:true` で切断（[server-design.md](./server-design.md#接続時認証verifyparticipant) 参照）。
- 受信メッセージ（client → server）は zod で検証。不正は `error`（`fatal:false`）で拒否。
- `audio.data` は base64 文字列のみ受理。極端に大きいフレームは拒否してよい（DoS 緩和）。
- Origin チェック: 本番は許可 Origin を検証してよい（同一ホスト）。MVP では最小限。

---

## プライバシー（音声・履歴）

- **音声は永続保存しない**（NFR-1.4）。STT/TTS はリアルタイム処理にのみ用い、DB へはテキスト（原文・翻訳）と要約のみ書き込む（[db-design.md](./db-design.md#messages発話) 参照）。
- **履歴・要約の永続閲覧はオーナーのみ**（FR-9.3 / FR-11.3）。RLS で `owner_user_id = auth.uid()` に限定（[supabase-design.md](./supabase-design.md#rls-ポリシー) 参照）。ゲストへ永続閲覧手段を提供しない。
- 終了時要約はゲストにもその場表示（FR-11.3）だが、永続化された要約へゲストがアクセスする経路は作らない。

---

## エラー情報

- クライアントへ返す `error.message` に GCP/内部詳細・スタックトレース・認証情報を含めない（[server-design.md](./server-design.md#エラー処理プロトタイプ流用) 参照）。
- 詳細はサーバーのログにのみ出力。本番用ログ基盤は当面作らない（YAGNI）。

---

## 脆弱性対策（OWASP 準拠の要点）

| リスク | 対策 |
|---|---|
| アクセス制御の不備（Broken Access Control） | RLS でオーナー本人のデータに限定。トークルームは Server Component で所有者/ゲスト整合を検証。WS は join 時に token とルームの整合を確認 |
| 認証の不備 | Supabase Auth（PW ハッシュ・OAuth）。ゲストは署名付き JWT（改竄検知・期限）。jose で統一 |
| インジェクション | Supabase（パラメータ化クエリ）。生 SQL を避け supabase-js / RLS を利用。LLM プロンプトへの会話埋め込みは system で役割を固定し、指示注入の影響を限定 |
| 機密情報の露出 | `NEXT_PUBLIC_` の厳格運用。service_role/LLM/GCP 鍵をサーバー限定。`.env*` 非コミット |
| SSRF / 外部呼び出し | 外部呼び出しは GCP/LLM/Supabase の固定エンドポイントのみ。ユーザー入力で宛先を決めない |
| CSRF | 認証付き状態変更は Supabase セッション（SameSite）+ Route Handler / Server Action。ゲストクッキーは `SameSite=Lax` |
| 転送時の保護 | 全経路 HTTPS/WSS（Caddy + Let's Encrypt、NFR-1.1） |
| DoS（音声フレーム） | 過大フレーム拒否、接続あたりのセッション制御。厳密なレート制限は MVP 対象外だが器を残す |

### レビュー観点（セキュリティスペシャリスト）

- `src/`（クライアント側）に `@google-cloud/*` / LLM SDK の import が無いこと。
- `NEXT_PUBLIC_` が付いた GCP/service_role/LLM/ゲスト署名鍵の変数が無いこと。
- 鍵ファイル・`.env*` がコミット対象に含まれていないこと。
- RLS ポリシーが「オーナー本人のみ」を担保していること（`messages`/`summaries`/`rooms`）。
- ゲストクッキーが `HttpOnly; Secure; SameSite=Lax` であること。
- WS の join 前メッセージ拒否・token 検証失敗時の切断が実装されていること。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | GCP 認証情報のサーバー限定、HTTPS（トンネル/localhost）、WS の基本バリデーション（認証は最小） |
| Phase 2 | Supabase Auth、ゲストクッキー（jose）、middleware、RLS、WS 接続時認証、Caddy+Let's Encrypt |
| Phase 3 | 履歴/要約の RLS（オーナー限定）、LLM 認証情報のサーバー限定、プロンプト注入への配慮 |
