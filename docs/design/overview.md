# 設計概要（overview）

two-device-translator の設計ドキュメント群のエントリーポイント。ワークフロー分割時は本ドキュメントを最初に読む。

---

## ドキュメント一覧

| ドキュメント | 内容 |
|---|---|
| [app-architecture.md](./app-architecture.md) | 全体構成、Next.js ページ構成（ルートグループ）、状態管理、フロント/WSサーバーの責務分担、`shared/` レイヤ |
| [websocket-protocol.md](./websocket-protocol.md) | WSメッセージ仕様（join/start/audio/commit/stop、message/participant/summary 等）、zodスキーマ |
| [server-design.md](./server-design.md) | WSサーバー処理（ルーム/セッション/話者識別・発話区切り・配信ルーティング・再接続・不在/終了・履歴書き込み） |
| [gcp-integration.md](./gcp-integration.md) | STT(Streaming)/Translation/TTS 実装方針、音声形式、言語検出モード、ADC/サービスアカウント |
| [db-design.md](./db-design.md) | スキーマ（User/Room/Participant/Message/Summary/Invite）、ER図、インデックス戦略 |
| [supabase-design.md](./supabase-design.md) | RLS、Auth（メール+PW/Google）、ゲストクッキー連携、service_role の使用箇所 |
| [frontend-design.md](./frontend-design.md) | コンポーネント設計（ChatTimeline/Recorder/LanguageSelector/TTSToggle/QRDisplay/AIAssistantPanel/SettingsPanel）、LINE風UI、reducer 状態管理 |
| [styling-design.md](./styling-design.md) | CSS Modules デザイントークン、チャットレイアウト、モバイルファースト |
| [ai-assistant-design.md](./ai-assistant-design.md) | LLM プロバイダ抽象化（Claude/OpenAI）、話題提供・終了時要約のプロンプトとトリガー、コスト管理 |
| [infra-design.md](./infra-design.md) | GCE デプロイ（pm2/Caddy/Let's Encrypt/standalone）、環境変数一覧、CI（CD は対象外） |
| [security-design.md](./security-design.md) | 認証フロー（Supabase Auth＋ゲストJWT）、Edge Runtime 制約、GCP/LLM 認証情報のサーバー限定、OWASP 要点 |

要件定義: [docs/requirements.md](../requirements.md)（§11 確定事項は変更不可の前提）

---

## 要件の要約

2台のデバイスでそれぞれ別言語を話すと、相手デバイスに相手言語で翻訳表示・（トグルON時）発話される、対面向けリアルタイム通訳ウェブサービス。見た目は2人のLINE風チャット。

- 各デバイスは会話全体を**自分の言語**で表示（自分の発話は原文、相手の発話は翻訳）。TTS ON 時は相手の翻訳音声のみ再生。
- オーナー（要ログイン）がルームを作成・QR招待し、ゲスト（アカウント不要・クッキー識別）が参加。会話履歴はオーナーが振り返れる。
- AIアシスタント（話題提供・終了時要約）を提供。
- **MVP は 1対1**、データモデル・配信ルーティングは **1:N 拡張可能**に設計（要件§11⑧）。
- 技術検証プロトタイプ `simple-translator`（Google Cloud STT/翻訳/TTS + Next.js + WebSocket）を継承し、2デバイス対応・認証・履歴永続化・AI を追加。

---

## 全体アーキテクチャ方針

