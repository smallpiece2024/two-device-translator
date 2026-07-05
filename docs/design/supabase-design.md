# Supabase設計（RLS / Auth / ゲストクッキー連携）

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [DB設計 (db-design.md)](./db-design.md)（テーブル定義・ER図）
- [セキュリティ設計 (security-design.md)](./security-design.md)（認証フロー・ゲストJWT）
- [サーバー設計 (server-design.md)](./server-design.md)（service_role 書き込み）
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-1 認証 / FR-2 招待 / FR-9 履歴）

---

## 方針

- **DB・認証は Supabase**。リアルタイム同期は使わない（**Supabase Realtime 不使用**、GCE 自前 WS で行う）。
- アクセスは `@supabase/ssr`（Next.js 側）と service_role（WSサーバー側）の2系統。
- **ゲストは Supabase Auth を使わない**。自前の署名付きクッキー（jose/HS256）で識別し、Supabase Auth のセッションと完全分離する（Supabase の匿名認証も使わない）。
- スキーマ・RLS・トリガーは Supabase CLI（`supabase/migrations/`）で管理し、コミットする。

---

## クライアント生成（`@supabase/ssr`）

Next.js 側は用途別に3つのクライアント生成関数を用意する（`src/lib/supabase/`）。

| ファイル | 用途 | 実行環境 | 権限 |
|---|---|---|---|
| `client.ts` | ブラウザ（ログインフォーム等） | クライアント | anon（RLS適用） |
| `server.ts` | Server Component / Route Handler / Server Action | Node.js | ユーザーセッション（RLS適用） |
| `middleware.ts` | `middleware.ts` からのセッション refresh | Edge | fetchベース（Edge対応） |

- Next.js 15: `cookies()` は非同期（`await cookies()`）。Server Component からは cookie 書き込み不可のため、書き込みは Route Handler / Server Action / middleware で行う。
- WSサーバー側は `@supabase/ssr` ではなく **service_role の supabase-js クライアント**（`server/db/supabaseAdmin.ts`）を1つ生成して使い回す。

---

## Auth 設定

### 認証プロバイダ（FR-1.1）

| 方式 | 用途 |
|---|---|
| Email + Password | オーナーのメール+パスワードログイン。パスワードは Supabase Auth がハッシュ化保存（NFR-1.5） |
| Google OAuth | オーナーの Google ログイン。コールバックは `/auth/callback`（Route Handler）で `exchangeCodeForSession` |

- Google OAuth の Client ID/Secret 等の具体設定は実装側に一任（要件§5.2）。リダイレクトURLに `/auth/callback` を登録する。
- ゲストは Auth 非対象（後述のクッキー識別）。

### Auth とプロファイル

- サインアップ成功時に `user_profiles` 行を作成する。方式は以下いずれか（実装で選択）:
  - DB トリガー（`auth.users` INSERT → `user_profiles` INSERT、`default_language='ja-JP'`, `plan_id='free'`）。
  - もしくは初回ログイン時に Route Handler で upsert。
