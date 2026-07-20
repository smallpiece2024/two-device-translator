# フロントエンド設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [WebSocketプロトコル設計 (websocket-protocol.md)](./websocket-protocol.md)
- [サーバー設計 (server-design.md)](./server-design.md)
- [スタイリング設計 (styling-design.md)](./styling-design.md)
- [AIアシスタント設計 (ai-assistant-design.md)](./ai-assistant-design.md)
- [セキュリティ設計 (security-design.md)](./security-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-4〜FR-11 / NFR-4 対応環境）

---

## 役割

Next.js（App Router）の画面とクライアント処理を担う。**GCP・LLM には一切アクセスしない**（すべて WS/Route Handler 経由）。プロトタイプ [`simple-translator` の frontend-design.md](../../../simple-translator/docs/design/frontend-design.md) の単一話者 `TranslatorApp.tsx`（reducer駆動）を **2デバイスのチャットタイムライン** に拡張する。

主な差分:
1. `TranslatorApp` → `RoomClient`。単一話者の transcript ではなく、**参加者×メッセージのタイムライン**を保持。
2. `LanguageSelector` は source/target ではなく**自分の話す言語のみ**選択（翻訳先はサーバーが決定）。
3. LINE風チャット UI（`ChatTimeline` / `MessageBubble`）を追加。
4. `QRDisplay`（オーナー招待）、`AIAssistantPanel`（話題提供・要約）、`SettingsPanel`（言語/TTS/名前/しきい値）を追加。
5. ログイン・ルーム一覧・履歴などの画面を追加（トークルーム以外は Server Component 主体）。

---

## 画面一覧とコンポーネント種別

| 画面 | ルート | 種別 | 主なコンポーネント |
|---|---|---|---|
| ログイン | `/login` | SC 外枠 + CC フォーム | `LoginForm` |
| ルーム一覧 | `/rooms` | Server Component | `RoomList` |
| ルーム作成 | `/rooms/new` | SC + Server Action | `CreateRoomForm` |
| オーナー トークルーム | `/rooms/[roomId]` | SC ガード → CC | `RoomClient`（owner） |
| ゲスト参加 | `/join/[token]` | SC 照合 + CC フォーム | `JoinForm` |
| ゲスト トークルーム | `/room/[roomId]` | SC ガード → CC | `RoomClient`（guest） |
| 履歴一覧 | `/history` | Server Component | `HistoryList` |
| 履歴詳細 | `/history/[roomId]` | Server Component | `HistoryTimeline` |

SC=Server Component / CC=Client Component。認証・認可は必ず Server Component 側で行い、クライアントに認可判定を持たせない（[app-architecture.md](./app-architecture.md#clientserver-component-境界とデータ取得) 参照）。

---

## コンポーネントツリー（トークルーム）

```text
app/(owner)/rooms/[roomId]/page.tsx     (Server Component: 認証・所有者確認・メタ取得)
  └─ RoomClient.tsx                      ("use client") ← 全状態を保持・配布
       ├─ RoomHeader.tsx                 相手の在室状態・ルーム状態・終了ボタン(owner)
       ├─ ChatTimeline.tsx               メッセージ一覧（自分=右/相手=左）
       │    └─ MessageBubble.tsx         話者名・時刻・原文/翻訳・再生アイコン
       ├─ Recorder.tsx                   開始/停止/手動区切り・状態表示
       ├─ LanguageSelector.tsx           自分の話す言語＋言語検出モードトグル
       ├─ TTSToggle.tsx                  自分の TTS ON/OFF
       ├─ QRDisplay.tsx                  招待QR（owner のみ）
       ├─ AIAssistantPanel.tsx           話題提供ボタン・提案表示・要約表示（owner）／要約表示のみ(guest)
       └─ SettingsPanel.tsx              表示名・発話区切りしきい値・アイドルしきい値(owner)
```

`"use client"` 境界は `RoomClient` の1箇所に集約する。`page.tsx` は SC のまま認証・認可・最小 props 受け渡しのみ。

---

## 各コンポーネントの責務

### RoomClient（最上位 Client Component）

- props: `roomId, participantId, role, selfLanguage, displayName, wsUrl, wsAuthToken`（Server Component が渡す最小限）。
- `useReducer` で全状態を保持。`useRoomSocket` / `useRecorder` / `useAudioQueue` を統合。
- WS 接続確立後に `join` を送信（token 込み）。`joined` 受信で参加者一覧・自分の participantId を確定。
- 受信メッセージを reducer にディスパッチし、子へ props で配る。ハンドラ（`start`/`stop`/`commit`/`updateSettings`/`requestEnd`/`requestTopic`）を子へ渡す。

### ChatTimeline / MessageBubble

- `messages[]`（reducer 状態）を時系列表示。`isOwnMessage` で左右を振り分ける（自分=右、相手=左、FR-8.1）。
- 各バブルに話者名・時刻・本文（`displayText`）を表示。相手バブルには翻訳、自分バブルには原文（サーバーが `displayText` を解決済みなので分岐不要、[websocket-protocol.md](./websocket-protocol.md#message確定発話全参加者へ配信) 参照）。
- interim（自分の途中認識）は最下部に淡色で仮表示（`transcript_interim`、表示専用・翻訳/TTS対象外、FR-7.5）。確定（`message`）でバブル化。
- 音声再生中/再生済みのアイコンを任意表示（TTS ON の相手発話）。

### Recorder

- ボタンは「**開始**」「**停止**」「**手動で発話を区切る**」の3つ（プロトタイプ踏襲）。
  - 開始: 録音開始 → `start` 送信（WS は join 済み前提）。
  - 停止: `stop` + 録音停止。
  - 手動で発話を区切る: `commit`。
- `AppStatus`（`idle`/`connecting`/`joined`/`recording`/`error`）に応じ活性制御。状態テキストを表示。

### LanguageSelector

- **自分の話す言語のみ**を `<select>` で選ぶ（翻訳先はサーバーが各聞き手言語から決定するため target 選択は無い）。選択肢はレジストリ `label` から動的生成（MVP は日本語/英語）。
- 変更時は `update_settings`（`language`）を送る。録音中は変更不可（次の start から反映）。
- **言語検出モードトグル**（FR-4.3）: ON にして開始すると `start.detectLanguage=true` で送信。判定後は `participant_updated` を受けて選択言語表示を更新し、トグルは自動 OFF に戻す（常時再判定しない、要件§11②）。

### TTSToggle

- 自分が**聞き手として**翻訳音声を受け取るか（FR-6.1）。ON/OFF を `update_settings`（`enableTts`）で送り、次の相手発話から反映。テキスト表示はトグルに関係なく常時（FR-6.2）。
- 言語別 TTS（`ttsByLanguage`）はプロトタイプ同様クライアントで保持し、送信時に boolean へ解決してよい（MVP は単純 ON/OFF で可）。
- **TTSと録音の半二重制約（bd-0ee/bd-rwi/bd-dnh/bd-1or、本番実機で確定した制約）**: 対面利用ではデバイスが近接するため、TTS再生音をマイクが拾い「再生音→誤認識→翻訳→再生→…」の無限ループが発生しうる（自デバイスのスピーカー経由と、**相手デバイス**のスピーカー経由の両方）。対策として、**自分または同室の誰かがTTS再生中（＋残響猶予 300ms）はマイク入力を一時ミュートする**。相手の再生状態は WS の `playback_state`→`peer_playback_state` 中継で知る（[websocket-protocol.md](./websocket-protocol.md) 参照）。
  - **ミュート方式（bd-1or で確定: WebAudio ゲイン0）**: `getUserMedia` のストリームを `source → GainNode → MediaStreamAudioDestinationNode → MediaRecorder` のパイプラインに通し、ミュートは**ゲイン0**で行う（`audioPipeline.ts`）。エンコーダが**無音の実データ**を出し続けるため、録音・チャンク送信が継続し Google Streaming STT のストリームが途切れない。変遷: (1)「audio チャンクの送信を落とす」方式 → 供給停止で STT が `Audio Timeout Error`（不採用）。(2)「`MediaStreamTrack.enabled=false`」方式（bd-dnh）→ モバイルブラウザでサイズ0チャンクとなり `blob.size===0` スキップで同じく Audio Timeout が再発（本番実機 2026-07-12、不採用）。(3) ゲイン0方式（現行）。WebAudio 不可の環境では (2) にフォールバックする。
  - あわせて `audioPipeline.ts` は AnalyserNode（**ゲイン適用前**）でマイク入力レベル（RMS 0..1）を測定し、`Recorder` が録音中に約200ms間隔で `onAudioLevel` へ通知する（話者交代制の判定材料、下記）。
  - 実装: `audioPipeline.ts`＋`halfDuplex.ts`（純粋モジュール、抑止状態の変化通知）＋ `audioPlaybackQueue` の再生状態変化通知＋ `Recorder` の `muted` prop。
- **話者交代制（bd-6h1/bd-9mo、生声クロストーク対策）**: TTS半二重だけでは、相手が**生声で話している間**に自分のマイクが相手の声を拾う混線（誤認識→翻訳→TTS）を防げない（本番実機 2026-07-12）。プッシュ・トゥ・トークは不採用（タクシー運転手が乗客と話す想定で端末を操作しない、ユーザー決定）。サーバーの話者調停（[server-design.md「話者調停」](./server-design.md)）が「一度に話者は1人」を判定し、クライアントは以下を結線する:
  - 録音中、`onAudioLevel` のレベルを `audio_level` としてサーバーへ送る（調停の主判定材料）。
  - `active_speaker` 受信で現在の話者を保持し、**マイクミュートの最終判定を「TTS半二重抑止 OR（話者が自分以外）」の OR** で行い `Recorder.muted` に渡す。
  - リセット（取りこぼし対策の二重防御）: 自分の再接続（`joined`）で話者状態をリセット。`participant_left` で退室者が話者ならリセット。

### QRDisplay（owner のみ）

- `POST /api/invites` で発行した招待URL（`https://{host}/join/{token}`）を QR 生成して表示（FR-2.2）。QR ライブラリ（例: `qrcode`）でクライアント生成、または Server Component で data URL 生成。
- 期限・再発行に対応（[db-design.md](./db-design.md#invites招待qr) 参照）。
- **導線（bd-hue で確定、ユーザー要望）**: ルーム作成後はルーム画面へ直行し、QR はルーム画面内の「招待QRを表示」リンク（owner のみ、新規タブで招待ページを開き WS 接続を維持）からいつでも提示できる。ルーム一覧の進行中ルームにも「招待」リンクがある（bd-83x）。ルーム内モーダル化は将来の改善候補。

### AIAssistantPanel

- owner: 「話題提供」ボタン（`requestTopic` → `POST /api/ai/topic`）と提案表示。`idle_hint` 受信でボタンを強調表示（FR-10.4、[ai-assistant-design.md](./ai-assistant-design.md#アイドル検出とボタン強調) 参照）。**無音で自動的に AI を呼ばない**。
- owner/guest 共通: 終了時に `summary` を受信したらモーダル等で要約を表示（FR-11.3）。ゲストは永続閲覧手段なし（その場表示のみ）。

### SettingsPanel

- 表示名（`update_settings.displayName`、FR-5.1）。
- 発話区切りしきい値 `chunkMs`/`silenceMs`/`maxChars`/`maxSeconds`（初期 250/1000/80/10、`start` に反映、NFR-5.2）。
- owner: アイドルしきい値（idle_hint）・不在自動終了しきい値（サーバーへ設定、FR-10.4/FR-12.2）。設定手段は MVP では簡易でよい。
- 値は録音開始前に確定（録音中変更は再接続で反映、プロトタイプ方針継承）。

---

## 状態管理（reducer）

外部ライブラリ不要。`useReducer` + `useState` + カスタムフック。

```ts
// src/types/room.ts （設計指針）
type AppStatus = "idle" | "connecting" | "joined" | "recording" | "error";

interface ParticipantView {
  participantId: string; role: "owner" | "guest";
  displayName?: string; language: SupportedLanguage; present: boolean;
}
interface MessageView {
  messageId: string; speakerParticipantId: string; speakerName?: string;
  originalText: string; displayText: string; displayLanguage: SupportedLanguage;
  isOwnMessage: boolean; createdAt: string;
}
interface RoomState {
  status: AppStatus;
  selfParticipantId: string | null;
  participants: ParticipantView[];
  messages: MessageView[];
  interim: string;            // 自分の途中認識（表示専用）
  idleHint: boolean;          // 話題提供ボタン強調（owner）
  topicSuggestion: string | null;
  summary: string | null;     // 終了時要約
  roomEnded: boolean;
  error: string | null;
}
```

### reducer アクション

| アクション | 契機（WS受信 or 操作） |
|---|---|
| `STATUS_CHANGED` | 接続状態変化 |
| `JOINED` | `joined` → participants/selfParticipantId 設定。`recentMessages` が非空のときのみ messages を置き換え、空のときは既存 messages を維持（bd-652 で追加） |
| `PARTICIPANT_JOINED/LEFT/UPDATED` | 参加者イベント |
| `INTERIM` | `transcript_interim` → interim 置換（自分のみ） |
| `MESSAGE` | `message` → messages に追加、interim クリア |
| `IDLE_HINT` | `idle_hint` → idleHint=true |
| `TOPIC` | `POST /api/ai/topic` レスポンス → topicSuggestion |
| `SUMMARY` | `summary` → summary 設定 |
| `ROOM_ENDED` | `room_ended` → roomEnded=true |
| `ERROR` | `error` → error（fatal なら status=error） |
| `RESET` | 切断・再接続。**messages は維持**し、それ以外（interim/error/participants 等）を初期化（bd-652 で追加） |

- `transcript_final` / `utterance_committed` は自分の原文フィードバック（interim 更新の補助）。UI は主に `message` でバブル化するため、これらは軽く扱う（interim 表示の確定に使う）。
- **再接続をまたぐタイムライン保持（bd-652 で追加）**: Phase1 のサーバーは会話履歴を永続化せず、再接続時の `joined.recentMessages` は常に空配列で返る。クライアントが保持する `messages` が会話の唯一の記録であるため、`RESET`（再接続開始）と `JOINED`（再join完了）のいずれでも messages を空で上書きしない。Phase2 でサーバー履歴復元が入った場合は、`recentMessages` 非空時に置き換える既存分岐がそのまま復元経路になる。

---

## カスタムフック

### useRoomSocket(dispatch, { onAudioReceived, roomId, role, token, selfSettings })

- `connect()` で WS を開き、確立後に `join`（token・displayName・language）を送信。
- 提供メソッド: `sendStart(settings)` / `sendAudio(base64)` / `sendCommit()` / `sendStop()` / `sendUpdateSettings(patch)` / `sendRequestEnd()`。
- 受信 JSON を `type` で判別し reducer へディスパッチ。`audio` は `onAudioReceived` へ。
- **自動再接続**（NFR-3.1）: 切断時に指数バックオフで再接続し、再接続後は `join` を再送（同一 participantId で復帰、FR-3.2）。
- 接続先は `NEXT_PUBLIC_WS_URL`（Caddy が `/ws*` をプロキシ）。

### useRecorder({ onChunk, onError })

- `getUserMedia({ audio: true })` → `MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" })`（プロトタイプ流用）。
- `startMicRecording(chunkMs=250)` で timeslice 録音。`ondataavailable` の Blob → base64 → `sendAudio`。`stopMicRecording()` でトラック解放。
- マイク許可拒否は `onError`（クライアント側エラー表示）。HTTPS 必須（NFR-1.1、[infra-design.md](./infra-design.md) 参照）。

### useAudioQueue()

- 受信 `audio`（mp3 base64）を `AudioContext.decodeAudioData` → FIFO 再生（重ならないよう `onended` で次を再生）。
- **AutoPlay 対策**: `AudioContext` はユーザー操作イベント内（開始ボタン押下時）で生成・resume。ページ読み込み時に生成しない。
- 自分の発話音声は再生しない（サーバーが配信しない）。

---

## 音声送受信フロー

```text
[送信] useRecorder.ondataavailable(blob)
  → blob.arrayBuffer() → base64（Uint8Array をチャンク分割で安全変換）
  → sendAudio(base64) → { type:"audio", data }

[受信] WS message(displayText) → ChatTimeline にバブル追加
       WS audio(mp3 base64) → useAudioQueue で FIFO 再生（TTS ON の相手発話のみ）
```

---

## 履歴画面（`/history`）

- Server Component で Supabase から `rooms`（一覧）・`messages`（詳細、ページング）を取得（RLS でオーナー本人のみ、[supabase-design.md](./supabase-design.md#rls-ポリシー) 参照）。
- 詳細は保存済み `original_text` + `translations` から**オーナーの言語**でタイムライン再構成（`HistoryTimeline`）。会話中と同じ左右レイアウトを流用。
- 要約があれば冒頭に表示（`summaries`）。音声は保存していないため再生機能はなし（NFR-1.4）。
- リアルタイム要素は無い（純粋な閲覧、WS 不使用）。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | `RoomClient`・`ChatTimeline`・`Recorder`・`LanguageSelector`・`TTSToggle`・音声送受信（認証最小の簡易 room） |
| Phase 2 | `/login`・`/rooms`・`/join`・`QRDisplay`・言語検出トグル・`SettingsPanel`・再接続復帰 |
| Phase 3 | `AIAssistantPanel`（話題提供・要約）・`/history` 系・idle_hint 連携 |

---

## テスト方針（概要）

| 対象 | 種別 | 例 |
|---|---|---|
| reducer | 単体（Jest） | 各アクションの状態遷移、message 追加・interim クリア |
| base64 変換 / 言語ガード | 単体 | 変換往復 |
| 各コンポーネント | RTL | ボタン活性制御、自分/相手バブルの左右、TTSトグル反映 |
| ユーザーフロー | E2E（Playwright） | 開始→発話→停止（WSモック、フェイクマイク） |

MediaRecorder / AudioContext / WebSocket はモック化。E2E は main への PR 時に追加（CLAUDE.md CI 節）。