- **単一 GCE VM 上で2プロセス常時稼働**: Next.js（standalone, 127.0.0.1:3000）と自前 WSサーバー（127.0.0.1:3001）。Caddy（Let's Encrypt）が HTTPS 終端し `/ws*` を WS、それ以外を Next.js へ振り分ける。**Vercel は使わない**（常時接続 WS ＋ ストリーミング STT のため）。
- **リアルタイムは WS が唯一の情報源、Supabase は永続化と非リアルタイム閲覧専用**。会話中に DB をポーリングしない。Supabase Realtime は使わない。
- **型・zodスキーマ・言語レジストリ・ゲストJWT検証を `shared/` に集約**し、Next.js と WSサーバーで共有（2デバイス間契約の型ドリフト防止）。依存は zod・jose のみ。
- **認証情報はサーバー限定**: GCP client library・LLM SDK・service_role キー・ゲスト署名鍵をブラウザに渡さない（`NEXT_PUBLIC_` 厳格運用）。
- **認証は2系統**: オーナー=Supabase Auth（`(owner)` ルートグループ＋middleware）、ゲスト=自前署名クッキー（`(public)` ＋各ページ Server Component 検証）。
- **配信ルーティングは1:N前提**: 確定発話を「送信先言語ごとに1回」翻訳して各聞き手へ配信。翻訳は言語別 JSONB で保存。MVP は聞き手1人。
- **音声は永続化しない**。翻訳・TTS は確定発話単位。interim は表示のみ。