- `user_profiles.id = auth.users.id`（1:1、[db-design.md](./db-design.md#user_profilesオーナー) 参照）。

---

## RLS ポリシー

全テーブルで RLS を有効化する。**オーナーは自分の所有データのみアクセス可**。ゲストは Supabase セッションを持たないため、**ゲストが関わる書き込み・参照は service_role（WSサーバー）または Route Handler 経由**で行い、匿名ロールに直接権限を与えない。

`auth.uid()` は Supabase セッションのユーザーID。以下は方針（実際の SQL は migration で定義）。

| テーブル | select | insert | update | delete |
|---|---|---|---|---|
| `user_profiles` | 本人（`id = auth.uid()`） | 本人（またはトリガー） | 本人 | 不可（MVP） |
| `plans` | 全ユーザー可（参照のみ） | 不可（seed） | 不可 | 不可 |
| `rooms` | `owner_user_id = auth.uid()` | `owner_user_id = auth.uid()` | 本人所有 | 本人所有 |
| `participants` | 所属ルームがオーナー本人 | **anon 直接不可**（service_role / Route Handler） | service_role | service_role |
| `messages` | 所属ルームがオーナー本人（履歴閲覧 FR-9.2） | **service_role のみ**（WSが書き込み） | 不可 | cascade |
| `summaries` | 所属ルームがオーナー本人（FR-11.2） | service_role のみ | 不可 | cascade |
| `invites` | 本人所有ルーム | 本人所有ルーム（Route Handler） | 本人所有 | 本人所有 |

### ポリシーの要点

- **GRANT（テーブルレベル権限）を RLS とセットで管理する（bd-882 で追加）**: Supabase CLI の新デフォルト（新規テーブルは Data API ロールへ自動公開されない）のため、RLS ポリシーだけではアクセスできず、migration 内で明示的な `GRANT` が必要（Postgres の仕様: GRANT＝テーブルレベル、RLS＝行レベルの二層で両方必要）。逆に GRANT はポリシーの範囲を超えて与えない（例: `participants` は authenticated へ select のみ GRANT。insert の GRANT なし＝ポリシーなしとの二重防御）。anon への書き込み GRANT・`to` 句省略（暗黙 PUBLIC）・`grant all` は禁止で、CI の静的ガード（`tests/unit/supabase/rls-policies.test.ts`）が全マイグレーション横断で検知する。
- **履歴・要約の永続閲覧はオーナーのみ**（FR-9.3 / FR-11.3）。`messages` / `summaries` の select は「そのルームの `owner_user_id = auth.uid()`」に限定。ゲスト向けの永続 select ポリシーは作らない。
- `messages` / `summaries` の insert は WSサーバーの service_role のみ（会話中の書き込み）。anon/authenticated には insert 権限を与えない。
- `participants` の作成（ゲスト参加）は Route Handler `POST /api/guest/join`（bd-jny で実装。エンドポイント名は当初案 `/api/invites/[token]` から変更、inviteToken はリクエストボディで受ける）が service_role で行う（ゲストは Supabase セッションを持たないため）。招待の有効性（存在・expires_at・room が active）は表示用の事前チェックとは別に Route Handler 内で再照合する（TOCTOU対策）。`gtt_guest` クッキーは httpOnly・sameSite=lax・maxAge=JWTのTTL（7日）で発行する。
- `invites.token` による参照は Route Handler / Server Component から service_role 相当で行い、`token` 照合ロジックを匿名ロールに開放しない。

### 参照用サブクエリ例（方針）

```sql
-- messages の select ポリシー（方針。migration で実装）
create policy "owner reads own room messages" on messages
  for select using (
    exists (
      select 1 from rooms r
      where r.id = messages.room_id and r.owner_user_id = auth.uid()
    )
  );
```

---

## ゲストのクッキー識別との連携

ゲストは Supabase Auth を使わず、自前の署名付きクッキーで識別する（Next.jsスペシャリスト助言 §5・[security-design.md](./security-design.md#ゲストクッキー) 参照）。

### 参加フロー（FR-2.3 / FR-2.4）

```text
QR読込 → /join/[token]
  Server Component: invites を token で照合（期限切れ/無効ならエラー画面）
    → 名前入力フォーム（Client Component）
      → POST /api/guest/join（Route Handler, Node.js Runtime。bd-jny で実装）
         1. token 再照合（期限・有効性）
         2. participants 行を作成（service_role）: role=guest, room_id, display_name, language=en-US
         3. ゲストJWT を発行: jose SignJWT { roomId, participantId, exp } / HS256 / GUEST_COOKIE_SECRET
         4. Set-Cookie: gtt_guest=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/
         5. /room/[roomId] へ redirect
```

- 生成した `participants.id` を JWT の `participantId` に載せ、再接続・再開時の同一参加者復帰に使う（FR-3.2 / FR-12.3）。
- `/room/[roomId]` の Server Component はゲストクッキーを検証（`jose` verify）し、`roomId`・`participantId` の整合を確認してから RoomClient へ最小 props を渡す（無ければ `/join` へ誘導）。
- WSサーバーは同じ `shared/auth/guestToken.ts` でトークンを検証する（[server-design.md](./server-design.md#接続時認証verifyparticipant) 参照）。Next.js と WS で検証実装を共有し二重管理を避ける。

### 再開（FR-12.3）

- オーナーが同じルームで再招待 → 新 invite 発行。ゲストデバイスに `gtt_guest` が残り、payload の `participantId` が既存 `participants` 行と一致すれば同一参加者として復帰（`present=true`）。
- クッキー期限切れ・別端末の場合は新規 participant として再参加。

---

## service_role の使用箇所

service_role キーは **RLS をバイパス**するため、露出すると全データにアクセス可能になる。使用は以下に限定し、キーは WSサーバープロセスと一部 Route Handler のサーバー環境変数（`SUPABASE_SERVICE_KEY`）にのみ置く（`NEXT_PUBLIC_` を絶対に付けない）。

| 使用箇所 | 目的 |
|---|---|
| WSサーバー `server/db/supabaseAdmin.ts` | 確定発話の `messages` 書き込み、`summaries` 書き込み、`rooms.status`/`participants.present` 更新、`join` 時の token 検証（`auth.getUser`） |
| Route Handler `POST /api/guest/join` | ゲスト `participants` 行作成（ゲストは Supabase セッションを持たないため）。実装は `src/lib/supabase/admin.ts`（`import "server-only"` 必須。CIの静的ガードが担保） |

- オーナー由来の通常操作（ルーム作成・一覧・履歴閲覧）は **service_role を使わず**、ユーザーセッション＋RLS で行う（最小権限）。
- service_role の使用はコードレビューで棚卸しする（[security-design.md](./security-design.md#脆弱性対策owasp準拠の要点) 参照）。

---

## マイグレーション運用

- `supabase/migrations/` に SQL を置き、Supabase CLI（`supabase db push` / `supabase migration new`）で管理。
- seed（`plans` の初期行）は `supabase/seed.sql` に置く。
- RLS ポリシー・トリガー（`user_profiles` 自動作成、`participants` の role CHECK）も migration に含める。
- ローカル開発は Supabase ローカルスタック（`supabase start`）を利用可。CI では実 Supabase を呼ばない（抽象化層でモック、CLAUDE.md CI 節）。
- **クラウド環境への適用手順（bd-fo6 で追加・厳守）**: `supabase db push`（migration適用）の直後に、**必ず `plans` の seed 投入まで行う**（`supabase/seed.sql` は `db reset` 時のローカル専用で、`db push` では実行されない）。`user_profiles.plan_id` は `plans.id` へのFK（default `'free'`）であり、`handle_new_user` トリガーが `plan_id='free'` でプロフィールを作成するため、**`free` プラン行が無いとサインアップ自体がFK違反で全滅する**。適用は冪等なSQL（`insert ... on conflict do nothing`）で行うこと。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | 最小（認証省略可）。ルーム/参加者は簡易でよい。RLS は Phase2 で本格化 |
| Phase 2 | Auth（Email+PW / Google）、`user_profiles`/`plans`、RLS ポリシー、ゲストクッキー発行フロー、invites |
| Phase 3 | `messages`/`summaries` の service_role 書き込みとオーナー履歴閲覧の RLS |
