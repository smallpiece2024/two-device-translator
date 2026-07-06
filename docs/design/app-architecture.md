# アプリ全体アーキテクチャ設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [WebSocketプロトコル設計 (websocket-protocol.md)](./websocket-protocol.md)
- [サーバー設計 (server-design.md)](./server-design.md)
- [GCP連携設計 (gcp-integration.md)](./gcp-integration.md)
- [DB設計 (db-design.md)](./db-design.md)
- [Supabase設計 (supabase-design.md)](./supabase-design.md)
- [フロントエンド設計 (frontend-design.md)](./frontend-design.md)
- [スタイリング設計 (styling-design.md)](./styling-design.md)
- [AIアシスタント設計 (ai-assistant-design.md)](./ai-assistant-design.md)
- [インフラ設計 (infra-design.md)](./infra-design.md)
- [セキュリティ設計 (security-design.md)](./security-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（§4 全体構成 / §5 技術スタック / §9 フェーズ）

---

## 目的とスコープ

2台のデバイスでそれぞれ別の言語を話すと、相手デバイスに相手言語で翻訳表示・発話される対面リアルタイム通訳ウェブサービス。プロトタイプ [`simple-translator`](../../../simple-translator)（1ブラウザ完結・ローカル専用）の Google Cloud STT/翻訳/TTS + Next.js + WebSocket 構成を継承し、以下を新規追加する。

- 2デバイス間のリアルタイム同期（ルーム・参加者・話者識別・配信ルーティング）
- 認証（Supabase Auth ＋ ゲスト署名クッキー）
- 会話履歴の永続化（Supabase PostgreSQL）
- AIアシスタント（話題提供・終了時要約）
- GCE 常時稼働デプロイ

MVP は 1対1（オーナー1＋ゲスト1）。データモデル・配信ルーティングは 1対多（1:N）へ拡張可能に設計する（要件§11⑧）。

---

## プロセス構成（単一 GCE VM 上の2プロセス）

Next.js アプリと自前 WebSocket サーバーを**別プロセス**で常時稼働させ、リバースプロキシ（Caddy）でパス振り分けする。Next.js のカスタムサーバー方式は採らない（プロトタイプ踏襲、Next.jsスペシャリスト助言 §6）。

```text
              [デバイスA: 話者]              [デバイスB: 聞き手]
                  マイク音声                   翻訳テキスト表示＋音声再生
                      │  WebSocket (wss)              ▲  WebSocket (wss)
                      ▼                               │
         ┌──────────────── GCE VM ────────────────────────────────┐
         │  Caddy (443, Let's Encrypt) — リバースプロキシ           │
         │    /ws*  → 127.0.0.1:3001 (WS)                           │
         │    それ以外 → 127.0.0.1:3000 (Next.js)                   │
         │                                                          │
         │  [プロセスA] Next.js standalone (127.0.0.1:3000)         │
         │    画面 / 認証UI / ルーム管理API / AI Route Handler      │
         │      │ supabase-js (RLS / service_role)                 │
         │  [プロセスB] WSサーバー (127.0.0.1:3001)                 │
         │    ルーム/セッション管理・発話区切り・配信ルーティング   │
         │      │ @google-cloud/* (STT/Translation/TTS)            │
         │      │ supabaseAdmin (service_role) 履歴書き込み         │
         │      │ LLMプロバイダ (要約/話題提供のサーバー呼び出し)   │
         └──────────────────────────────────────────────────────────┘
                      │                    │                 │
              Supabase(PostgreSQL/Auth)  Google Cloud    LLM(Claude/OpenAI)
```

デプロイ詳細は [infra-design.md](./infra-design.md) を参照。

### なぜ WS を独立プロセスにするか（プロトタイプ踏襲）

| 観点 | 説明 |
|---|---|
| 長時間双方向ストリーム | STT Streaming は長時間維持する gRPC 双方向ストリーム。HTTP Route Handler に不向き |
| ステートフル | ルーム・参加者・発話バッファ・STTストリームを接続横断で保持する必要がある |
| 認証情報の分離 | GCP/LLM の認証情報を Next.js バンドルから完全に分離する（[security-design.md](./security-design.md) 参照） |

---

## ディレクトリ構成（Next.jsスペシャリスト助言に準拠）

最大の変更点は **WSプロトコルの型・zodスキーマを Next.js と WSサーバーで共有する** ため `shared/` を新設すること。2デバイス間の契約であり型ドリフトが致命的になるため。

```text
two-device-translator/
├── src/
│   ├── app/
│   │   ├── (public)/                    # 認証不要ルートグループ
│   │   │   ├── login/page.tsx
│   │   │   ├── join/[token]/page.tsx    # ゲスト参加（招待トークン）
│   │   │   └── room/[roomId]/page.tsx   # ゲスト用トークルーム
│   │   ├── (owner)/                     # 認証必須ルートグループ
│   │   │   ├── layout.tsx               # Server Componentで認証チェック
│   │   │   ├── rooms/{page,new/page,[roomId]/page}.tsx
│   │   │   └── history/{page,[roomId]/page}.tsx
│   │   ├── auth/callback/route.ts       # Supabase OAuth callback
│   │   ├── api/
│   │   │   ├── rooms/{route,[roomId]/route}.ts
│   │   │   ├── invites/{route,[token]/route}.ts # ゲストクッキー発行
│   │   │   └── ai/{topic,summary}/route.ts
│   │   ├── layout.tsx / globals.css
│   ├── components/{ui,chat,room}/
│   ├── hooks/                           # useRecorder, useWebSocket, useAudioQueue
│   ├── lib/
│   │   ├── supabase/{client,server,middleware}.ts
│   │   ├── auth/guestCookie.ts          # shared/auth を薄くラップ
│   │   └── validators/
│   └── types/
├── shared/                              # ★ src/ と server/ の両方が参照（依存最小限: zod, jose のみ）
│   ├── ws-protocol/{schema,types}.ts    # WSメッセージ zod 定義（client⇄server 共通）
│   ├── auth/guestToken.ts               # jose 署名/検証（Edge/Node 両対応）
│   └── languages.ts                     # 言語レジストリ
├── server/                              # 自前WSサーバー
│   ├── index.ts
│   ├── room/{roomManager,session,utteranceBuffer}.ts
│   ├── gcp/{speechStream,translate,textToSpeech}.ts
│   ├── db/supabaseAdmin.ts              # service_role で履歴書き込み
│   ├── auth/verifyParticipant.ts
│   └── ai/llmProvider.ts
├── tests/{unit,integration,e2e}
├── tsconfig.json                        # include: src/**, shared/**
├── tsconfig.server.json                 # include: server/**, shared/**
└── next.config.ts                       # output: 'standalone'
```

### `shared/` の制約

- Node組み込みAPI・Next.js専用APIに依存させない（**zod・jose のみ許可**）。`src/` からも `server/` からも同一の型/検証を安全に import できる。
- パスエイリアス `@shared/*` を `tsconfig.json`・`tsconfig.server.json` の両方に設定する。

### tsconfig 分離方針

- `tsconfig.json`（Next.js/web）: `include: src/**, shared/**`。`server/` を除外し、`@google-cloud/*` をバンドル対象・型解決対象に入れない。
- `tsconfig.server.json`（WSサーバー）: `include: server/**, shared/**`。本番は `tsc -p tsconfig.server.json` で `dist-server/` へビルド。
- npm スクリプト `typecheck`（web）/ `typecheck:server`（server）を分離（CLAUDE.md CI節・[infra-design.md](./infra-design.md#環境変数一覧) 参照）。

---

## Next.js ページ構成とルーティング

オーナー用（Supabaseセッション）とゲスト用（署名付きクッキー）で**認証方式が根本的に違う**ため、ルートグループごとに認可境界を分ける。

| パス | 認可 | 実装 |
|---|---|---|
| `/login` | 公開 | オーナーログイン（メール+PW / Google OAuth） |
| `/auth/callback` | 公開 | Supabase OAuth コールバック（Route Handler） |
| `/join/[token]` | 公開 | 招待トークン検証→名前入力→ゲストクッキー発行→`/room/[roomId]` へ redirect |
| `/room/[roomId]` | 公開（ゲストクッキー必須） | ゲスト用トークルーム。無ければ `/join` へ誘導 |
| `/rooms` | 認証必須 | オーナーのルーム一覧 |
| `/rooms/new` | 認証必須 | ルーム作成（Server Action） |
| `/rooms/[roomId]` | 認証必須＋所有者確認 | オーナー用トークルーム |
| `/history` `/history/[roomId]` | 認証必須＋所有者確認 | 会話履歴 |

- ルートグループ `(owner)` にのみ `middleware.ts` の `matcher`（`/rooms/:path*`, `/history/:path*`）をかける。`(public)` 配下はミドルウェア対象外とし、ゲスト検証は各ページの Server Component（Node.js Runtime）で行う。
- Next.js 15: `cookies()` / `headers()` / `params` / `searchParams` は非同期（`await`）。全 dynamic route で対応する。
- 認証フロー詳細は [security-design.md](./security-design.md)、招待URL設計は [db-design.md](./db-design.md#invite招待) を参照。

---

## Client/Server Component 境界とデータ取得

**方針: 会話中のリアルタイム情報は WS が唯一の情報源、Supabase は永続化と非リアルタイム閲覧専用**。会話中に Supabase へポーリングしない。

| 画面 | 種別 | データ取得 |
|---|---|---|
| `/login` | Server Component 外枠 + Client Component フォーム | Supabase Auth 操作はクライアント |
| `/rooms`（一覧） | Server Component | Supabase Server Client で直接クエリ |
| `/rooms/new` | Server Component + Server Action | 作成は Server Action → 書き込み → redirect |
| トークルーム | Server Component（認証/認可＋メタ取得のみ）→ Client Component へ委譲 | 会話内容は **WS のみ** |
| `/history` 系 | Server Component | Supabase Server Client でページング取得 |

- Supabase 統合は `@supabase/ssr`。server/client/middleware 用に3つのクライアント生成関数を用意（[supabase-design.md](./supabase-design.md#クライアント生成) 参照）。
- **`"use server"` ファイル（Server Action）は async 関数以外を export しない**（bd-2el）。Next.js の**本番ランタイムのみ**がこの制約を強制するため（dev / `next build` / Jest では検出されない）、オブジェクト定数や型初期値を export すると本番でのみモジュール読込時にページ全体がクラッシュする。`useActionState` の初期値・状態型は別モジュール（例: `state.ts`）に分離する。静的ガード: `tests/unit/use-server-exports.test.ts`。
- トークルーム画面は「Server Component でガード＋最小限 props を渡し、あとは1枚の Client Component（`RoomClient`）に閉じ込める」構成。プロトタイプの `TranslatorApp.tsx`（reducer駆動）を拡張する（[frontend-design.md](./frontend-design.md#roomclient最上位-client-component) 参照）。
- トークルーム画面が Client へ渡す最小 props: `roomId, participantId, role(owner|guest), selfLanguage, wsUrl, wsAuth(token)`。認可判定ロジックはクライアントに持たせない。

---

## 状態管理方針

外部状態管理ライブラリ（Redux/Zustand/Context）は使わない。`useReducer` + `useState` + カスタムフックで構成する（プロトタイプ継承）。

- トークルーム画面の全状態は `RoomClient` 内 `useReducer` に集約する。プロトタイプの単一話者モデルから**参加者×メッセージのタイムライン**へ拡張する（[frontend-design.md](./frontend-design.md#状態管理reducer) 参照）。
- WS 受信メッセージを reducer にディスパッチし、子コンポーネントへ props で配る。

---

## フロント / WSサーバーの責務分担

| 関心 | 担当 |
|---|---|
| マイク入力・音声チャンク生成・WS送受信・音声再生・チャットUI | フロント（`RoomClient` 配下） |
| ルーム作成・招待発行・履歴閲覧・AI話題提供/要約の起動 | Next.js Route Handler / Server Action |
| ルーム/セッション/参加者/話者識別・発話区切り・翻訳ルーティング・履歴書き込み・不在/終了判定 | WSサーバー |
| STT/Translation/TTS 呼び出し・LLM 呼び出し（要約/話題提供の推論） | WSサーバー / Next.js（AIは両系統あり、[ai-assistant-design.md](./ai-assistant-design.md#実行経路) 参照） |
| 永続化（PostgreSQL）・認証（セッション/RLS） | Supabase |

---

## フェーズ対応

| フェーズ | 本ドキュメントの対象要素 |
|---|---|
| Phase 1 | 2プロセス構成、`shared/` と型共有、`RoomClient` の骨格、WS 接続、`(public)/room/[roomId]` の簡易版（認証最小） |
| Phase 2 | ルートグループ `(owner)`/`(public)` 分離、middleware、Supabase 統合、招待・ゲストクッキー |
| Phase 3 | `/history` 系画面、AI Route Handler、要約表示の統合 |
