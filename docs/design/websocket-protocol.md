# WebSocketプロトコル設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [サーバー設計 (server-design.md)](./server-design.md)
- [GCP連携設計 (gcp-integration.md)](./gcp-integration.md)
- [フロントエンド設計 (frontend-design.md)](./frontend-design.md)
- [セキュリティ設計 (security-design.md)](./security-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-3 話者識別 / FR-7 翻訳 / FR-11 要約 / FR-12 終了）

---

## プロトタイプからの差分（要点）

プロトタイプ [`simple-translator` の websocket-protocol.md](../../../simple-translator/docs/design/websocket-protocol.md) は**1接続=1話者セッション**で送信元/送信先が固定だった。本サービスは**1接続=ルーム内の1参加者**であり、複数参加者間でメッセージをルーティングする。主な拡張:

1. 接続直後に `join`（認証トークン＋自分の設定）を必須化。`start` は録音開始のトリガーへ縮小。
2. サーバー→クライアントのメッセージに `participantId` / `messageId` を付与し、誰の発話かを識別。
3. 翻訳結果は **聞き手ごとの言語** に配信（1:N拡張のため翻訳は言語別）。各デバイスは自分の言語のメッセージのみ受信。
4. 参加者イベント（`participant_joined` / `participant_left` / `participant_updated`）、要約（`summary`）、アイドルヒント（`idle_hint`）、ルーム終了（`room_ended`）を追加。
5. 言語検出モード（`detectLanguage`）を `start` に追加。

---

## 接続

| 項目 | 値 |
|---|---|
| エンドポイント | `wss://{host}/ws`（開発 `ws://localhost:3001/ws`） |
| クライアントの取得元 | `NEXT_PUBLIC_WS_URL`（Caddy が `/ws*` を WSサーバーへプロキシ） |
| サーバーの待受 | `WS_PORT`（既定 3001、127.0.0.1 のみ） |
| メッセージ形式 | UTF-8 JSON テキストフレーム。音声は base64 で JSON に格納（バイナリフレーム不使用） |
| 認証 | 接続直後の `join` メッセージで token を渡す（下記）。URLクエリには秘匿情報を含めない |

**認証の受け渡し（設計判断）**: WS 接続URLに token を載せるとプロキシログ等に残るため、接続後最初に送る `join` メッセージのボディに token を含める。サーバーは `join` を受けるまで他メッセージを受理しない。オーナーは Supabase アクセストークン、ゲストは自身のゲストクッキー由来の JWT を渡す（[server-design.md](./server-design.md#接続時認証verifyparticipant) 参照）。

---

## メッセージ全体像

| 方向 | type | 用途 | フェーズ |
|---|---|---|---|
| client → server | `join` | ルーム参加・認証・自分の設定 | 1 |
| client → server | `start` | 録音セッション開始（言語・区切り設定・言語検出） | 1 |
| client → server | `audio` | 音声チャンク送信 | 1 |
| client → server | `commit` | 手動の発話区切り | 1 |
| client → server | `stop` | 録音セッション停止 | 1 |
| client → server | `update_settings` | TTS の変更通知（Phase1 は enableTts のみ。言語/表示名は Phase2）（bd-124.3 で前倒し） | 1 |
| client → server | `request_end` | オーナーによるルーム終了要求 | 2/3 |
| server → client | `joined` | 参加確定（自分の participantId・ルーム状態・参加者一覧） | 1 |
| server → client | `participant_joined` / `participant_left` | 参加者の入退室イベント（bd-124.3 で前倒し。在室中の他参加者へ配信） | 1 |
| server → client | `participant_updated` | 参加者の設定変更イベント | 2 |
| server → client | `transcript_interim` | 認識途中結果（話者本人にのみ・表示専用） | 1 |
| server → client | `transcript_final` | 認識確定結果（話者本人にのみ） | 1 |
| server → client | `utterance_committed` | 発話区切り確定（話者本人にのみ） | 1 |
| server → client | `message` | 確定発話（原文＋受信者言語への翻訳）。全参加者へ配信 | 1 |
| server → client | `audio` | 合成音声（mp3 base64）。TTS ON の聞き手へ | 1 |
| server → client | `idle_hint` | 一定時間発話なし（オーナーへ話題提供ボタン強調用） | 3 |
| server → client | `summary` | 終了時要約（両者へ表示） | 3 |
| server → client | `room_ended` | ルーム終了通知（全参加者へ） | 2/3 |
| server → client | `error` | エラー通知 | 1 |

すべてのメッセージは `type: string` を必ず持つ。型・zodスキーマは `shared/ws-protocol/{schema,types}.ts` に集約し、Next.js と WSサーバーの双方が import する（型ドリフト防止、[app-architecture.md](./app-architecture.md#shared-の制約) 参照）。

---

## client → server メッセージ

### `join`（ルーム参加・認証）

```json
{
  "type": "join",
  "roomId": "b1f2...",
  "role": "owner",
  "token": "<Supabase access token または ゲストJWT>",
  "displayName": "Taro",
  "language": "ja-JP"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `roomId` | `string` | ○ | 参加するルームID |
| `role` | `"owner" \| "guest"` | ○ | 認証方式の分岐に使う |
| `token` | `string` | ○ | owner=Supabaseアクセストークン、guest=ゲストJWT |
| `displayName` | `string` | △ | 表示名（未設定可、FR-5.1） |
| `language` | `LanguageEnum` | ○ | 自分の話す言語の初期値（owner=個人設定、guest=en-US、FR-4.2） |
| `enableTts` | `boolean` | △ | 聞き手としてTTS音声を受け取るかの初期値（省略時 `true`）。以後の変更は `update_settings`（bd-124.3 で追加） |

サーバーは token を検証し、`roomId` と `participantId` の整合を確認して `joined` を返す（[server-design.md](./server-design.md#接続時認証verifyparticipant) 参照）。

### `start`（録音セッション開始）

```json
{
  "type": "start",
  "sourceLanguage": "ja-JP",
  "detectLanguage": false,
  "enableTts": true,
  "chunkMs": 250,
  "silenceMs": 1000,
  "maxChars": 80,
  "maxSeconds": 10
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `sourceLanguage` | `LanguageEnum` | ○ | 自分の話す言語（`join.language` と一致が既定。変更時は先に `update_settings`） |
| `detectLanguage` | `boolean` | △ | 言語検出モード（FR-4.3）。true のとき STT の複数言語候補で判定。省略時 false |
| `enableTts` | `boolean` | ○ | **自分が聞き手として TTS を受け取るか**。クライアントが言語別設定を boolean へ解決して送る |
| `chunkMs` / `silenceMs` / `maxChars` / `maxSeconds` | `number` | ○ | 発話区切りしきい値（初期 250/1000/80/10、FR-7.6・NFR-5.2） |

> プロトタイプの `targetLanguage` は本サービスでは送らない。翻訳先は**サーバーがルーム内の各聞き手の言語から決定**する（[server-design.md](./server-design.md#配信ルーティング) 参照）。`detectLanguage` は要件 FR-4.3 を制御するため追加。

### `audio`（音声チャンク）

```json
{ "type": "audio", "data": "GkXfo59...(base64 WebM/Opus)" }
```

MediaRecorder の Blob を base64 化（WebM/Opus 48kHz）。STTストリームはセッション中切り直さない（コンテナヘッダは最初のチャンクのみ、[gcp-integration.md](./gcp-integration.md#stt-ストリーム維持) 参照）。

### `commit` / `stop`

```json
{ "type": "commit" }   // 現在の発話バッファを即時確定（空なら無視）
{ "type": "stop" }     // 残バッファを確定→STTストリーム終了（接続は維持）
```

### `update_settings`（設定変更）

```json
// Phase1（bd-124.3 で前倒し実装）: enableTts のみ
{ "type": "update_settings", "enableTts": false }
// Phase2 拡張形: 言語・表示名も変更可能にし、他参加者へ participant_updated を配信する
{ "type": "update_settings", "language": "en-US", "enableTts": false, "displayName": "Taro" }
```

設定変更をサーバーへ通知する。**Phase1 では `enableTts` のみ**（聞き手としてTTS音声を受け取るか。サーバーはセッションの enableTts を更新し、以後の `audio` 配信に反映。応答・配信なし）。Phase2 で言語・表示名に拡張し、`participant_updated` を配信する。録音中の言語変更は次の `start` から反映（MVP。プロトタイプ方針を継承）。

### `request_end`（ルーム終了）

```json
{ "type": "request_end" }
```

**オーナーのみ**送信可能。サーバーはルームを `ended` にし、要約を生成して両者へ `summary` を配信、`room_ended` を全参加者へ送る（FR-11.3 / FR-12.1）。ゲストが送った場合は `error`（`fatal:false`）。

### `playback_state`（再生状態通知、bd-rwi）

```json
{ "type": "playback_state", "playing": true }
```

自デバイスのTTS再生状態（audioPlaybackQueue の再生開始/停止）をサーバーへ通知する。サーバーは同室の**他**参加者へ `peer_playback_state` として中継する（送信者本人には返さない。状態の永続化・サーバー側保持はしない）。

対面利用では相手端末のスピーカー音を自分のマイクが拾い、「翻訳音声→発話として誤認識→翻訳→再生→…」の音響フィードバックループが発生しうる（本番実機で確認）。受信側は相手の再生中＋残響猶予の間、自分の**マイクトラックを一時ミュート**する（**相互半二重**。`audio` チャンクの送信自体は無音のまま継続する — 送信を止めるとSTTが Audio Timeout するため。bd-dnh。[frontend-design.md「TTSと録音の半二重制約」](./frontend-design.md#ttstoggle) 参照）。

---

## server → client メッセージ

### `joined`（参加確定）

```json
{
  "type": "joined",
  "participantId": "p_123",
  "room": { "id": "b1f2...", "status": "active" },
  "participants": [
    { "participantId": "p_123", "role": "owner", "displayName": "Taro", "language": "ja-JP", "present": true },
    { "participantId": "p_456", "role": "guest", "displayName": "John", "language": "en-US", "present": true }
  ],
  "recentMessages": []
}
```

`recentMessages` は再接続時に直近のタイムラインを受信者言語で復元するための任意配列（MVP は空でよい。Phase3 で有効化）。

### 参加者イベント

```json
{ "type": "participant_joined", "participant": { "participantId": "p_456", "role": "guest", "displayName": "John", "language": "en-US", "present": true } }
{ "type": "participant_left", "participantId": "p_456" }
{ "type": "participant_updated", "participantId": "p_456", "displayName": "John", "language": "en-US" }
```

`participant_joined` / `participant_left` は **Phase1 実装済み**（bd-124.3 で前倒し。join成功時・切断時に在室中の他参加者へ配信。UIの参加者数表示は present な参加者のみカウントする）。`participant_left.reason`（`"disconnected"`（一時断）/ `"ended"`（終了）の区別）と `participant_updated` は Phase2（一時断と終了の区別は [server-design.md](./server-design.md#不在終了判定) を参照）。

> **`participant_updated` の配信範囲（bd-ecb で確定）**: `participant_joined` / `participant_left` が「在室中の**他**参加者へ配信」なのに対し、`participant_updated` は**話者本人を含む全参加者へ配信**する。言語検出モード（FR-4.3）で確定した言語は本人のUI（言語表示・検出トグルの自動OFF）にも反映が必要なため。現時点の発火契機は言語検出モードの確定のみ（bd-ecb 実装。フロント側の受信ハンドリングは bd-fki のスコープ）。

### `peer_playback_state`（他参加者の再生状態、bd-rwi）

```json
{ "type": "peer_playback_state", "participantId": "p_456", "playing": true }
```

client → server の `playback_state` を、同室の**他**参加者へ中継したもの（送信者本人には配信しない）。受信側は `playing:true` の間＋残響猶予（300ms）、自分の**マイクトラックを一時ミュート**する（相互半二重、音響フィードバックループ対策。`audio` の送信自体は無音のまま継続する）。切断・再接続で `playing:false` を受け損ねる場合に備え、受信側は `participant_left` / `participant_joined` で該当参加者の記録を、自分の再接続（`joined`）で全記録をクリアする。

### `transcript_interim` / `transcript_final` / `utterance_committed`（話者本人にのみ）

```json
{ "type": "transcript_interim", "text": "今日は雨が降っているので" }
{ "type": "transcript_final", "text": "今日は雨が降っているので" }
{ "type": "utterance_committed", "text": "今日は雨が降っているので、屋内に行きましょう", "reason": "silence" }
```

interim は**表示専用・翻訳/TTS対象外**（FR-7.5）。これらは発話者デバイスにのみ返す（自分の原文フィードバック用）。`reason` は `"silence" | "maxChars" | "maxSeconds" | "commit" | "stop"`。

### `message`（確定発話・全参加者へ配信）

各聞き手デバイスは**自分の言語に翻訳された本文**を受け取る。話者本人は原文を受け取る。

```json
{
  "type": "message",
  "messageId": "m_789",
  "roomId": "b1f2...",
  "speakerParticipantId": "p_123",
  "speakerName": "Taro",
  "sourceLanguage": "ja-JP",
  "originalText": "今日は雨が降っているので、屋内に行きましょう",
  "displayText": "Since it is raining today, let's go indoors.",
  "displayLanguage": "en-US",
  "isOwnMessage": false,
  "createdAt": "2026-07-04T10:00:00.000Z"
}
```

| フィールド | 説明 |
|---|---|
| `messageId` | DB の Message 行 ID（履歴と整合、[db-design.md](./db-design.md#message発話) 参照） |
| `originalText` | 話者言語の原文（LINE風表示で話者本人は右側に原文） |
| `displayText` | **この受信者の言語**へ翻訳した本文（話者本人には原文と同一） |
| `displayLanguage` | `displayText` の言語（= 受信者の言語） |
| `isOwnMessage` | 受信者自身の発話か（自分=右、相手=左、FR-8.1） |

> 表示の原則（FR-8.2）: 各デバイスは会話全体を自分の言語で表示する。自分の発話は原文、相手の発話は翻訳。`displayText` にサーバーが受信者ごとに解決した値を入れることでクライアントは分岐不要。

### `audio`（合成音声・TTS ON の聞き手へ）

```json
{ "type": "audio", "messageId": "m_789", "mimeType": "audio/mpeg", "data": "//uQxAAA...(base64 mp3)" }
```

確定発話に対してのみ、TTS ON の聞き手へ配信（FR-6.1 / FR-7.4）。自分の発話音声は再生しない（配信もしない）。クライアントは FIFO キューで再生（[frontend-design.md](./frontend-design.md#音声再生) 参照）。

### `idle_hint`（アイドル通知・オーナーへ）

```json
{ "type": "idle_hint", "idleMs": 30000 }
```

一定時間発話がないときオーナーへ送る。**AI は呼ばない**。クライアントは話題提供ボタンを強調表示する（FR-10.4、[ai-assistant-design.md](./ai-assistant-design.md#アイドル検出とボタン強調) 参照）。しきい値は設定可能。

### `summary`（終了時要約・両者へ）

```json
{ "type": "summary", "roomId": "b1f2...", "text": "本日の会話は天気の話題から...", "createdAt": "2026-07-04T10:30:00.000Z" }
```

終了時点で両者（オーナー・ゲスト）の画面に表示（FR-11.3）。永続化はオーナーのみ閲覧可（[db-design.md](./db-design.md#summary要約) 参照）。

### `room_ended` / `error`

```json
{ "type": "room_ended", "reason": "owner_ended" }
{ "type": "error", "message": "...", "fatal": false }
```

`room_ended.reason`: `"owner_ended"`（明示終了）/ `"auto_timeout"`（不在自動終了、FR-12.2）。`error.fatal=true` で接続終了。`message` に GCP/内部詳細を含めない（[security-design.md](./security-design.md#エラー情報) 参照）。

---

## バリデーション方針（zod・`shared/ws-protocol/schema.ts`）

サーバーは**受信メッセージ（client → server）を zod で検証**する。スキーマは `shared/` に置き、Next.js からも型として参照する。

```ts
// shared/ws-protocol/schema.ts （設計指針。実装時に最新 zod API へ整合）
import { z } from "zod";
import { LanguageEnum } from "../languages"; // レジストリと同一集合

export const joinSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().min(1),
  role: z.enum(["owner", "guest"]),
  token: z.string().min(1),
  displayName: z.string().max(50).optional(),
  language: LanguageEnum,
});

export const startSchema = z.object({
  type: z.literal("start"),
  sourceLanguage: LanguageEnum,
  detectLanguage: z.boolean().optional().default(false),
  enableTts: z.boolean(),
  chunkMs: z.number().int().positive(),
  silenceMs: z.number().int().positive(),
  maxChars: z.number().int().positive(),
  maxSeconds: z.number().int().positive(),
});

export const audioSchema = z.object({ type: z.literal("audio"), data: z.string().min(1) });
export const commitSchema = z.object({ type: z.literal("commit") });
export const stopSchema = z.object({ type: z.literal("stop") });
export const updateSettingsSchema = z.object({
  type: z.literal("update_settings"),
  language: LanguageEnum.optional(),
  enableTts: z.boolean().optional(),
  displayName: z.string().max(50).optional(),
});
export const requestEndSchema = z.object({ type: z.literal("request_end") });

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinSchema, startSchema, audioSchema, commitSchema, stopSchema,
  updateSettingsSchema, requestEndSchema,
]);
```

### バリデーションルール

- パース失敗・スキーマ不一致 → `error`（`fatal:false`）を返し接続維持。
- `join` 前に他メッセージを受けた場合 → `error`（`fatal:false`）。
- `start` 前に `audio`/`commit`/`stop` を受けた場合 → `error`（`fatal:false`）。
- `request_end` を非オーナーが送った場合 → `error`（`fatal:false`）。
- server → client メッセージは型共有のみでランタイム検証しない（自プロセス生成）。

---

## メッセージ順序

1つの発話区切りに対するサーバー応答は次の順で送られる（話者本人 → 聞き手）。

```text
話者本人:  utterance_committed → message(原文)
聞き手ごと: message(翻訳) → (TTS ON時) audio
```

interim/final は録音中に話者本人へ随時送られ、確定シーケンスと並行し得る。クライアントは `type` で判別し順序前提で受信ロジックを組まない。