アーキテクチャ図は [app-architecture.md](./app-architecture.md#プロセス構成単一-gce-vm-上の2プロセス) を参照。

---

## Phase と設計の対応表

| フェーズ | 主眼 | 主に関わる設計 |
|---|---|---|
| **Phase 1: コア翻訳** | 2デバイス間のリアルタイム双方向翻訳（ja⇔en）。認証は最小 | app-architecture（2プロセス・shared・RoomClient）／websocket-protocol（join/start/audio/message）／server-design（RoomManager・発話区切り・2者ルーティング）／gcp-integration（STT/翻訳/TTS）／frontend-design（ChatTimeline/Recorder）／styling-design（3層レイアウト） |
| **Phase 2: 認証・ルーム・QR** | オーナーログイン、正式ルーム管理、QR招待、ゲストクッキー、名前、言語自動検出、不在/再開、プラン器 | supabase-design（Auth/RLS/ゲスト連携）／db-design（user_profiles/plans/invites/participants）／security-design（認証フロー/Edge制約/ゲストJWT）／infra-design（GCE/Caddy/pm2/SA）／server-design（verifyParticipant/再接続/自動終了/言語検出）／frontend-design（login/join/QR/SettingsPanel） |
| **Phase 3: AI・履歴・要約** | 履歴永続保存とオーナー振り返り、AI話題提供、終了時要約、プロバイダ切替 | ai-assistant-design（LLM抽象化/プロンプト/トリガー）／db-design（messages/summaries）／server-design（履歴書き込み/終了要約/idle_hint）／frontend-design（AIAssistantPanel/history）／supabase-design（履歴RLS） |

各設計ドキュメント末尾に「フェーズ対応」節を設け、要素単位のフェーズを明示している。

---

## 設計上の判断（要件で未確定だった点の決定記録）

要件§11 の確定8件は前提として遵守。以下は設計フェーズで具体化・判断した事項。要件と整合する範囲で決定し、以降の実装の拠り所とする。

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D-1 | WS 接続時の認証の渡し方 | 接続後の最初のメッセージ `join` のボディで token を渡す。`join` まで他メッセージを受理しない | URLクエリに token を載せるとプロキシ/アクセスログに残る。ボディなら残りにくい（[websocket-protocol.md](./websocket-protocol.md#接続)） |
| D-2 | 翻訳先の決定方法 | クライアントは `targetLanguage` を送らず、**サーバーがルーム内の各聞き手の言語から翻訳先を決定**。翻訳は「送信先言語ごとに1回」 | 1:N 拡張時に聞き手ごとの言語へ配信するため。話者は宛先を知らなくてよい（[server-design.md](./server-design.md#翻訳と配信ルーティング1n拡張の中核)） |
| D-3 | 表示の解決場所 | サーバーが受信者ごとに `displayText` を解決して配信。クライアントは自分/相手の分岐や翻訳選択をしない | FR-8.2（各デバイスは自分の言語で表示）をサーバー側で確定し、クライアントを単純化 |
| D-4 | メッセージ翻訳の保存形式 | `messages.translations` を **言語別 JSONB**（`{ "en-US": "..." }`）。発生した送信先言語のみ格納 | 多言語・N人に素直に拡張でき、未使用言語を作らない（YAGNI、[db-design.md](./db-design.md#messages発話)） |
| D-5 | ゲスト識別の実装 | Supabase 匿名認証を使わず自前署名クッキー `gtt_guest`（jose/HS256、payload `{roomId, participantId, exp}`）。検証は `shared/auth/guestToken.ts` で Next.js/WS 共有 | Supabase セッションと分離、Edge/Node 両対応、二重実装回避（Next.jsスペシャリスト助言§5、[security-design.md](./security-design.md#ゲスト認証ゲストクッキー)） |
| D-6 | 話題提供の実行経路 | **Next.js Route Handler `POST /api/ai/topic`**（DB の messages を読む）。要約は **WSサーバーの終了シーケンス**内 | 話題提供はオーナーのボタン=HTTP境界で認可でき、確定発話はDB保存済み。要約は終了時点の会話をサーバーが保持（[ai-assistant-design.md](./ai-assistant-design.md#実行経路)） |
| D-7 | アイドル時のAI呼び出し | `idle_hint` はボタン強調のみで **LLM を呼ばない**。呼び出しはボタン押下時だけ | FR-10.4／要件§11⑤（コスト予測可能性） |
| D-8 | 不在と終了の区別 | 接続 close は `present=false`（ランタイム保持・再接続待ち）。present が1人のまま `autoEndThresholdMs` 継続で自動終了。明示終了はオーナーの `request_end` | FR-12.2 の一時断/終了の区別。しきい値は設定可能（[server-design.md](./server-design.md#不在終了判定)） |
| D-9 | 言語検出モードの実装 | `start.detectLanguage=true` のとき STT の `alternativeLanguageCodes` で判定→最初の final の `languageCode` を採用し以後固定。トグルは自動 OFF | FR-4.3／要件§11②（常時再判定しない） |
| D-10 | WS 本番実行方式 | 開発は `tsx --watch`、本番は `tsc` ビルド済み JS を `node` 実行。web は `output: 'standalone'` | 起動安定性・依存最小化（[infra-design.md](./infra-design.md#ビルドと出力)） |
| D-11 | ゲスト書き込みの権限 | ゲストの `participants` 作成・`messages`/`summaries` 書き込みは service_role（WS / Route Handler）。anon に insert 権限を与えない | ゲストは Supabase セッションを持たないため。RLS はオーナー閲覧に限定（[supabase-design.md](./supabase-design.md#rls-ポリシー)） |
| D-12 | CD の扱い | **CD は当面導入しない**。デプロイは手動（`git pull`→build→`pm2 reload`） | CLAUDE.md CI 節に整合。手動が苦になってから検討（YAGNI） |
| D-13 | プラン/人数上限 | `plans.max_participants` の器のみ用意し、MVP は実質無制限。課金処理なし | FR-13。将来の1:N/有償化の拡張点を残す |

いずれも要件を変更するものではなく、要件の範囲内での具体化。実装過程で見直す場合は本表を更新する。

---

## 実装の起点（推奨）

1. Phase1 雛形: `shared/`（型・zod・languages）→ `server/`（RoomManager/session/gcp、プロトタイプ流用）→ `RoomClient`。package.json に5つの npm スクリプトを定義（[infra-design.md](./infra-design.md#npm-スクリプト雛形定義対象)）。
2. Phase2: Supabase（Auth/RLS/migration）→ 認証フロー（middleware/ゲストクッキー）→ ルーム/招待/QR。
3. Phase3: DB 書き込み → AI（話題提供/要約）→ 履歴画面。
