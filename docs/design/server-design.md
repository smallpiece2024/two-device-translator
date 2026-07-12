# WebSocketサーバー設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [WebSocketプロトコル設計 (websocket-protocol.md)](./websocket-protocol.md)
- [GCP連携設計 (gcp-integration.md)](./gcp-integration.md)
- [DB設計 (db-design.md)](./db-design.md)
- [Supabase設計 (supabase-design.md)](./supabase-design.md)
- [AIアシスタント設計 (ai-assistant-design.md)](./ai-assistant-design.md)
- [セキュリティ設計 (security-design.md)](./security-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-3/FR-7/FR-9/FR-11/FR-12）

---

## 役割

GCE 上に常時稼働する Node.js WebSocket サーバー（Next.js とは別プロセス、127.0.0.1:3001）。GCP API・LLM・履歴書き込みを一手に担う。

- ルーム/参加者/セッションの管理（接続横断の状態）
- 音声チャンク受信 → STT Streaming → 発話区切り判定
- 確定発話を各聞き手の言語へ翻訳 → TTS → 配信ルーティング
- 確定発話・要約の Supabase 書き込み（service_role）
- 話者識別・再接続復帰・不在/終了判定・アイドル検出

GCP client library・LLM・service_role キーを使うのは**このプロセスのみ**（[security-design.md](./security-design.md) 参照）。

### プロトタイプからの差分

プロトタイプ [`simple-translator` の server-design.md](../../../simple-translator/docs/design/server-design.md) は **1接続=1セッション（DB/グローバル状態なし）**。本サービスは **RoomManager がルーム単位で複数セッションを束ね**、参加者間でメッセージをルーティングし、履歴を永続化する。発話区切り判定（`utteranceBuffer.ts`）と GCP ラッパーは純粋ロジックとしてほぼそのまま流用する。

---

## モジュール構成

```text
server/
  index.ts                # ws.Server 起動、接続受理、join まで待機
  room/
    roomManager.ts        # 全ルームのレジストリ。ルーム取得/生成/破棄、配信ルーティング
    session.ts            # 1接続=1参加者セッション。STTストリーム・発話バッファ・タイマー
  utterance/
    utteranceBuffer.ts    # 発話バッファ・発話区切り判定（純粋ロジック。プロトタイプ流用）
  gcp/
    languageCodes.ts      # Phase1暫定の言語コード変換（lsbタスクで shared/languages に統合予定）
    speechStream.ts       # STT Streaming ラッパー（プロトタイプ流用＋言語検出モード）
    translate.ts          # Cloud Translation ラッパー（プロトタイプ流用）
    textToSpeech.ts       # Cloud Text-to-Speech ラッパー（プロトタイプ流用）
  db/
    supabaseAdmin.ts      # service_role クライアント。Message/Summary 書き込み
  auth/
    verifyParticipant.ts  # join 時に Supabaseセッション/ゲストJWT を検証
  ai/
    llmProvider.ts        # LLM 抽象化（要約生成。[ai-assistant-design.md] 参照）
```

言語コード解決は `shared/languages/registry.ts`（レジストリ）を参照する（[gcp-integration.md](./gcp-integration.md#言語レジストリ) 参照）。zodスキーマ・型は `shared/ws-protocol/` を参照する。

### 責務分離

- `utteranceBuffer.ts` は I/O を持たない純粋ロジック（単体テスト対象）。
- GCP 呼び出しは `gcp/*` に閉じ込め `session.ts` から差し替え可能（テスト時モック）。
- `roomManager.ts` の配信ルーティングも I/O（送信）を注入可能にし、単体テストしやすくする。

---

## 状態モデル（インメモリ）

WSサーバーはリアルタイム状態の唯一の情報源。DB は永続化専用で、会話中は DB を読まない（[app-architecture.md](./app-architecture.md#clientserver-component-境界とデータ取得) 参照）。

```ts
// 設計例（server 側型。shared の型と接続する）
interface RoomRuntime {
  roomId: string;
  ownerUserId: string;
  status: "active" | "ended";
  participants: Map<string /* participantId */, ParticipantRuntime>;
  lastUtteranceAt: number;         // アイドル検出用
  idleThresholdMs: number;         // 設定可能（FR-10.4）
  soloSinceAt: number | null;      // 1人在室になった時刻（不在自動終了用）
  autoEndThresholdMs: number;      // 設定可能（FR-12.2）
}

interface ParticipantRuntime {
  participantId: string;
  role: "owner" | "guest";
  displayName?: string;
  language: SupportedLanguage;     // 現在の話す言語
  enableTts: boolean;              // 聞き手として TTS を受けるか
  present: boolean;                // 接続中か（再接続で復帰）
  session: Session | null;         // 録音中のみ非 null
}
```

- ルーム状態は `RoomManager` が保持。プロセス再起動で失われるが、確定発話は DB に永続化済みのため会話履歴は保全される（会話中の再起動は再接続で復帰、進行中の未確定発話のみ失われる）。
- 1:N を見据え `participants` は Map。MVP は owner1＋guest1 だが実装上の制約は設けない。

---

## セッションライフサイクル

```text
[connection open]
  → join 待ち（他メッセージは error:fatal=false）
[recv join]
  → verifyParticipant で token 検証 → RoomManager.getOrCreateRoom(roomId)
  → 参加者を present=true に（再接続なら既存 participant を復帰、FR-3.2/FR-12.3）
  → joined 送信（participants/room 状態）→ 他参加者へ participant_joined 配信
[recv start]
  → SessionConfig 確定 / STTストリーム開始 / 発話バッファ初期化
  → detectLanguage=true なら STT を複数言語候補モードで開始
[recv audio]*
  → base64 デコード → STTストリームへ write
  → STT interim → 話者へ transcript_interim / notifyInterim()（無音タイマーreset）
  → STT final   → バッファへ addFinal（無音タイマーreset）→ 話者へ transcript_final → 区切り判定
[区切り確定]
  → utterance_committed（話者へ）→ 翻訳ルーティング → message/audio 配信 → DB 書き込み
[recv update_settings] → 参加者状態更新 → participant_updated 配信
[recv commit/stop] → 即時確定 / 残バッファ確定してストリーム終了
[recv request_end(owner)] → ルーム終了シーケンス（要約→room_ended）
[connection close]
  → present=false に → participant_left(disconnected) 配信 → 不在/自動終了判定を起動
```

### 接続時認証（verifyParticipant）

`join.token` を role で分岐して検証する（[security-design.md](./security-design.md#認証フロー) 参照）。

| role | 検証方法 |
|---|---|
| owner | Supabase アクセストークン（JWT）を検証。`sub`(userId) がルームの `ownerUserId` と一致すること。検証は `supabaseAdmin.auth.getUser(token)` を用いる |
| guest | ゲストJWT を `shared/auth/guestToken.ts`（jose/HS256, `GUEST_COOKIE_SECRET`）で検証。payload の `roomId`/`participantId` がリクエストと一致し、DB の Participant 行が存在すること |

- 検証失敗 → `error`（`fatal:true`）で接続を閉じる。
- `participantId` は DB の安定IDを用い、再接続時に同一参加者として復帰する土台にする（[db-design.md](./db-design.md#participant参加者) 参照）。

#### 実装確定事項（bd-0jy で追加）

- **`AUTH_MODE=insecure`（E2E・開発専用の互換モード）**: ログインUI（bd-63d）・招待フロー（bd-jny）実装前の移行措置として、環境変数 `AUTH_MODE` が `"insecure"`（厳密一致）のときのみ token 検証をスキップする。既定は strict（本検証）。有効時は起動ログに警告を明示し、本番では絶対に設定しない。Playwright E2E はこのモードでWSサーバーを起動する。
- **非同期検証と切断の競合対策（幽霊参加者ガード）**: `verifyJoin` の await 中にクライアントが切断すると close イベントが session=null のまま先に発火するため、検証成功後・`RoomManager.join` 直前に `ws.readyState` を確認し、閉じていれば登録しない（登録すると除去経路がなく `maxParticipants` 枠を永久占有する）。回帰テストあり（`tests/integration/room-join-auth.test.ts`）。
- 検証中に追加の `join` が届いた場合は `error`（`fatal:false`）で拒否する（`joinInProgress` ガード）。
- **後続タスクへの繰り延べの解消状況**: (1) guest の「DB の Participant 行が存在すること」の確認は **bd-jny で実装済み**（`participants` を `id`+`room_id`+`role='guest'` で照合、行なし/エラーは fail-closed）。(2) owner の `participantId` の安定ID化は **bd-e3p で実装済み**（下記）。

#### 実装確定事項（bd-e3p で追加: 再接続復帰・不在/自動終了）

- **owner participantId の安定ID化**: join 時に `participants` を `room_id`+`user_id`（role='owner'）で照合し、既存行の id を、なければ insert した行の id を participantId に使う。**select→insert の TOCTOU 競合対策**として部分一意インデックス `participants_room_owner_unique_idx (room_id, user_id) where role='owner'`（migration `20260705145201`）を追加し、insert が 23505（一意制約違反）で失敗したら再 select で勝者の行を取得するフォールバックを実装。
- **presence**: close では参加者を削除せず `present=false` にして席を保持（`participant_left(reason:"disconnected")` を配信）。同一 participantId での再 join はソケット差し替え（`attachSocket`。進行中の録音セッションは差し替え前に破棄）で復帰し、二重接続時は新しい接続を正として旧を close(4000)。旧ソケットの close は `isCurrentSocket` ガードで無視。**`AUTH_MODE=insecure` のみ leave で参加者を削除**（participantId が毎回変わり再接続復帰が成立しないため。席保持すると枠を永久占有する）。
- **自動終了**: present が1人以下の状態が `AUTO_END_THRESHOLD_MS`（既定10分。env / `StartServerOptions.autoEndThresholdMs` で上書き可）継続で `room_ended(reason:"auto_timeout")` を配信して終了。タイマーは Room 単位・unref・破棄時クリア。
- **明示終了**: `request_end` はオーナーのみ受理（ゲストは fatal:false エラー）。`room_ended(reason:"owner_ended")` を全員に配信→録音破棄→ソケット close→DB `rooms.status='ended'` 更新（fire-and-forget）。
- **ended ルームへの再 join**: `{type:"room_ended", reason}` を送信してから close(1000)（エラーではなく終了案内を返す）。ended ルームはレジストリに残す。
- **スコープ外（要フォローアップ）**: FR-12.3 の「再開」（ended ルームの再活性化）は **bd-gz1 で実装済み**（下記）。フロント側の `room_ended` 受信ハンドリング（reducer の ROOM_ENDED 発火）は bd-4xi で実装済み。

#### 実装確定事項（bd-gz1 で追加: endedルームの再開）

FR-12.3「オーナーが再入室し再度QRで招待すると再開できる」に対応する。追加のプロトコルメッセージは作らず、**検証済みオーナーによる ended ルームへの再 join そのものを再開トリガーとする**。

- **再開トリガー**: `RoomManager.join()` で `room.status==="ended"` かつ `identity.role==="owner"`（`verifyJoin` を通過済み）の場合、`reopenRoom()` で `status="active"`・`endedReason=null` に戻し、以降は通常の join 処理（既存 participantId への再接続、または新規参加）に合流する。**guest の ended ルームへの join は従来どおり拒否**（`room_ended` 案内＋close、再開しない）。
- **メモリ/DB の整合**:
  - メモリ上に Room が残っている場合（同一サーバープロセス継続中）: 上記 `reopenRoom()` で active に戻す。
  - サーバー再起動後（メモリに Room が無く、DB は `ended` のまま）のオーナー join: `getOrCreateRoom()` が新規 Room（`status="active"`）を作るため `reopenRoom()` を経由しない「新規作成」パスになる。この場合も再開が成立するよう、`server/index.ts` は **オーナーの join 成功時は常に**（`joinResult.reopened` の真偽によらず）`markRoomActive(roomId)`（`server/db/supabaseAdmin.ts`、`markRoomEnded` と対の fire-and-forget 更新）を呼び、DB `rooms.status` を `'active'`・`ended_at` を `null` に戻す。既に `active` な行への同一更新は無害なため、「DBが ended のときのみ更新」という条件分岐（＝事前の読み取り）を避け、無条件呼び出しで整合させる（実装コスト・単純さ優先の判断）。
- **ended ルームの TTL クリーンアップ**: 再 join 案内・オーナー再開のために ended ルームをレジストリに残し続けると無期限に溜まるため、`endRoom()` 実行時に `endedRoomTtlMs`（既定30分、`DEFAULT_ENDED_ROOM_TTL_MS`。env `ENDED_ROOM_TTL_MS` / `StartServerOptions.endedRoomTtlMs` で上書き可）の TTL タイマーを起動し、経過後に `destroyRoom()` でレジストリから完全に破棄する。タイマーは Room 単位・unref・`reopenRoom()`/`destroyRoom()` 実行時にクリア（既存の `autoEndTimer` と同じ流儀）。TTL 経過後にオーナーが join した場合は「メモリに Room なし」の新規作成パスに乗り、上記の DB 側整合（`markRoomActive`）により再開が成立する。
- **`AUTH_MODE=insecure` での挙動**: insecure モードは `join.role` をそのまま identity の role として採用する（token 検証をスキップするのみで role 自体は偽装しない）ため、`role: "owner"` で join すれば同様に再開トリガーとなる。ただし insecure モードは `participantId` が接続ごとに新規発行されるため、再開後の join は常に「新規参加」扱いになる（既存 participantId への再接続にはならない）。

---

## 音声認識（プロトタイプ流用）

- 受信 `audio.data`（base64 / WebM Opus）をデコードし、**維持している単一のSTTストリーム**へ書き込む。ストリームはセッション中切り直さない（コンテナヘッダは最初のチャンクのみ、[gcp-integration.md](./gcp-integration.md#stt-ストリーム維持) 参照）。
- STT `languageCode` はレジストリの `sttCode` を参照（プロトコルコードを素通ししない）。
- `isFinal` で分岐: interim → `transcript_interim` 送信＋`notifyInterim()`（無音タイマーreset）／ final → バッファ `addFinal`（無音タイマーreset）＋`transcript_final` 送信＋区切り判定。
- **無音は「STT結果（interim/final）が止まったこと」で検出**する。生の音声チャンク受信では無音タイマーをリセットしない（MediaRecorder は無音でもチャンクを送出するため。プロトタイプの重要前提を継承）。

### 言語検出モード（FR-4.3・Phase2）

- `start.detectLanguage=true` のとき、STT を**複数言語候補**（`languageCode` = 参加者の現在言語、`alternativeLanguageCodes` = 対応言語の残り）で開始する。
- 最初の final result の `languageCode` を判定結果として採用し、参加者の `language` を更新（`participant_updated` 配信）。以後**その言語で固定**し、会話中の常時再判定はしない（要件§11②）。
- 判定後は通常の単一言語ストリームに準ずる扱い。次に検出モードを使うのは、ユーザーが再度有効化して `start` したとき。
- 対応言語追加はレジストリ追加のみで反映（[gcp-integration.md](./gcp-integration.md#言語レジストリ) 参照）。

---

## 発話バッファと発話区切り判定（プロトタイプ流用）

`utteranceBuffer.ts` は「いつ確定するか」を判定する純粋ロジック。確定後の I/O は `session.ts` が担う。

| 条件 | 初期値 | 判定 | reason |
|---|---|---|---|
| 無音継続 | `silenceMs`=1000 | 最後の STT結果からの経過超過（**バッファ非空時のみ起動**） | `silence` |
| 文字数上限 | `maxChars`=80 | バッファ確定テキスト長超過 | `maxChars` |
| 発話秒数上限 | `maxSeconds`=10 | 発話開始からの経過超過 | `maxSeconds` |
| 手動 commit | - | `commit` 受信 | `commit` |
| 停止 stop | - | `stop` 受信 | `stop` |

- 無音タイマーのリセット契機は interim 受信（`notifyInterim()`）と final 受信（`addFinal`）のみ。生の音声チャンクではリセットしない。
- interim はタイマーのリセット契機には使うが、文字数/確定判定には使わない（後から変化し得るため）。
- しきい値は `start` で受け取り、設定変更可能（NFR-5.2）。

---

## 話者調停（話者交代制、bd-6h1）

対面利用では2台の端末が近接するため、**相手の生声**を自分のマイクも拾い、「相手の声 → 自端末のSTT（違う言語設定）で誤認識 → 翻訳 → TTS → …」の混線が発生する（本番実機 2026-07-12。TTS再生中のみミュートする相互半二重＝bd-rwi では防げない）。プッシュ・トゥ・トークは**不採用**（タクシー運転手が乗客と話す想定で端末を操作しないため、ユーザー決定）。代わりにサーバーが「**一度に話者は1人**」を調停する。

実装: `room/speakerArbitration.ts`（`SpeakerArbitrator`、ルームIDごとに1つを `index.ts` が保持・ルーム終了時に破棄）。

### 判定規則（音量差を主、STT到着を従とする2段構え）

- **レベル記録**: 各クライアントは録音中、約200msごとに `audio_level`（ゲイン適用前RMS、0〜1）を送る（[websocket-protocol.md](./websocket-protocol.md#audio_level入力レベル通知bd-6h1)）。サーバーは参加者ごとに直近値＋受信時刻を保持する（**鮮度 1秒**を過ぎた値は判定に使わない）。
- **調停の契機**: STT interim/final の到着（=発話活動）。`Session` が `onSpeechActivity` フックで採否を問い合わせ、**拒否された結果は破棄**する（クライアントへの transcript 送信・発話バッファ・言語検出のいずれにも使わない）。
- **確定**: 話者不在のとき、活動者を話者に確定する。ただし**他参加者の直近レベルが有意（0.05以上）かつ活動者の1.5倍を超える**場合は「相手の声を拾った誤認識」とみなして拒否する（話者は自端末を手元に持つため、本人の端末に明確に大きな音が入るという物理的性質を利用。音圧は距離の2乗に反比例）。
- **フォールバック**: 活動者自身のレベルが未受信/鮮度切れなら比較不能として拒否しない（レベルを送らない旧クライアントでも到着順のみで動作する）。両者がほぼ無音（有意水準未満）のときもノイズ床の比率では拒否しない。
- **保持**: 話者確定中は本人の活動のたびに保持を延長し、他参加者の活動は破棄する。
- **解放**: 発話区切りの確定（utterance_committed）／無活動タイムアウト（1.5秒）／`stop`／切断・退室。確定/解放のたびに `active_speaker`（participantId / null）を**全参加者**へ配信する。

### 既知の限界（設計判断）

- 2台を並べて置く（距離差がない）使い方では音量差が効かず、誤判定が起こりうる。想定利用（各自が端末を手に持つ対面会話）を優先した割り切り。
- 話者確定前の一瞬（最初のinterimが出るまで数百ms）に相手端末が拾った音声は、レベル比較で概ね拒否されるが保証はない。誤って配信された場合も1発話単位であり、発話確定→解放で自己回復する。
- しきい値（優勢比1.5・有意水準0.05・鮮度1s・保持1.5s）は `speakerArbitration.ts` の定数。実機チューニングが必要になったら定数変更（またはオプション化済みのため注入）で調整する。

---

## 翻訳と配信ルーティング（1:N拡張の中核）

確定発話を、**ルーム内の各聞き手が必要とする言語**へ翻訳して配信する。

```text
発話確定（speaker=p_123, sourceLanguage=ja-JP, text）
  → 話者本人へ: message(originalText=text, displayText=text, isOwnMessage=true)
  → 聞き手集合の必要言語を収集: distinctLanguages = { 各聞き手の language } − { sourceLanguage }
  → 言語ごとに translate(text, sourceLanguage → 各言語) を1回だけ実行（同一言語は共有・キャッシュ）
  → 各聞き手へ: message(displayText=その言語の翻訳, displayLanguage=聞き手言語, isOwnMessage=false)
      → enableTts=true の聞き手へ: TTS(その言語) → audio
  → DB へ Message 書き込み（原文＋言語別翻訳マップ、service_role）
```

- **翻訳は「送信先言語ごとに1回」**。同一言語の聞き手が複数いても翻訳は1回（1:N でのコスト最適化）。MVP は聞き手1人なので1回。
- 話者と同一言語の聞き手には翻訳せず原文を配信（`displayText=originalText`、`isOwnMessage=false`）。
- 翻訳失敗はその発話のみ `error`（`fatal:false`）を話者へ返し、他はスキップ。
- TTS は確定発話のみ・`enableTts` の聞き手のみ（[gcp-integration.md](./gcp-integration.md#text-to-speech) 参照）。
- 履歴書き込みは翻訳確定後に非同期で行い、配信を遅延させない（会話テンポ優先、NFR-2.2）。

### 配信のルーティング表（例: owner=ja, guest=en）

| 発話者 | 話者本人 | 相手 |
|---|---|---|
| owner(ja) | message(ja原文, own) | message(en翻訳) + (TTS) audio(en) |
| guest(en) | message(en原文, own) | message(ja翻訳) + (TTS) audio(ja) |

---

## 履歴の永続化

- 確定発話ごとに `db/supabaseAdmin.ts`（service_role）で Message 行を1件書き込む。原文（`originalText`/`sourceLanguage`）と言語別翻訳（`translations` JSONB）を保存（[db-design.md](./db-design.md#message発話) 参照）。
- 音声は永続保存しない（NFR-1.4）。書き込むのはテキストのみ。
- 参加者の入退室・言語変更は Participant 行を更新（`present`・`language`）。
- service_role キーは WSサーバー内に閉じ、RLS をバイパスして書き込む（[supabase-design.md](./supabase-design.md#service_role-の使用箇所) 参照）。

---

## 再接続・不在・終了判定

### 再接続復帰（FR-3.2 / FR-12.3・Phase2）

- クライアントは切断時に自動再接続を試みる（NFR-3.1）。再接続時も `join` を送る。
- 同一 `participantId`（owner=Supabaseセッション、guest=ゲストクッキーの JWT）であれば、`RoomManager` は既存 `ParticipantRuntime` を `present=true` に戻し、`participant_joined` を配信（再入室扱い）。
- ルームが既に `ended` の場合、guest は `room_ended` を返して接続を閉じる。**オーナーの場合は再開する**（FR-12.3、bd-gz1。詳細は下記「実装確定事項（bd-gz1 で追加: endedルームの再開）」参照）。

### 不在（一時断）と終了の区別（FR-12.2・Phase2）

- 接続 close → `present=false`、`participant_left(disconnected)` 配信。ランタイムは即破棄せず保持（再接続待ち）。
- **自動終了**: ルームに present な参加者が1人だけの状態（`soloSinceAt`）が `autoEndThresholdMs`（設定可能）を継続 → ルームを `ended` にし終了シーケンスへ。
- **明示終了**: オーナーの `request_end`（FR-12.1）。ゲストは強制終了。

### ルーム終了シーケンス（Phase3）

```text
終了トリガー（request_end owner / auto_timeout）
  → status=ended、DB の Room.status=ended, endedAt 更新
  → (履歴が空でなければ) LLM で要約生成（ai/llmProvider）→ Summary を DB 保存
  → 両参加者へ summary 配信（FR-11.3。ゲストにもその場表示）
  → 全参加者へ room_ended 配信 → セッション/STTストリーム破棄 → ランタイム破棄
```

要約生成の詳細・失敗時挙動は [ai-assistant-design.md](./ai-assistant-design.md#終了時要約) を参照。

---

## アイドル検出（FR-10.4・Phase3）

- `lastUtteranceAt` を確定発話ごとに更新。`idleThresholdMs`（設定可能）を超えて発話がなければオーナーへ `idle_hint` を送る。
- **AI は呼ばない**（ボタン強調のみ）。話題提供の LLM 呼び出しはオーナーのボタン押下時に Next.js の `POST /api/ai/topic` で行う（[ai-assistant-design.md](./ai-assistant-design.md#実行経路) 参照）。

---

## エラー処理（プロトタイプ流用）

| 種別 | 対応 | fatal |
|---|---|---|
| 受信メッセージのバリデーション失敗 | `error` 継続 | false |
| `join` 前の他メッセージ / `start` 前の audio 等 | `error` 継続 | false |
| 非オーナーの `request_end` | `error` 継続 | false |
| 認証失敗（token 無効/不一致） | `error` 接続終了 | true |
| Translation / TTS の一時エラー | `error`（その発話のみ失敗） | false |
| STTストリームのエラー / 時間上限到達 | `error`（再接続を促す） | false |
| プロセスレベルの致命障害 | `error` 接続終了 | true |

エラーメッセージに GCP/内部詳細・スタックトレースを含めない（[security-design.md](./security-design.md#エラー情報) 参照）。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | RoomManager 骨格、join/start/audio/commit/stop、STT→翻訳→配信→TTS、2参加者ルーティング（認証は最小） |
| Phase 2 | verifyParticipant（Supabase/ゲストJWT）、再接続復帰、言語検出モード、不在/自動終了 |
| Phase 3 | Message/Summary の DB 書き込み、終了時要約、idle_hint |

---

## テスト方針（概要）

| 対象 | 種別 | 例 |
|---|---|---|
| `utteranceBuffer.ts` | 単体（Jest） | 無音/文字数/秒数/commit/stop の確定タイミング。音声チャンク相当でリセットされないこと |
| `shared/ws-protocol/schema.ts` | 単体 | 正常/異常メッセージの受理・拒否、join 前メッセージ拒否 |
| 配信ルーティング（roomManager） | 単体（送信を注入） | 話者/聞き手別の message・audio 宛先、言語別翻訳が送信先ごとに1回 |
| `verifyParticipant` | 単体（Supabase/jose モック） | owner/guest の検証成否、roomId 不一致の拒否 |
| session フロー | 結合（GCP モック） | join→start→audio→final→確定→message→DB 書き込み |
| 不在/自動終了 | 結合 | solo 継続で auto_timeout、再接続で復帰 |

GCP・LLM・Supabase は実接続せずモック化する（CLAUDE.md CI 節）。
