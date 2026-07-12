/**
 * WebSocketメッセージの zod スキーマ定義。
 *
 * Next.js（src/）と WSサーバー（server/）の型ドリフトを防ぐため、この
 * ファイルを唯一の正本とする（docs/design/websocket-protocol.md 参照）。
 *
 * 本ファイルは Phase1（join / start / audio / commit / stop、および
 * joined / transcript_interim / transcript_final / utterance_committed /
 * message / audio / error）に加え、Phase2 の一部
 * （update_settings, participant_joined/left, request_end, room_ended,
 * participant_updated）を定義する（bd-e3p で request_end / room_ended を追加。
 * bd-ecb で言語検出モード確定通知の participant_updated を追加。bd-fki で
 * update_settings に language/displayName を追加）。Phase3 の
 * メッセージ（idle_hint, summary 等）は将来追加する。`z.discriminatedUnion` は
 * 配列へスキーマを追加するだけで拡張できるため、追加を阻害しない設計になっている。
 *
 * 依存は zod のみ（shared/ の制約）。
 */
import { z } from "zod";
import { LanguageEnum } from "../languages/registry";

// ─────────────────────────────────────────────
// client → server
// ─────────────────────────────────────────────

/** ルーム参加・認証（接続後、最初に必ず送る） */
export const joinSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().min(1),
  role: z.enum(["owner", "guest"]),
  token: z.string().min(1),
  displayName: z.string().max(50).optional(),
  language: LanguageEnum,
  /** 聞き手として TTS を受け取るか（既定 true） */
  enableTts: z.boolean().optional().default(true),
});

/**
 * 設定変更通知（bd-fki で language/displayName を Phase2 拡張として追加）。
 * `enableTts` は Phase1 から必須（既存の後方互換を維持）。`language`/
 * `displayName` は任意項目とし、指定がなければ変更しない
 * （docs/design/websocket-protocol.md「update_settings（設定変更）」参照）。
 */
export const updateSettingsSchema = z.object({
  type: z.literal("update_settings"),
  enableTts: z.boolean(),
  language: LanguageEnum.optional(),
  displayName: z.string().max(50).optional(),
});

/** 録音セッション開始 */
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

/** 音声チャンク送信（base64 化された WebM/Opus） */
export const audioClientSchema = z.object({
  type: z.literal("audio"),
  data: z.string().min(1),
});

/** 現在の発話バッファを即時確定 */
export const commitSchema = z.object({
  type: z.literal("commit"),
});

/** 残バッファを確定→STTストリーム終了 */
export const stopSchema = z.object({
  type: z.literal("stop"),
});

/**
 * オーナーによるルーム終了要求（bd-e3p）。
 * オーナーのみ有効。非オーナーが送った場合はサーバー側で `error`（`fatal:false`）
 * とする（docs/design/websocket-protocol.md「request_end（ルーム終了）」参照）。
 */
export const requestEndSchema = z.object({
  type: z.literal("request_end"),
});

/**
 * 自デバイスのTTS再生状態の通知（相互半二重化）。
 * サーバーは同室の**他**参加者へ `peer_playback_state` として中継する。
 * 対面利用で相手端末のスピーカー音を自分のマイクが拾う音響フィードバック
 * ループを防ぐため、受信側は相手の再生中に自分のマイク送信を抑止する
 * （docs/design/websocket-protocol.md「playback_state（再生状態通知）」参照）。
 */
export const playbackStateSchema = z.object({
  type: z.literal("playback_state"),
  playing: z.boolean(),
});

/**
 * マイク入力レベルの通知（話者交代制、bd-6h1）。
 * 録音中のクライアントが約200ms間隔で送る（ゲイン適用前のRMS、0..1）。
 * サーバーの話者調停（生声クロストーク対策）が「どの端末に大きな音が
 * 入っているか」の判定材料に使う。永続化しない
 * （docs/design/websocket-protocol.md「audio_level（入力レベル通知）」参照）。
 */
export const audioLevelSchema = z.object({
  type: z.literal("audio_level"),
  level: z.number().min(0).max(1),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinSchema,
  updateSettingsSchema,
  startSchema,
  audioClientSchema,
  commitSchema,
  stopSchema,
  requestEndSchema,
  playbackStateSchema,
  audioLevelSchema,
]);

// ─────────────────────────────────────────────
// server → client
// ─────────────────────────────────────────────

/** `joined.participants` の各要素 */
export const participantSummarySchema = z.object({
  participantId: z.string().min(1),
  role: z.enum(["owner", "guest"]),
  displayName: z.string().max(50).optional(),
  language: LanguageEnum,
  present: z.boolean(),
});

/** 確定発話（原文＋受信者言語への翻訳）。全参加者へ配信 */
export const messageSchema = z.object({
  type: z.literal("message"),
  messageId: z.string().min(1),
  roomId: z.string().min(1),
  speakerParticipantId: z.string().min(1),
  speakerName: z.string(),
  sourceLanguage: LanguageEnum,
  originalText: z.string(),
  displayText: z.string(),
  displayLanguage: LanguageEnum,
  isOwnMessage: z.boolean(),
  createdAt: z.string(),
});

/** 参加確定（自分の participantId・ルーム状態・参加者一覧） */
export const joinedSchema = z.object({
  type: z.literal("joined"),
  participantId: z.string().min(1),
  room: z.object({
    id: z.string().min(1),
    status: z.enum(["active", "ended"]),
  }),
  participants: z.array(participantSummarySchema),
  recentMessages: z.array(messageSchema),
});

/** 認識途中結果（話者本人にのみ・表示専用。翻訳/TTS対象外） */
export const transcriptInterimSchema = z.object({
  type: z.literal("transcript_interim"),
  text: z.string(),
});

/** 認識確定結果（話者本人にのみ） */
export const transcriptFinalSchema = z.object({
  type: z.literal("transcript_final"),
  text: z.string(),
});

/**
 * 発話確定理由。`server/utterance/utteranceBuffer.ts` の
 * `UtteranceCommitReason` 型もこのスキーマから導出し、reason の定義を一本化する。
 */
export const utteranceCommitReasonSchema = z.enum([
  "silence",
  "maxChars",
  "maxSeconds",
  "commit",
  "stop",
]);

/** 発話区切り確定（話者本人にのみ） */
export const utteranceCommittedSchema = z.object({
  type: z.literal("utterance_committed"),
  text: z.string(),
  reason: utteranceCommitReasonSchema,
});

/** 合成音声（mp3 base64）。TTS ON の聞き手へ配信 */
export const audioServerSchema = z.object({
  type: z.literal("audio"),
  messageId: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string().min(1),
});

/** 他参加者の join 通知（join成功時、既に在室している参加者へ配信） */
export const participantJoinedSchema = z.object({
  type: z.literal("participant_joined"),
  participant: participantSummarySchema,
});

/**
 * 退室理由（bd-e3p）。`"disconnected"`=一時断（再接続で復帰しうる）、
 * `"ended"`=ルーム終了に伴う退室（現状の実装ではルーム終了時は `room_ended` を
 * 送るため使用しない。将来の選択的な強制退室に備えて予約）。
 * 既存クライアント・テストとの互換のため任意項目とする（省略時は理由不明）。
 */
export const participantLeftReasonSchema = z.enum(["disconnected", "ended"]);

/** 他参加者の退室通知（切断時、在室中の参加者へ配信） */
export const participantLeftSchema = z.object({
  type: z.literal("participant_left"),
  participantId: z.string().min(1),
  reason: participantLeftReasonSchema.optional(),
});

/**
 * 参加者の設定変更イベント（bd-ecb で言語検出モード確定通知として追加。
 * bd-fki で `update_settings` による言語・表示名の明示変更にも使うよう拡張）。
 * 発火契機は (1) 言語検出モード（FR-4.3・D-9）が最初の final で話者言語を
 * 確定した場合、(2) `update_settings` で language/displayName が変更された
 * 場合の2つ。どちらも本人を含む全参加者へ配信する。`displayName` は変更が
 * ない場合も含めて常に現在値を載せる（websocket-protocol.md「参加者イベント」
 * 「`participant_updated` の配信範囲（bd-ecb で確定）」参照）。
 */
export const participantUpdatedSchema = z.object({
  type: z.literal("participant_updated"),
  participantId: z.string().min(1),
  displayName: z.string().max(50).optional(),
  language: LanguageEnum,
});

/**
 * 他参加者のTTS再生状態の中継（相互半二重化、bd-rwi）。
 * `playback_state` を受信したサーバーが、同室の**他**参加者へ配信する
 * （送信者本人には返さない）。受信側は `playing:true` の間、自分のマイク
 * 音声（`audio`）の送信を抑止する。
 */
export const peerPlaybackStateSchema = z.object({
  type: z.literal("peer_playback_state"),
  participantId: z.string().min(1),
  playing: z.boolean(),
});

/**
 * 現在の話者の通知（話者交代制、bd-6h1）。
 * サーバーの話者調停が話者を確定/解放した際に、同室の**全**参加者
 * （話者本人を含む）へ配信する。`participantId: null` は「話者なし」。
 * 受信側は「話者が自分以外」の間、自分のマイクをミュートする
 * （生声クロストーク対策。docs/design/websocket-protocol.md
 * 「active_speaker（話者通知）」参照）。
 */
export const activeSpeakerSchema = z.object({
  type: z.literal("active_speaker"),
  participantId: z.string().min(1).nullable(),
});

/** エラー通知。`fatal:true` の場合は接続終了 */
export const errorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  fatal: z.boolean(),
});

/**
 * ルーム終了理由（bd-e3p）。`"owner_ended"`=オーナーの明示終了（`request_end`）、
 * `"auto_timeout"`=不在自動終了（FR-12.2）。
 */
export const roomEndedReasonSchema = z.enum(["owner_ended", "auto_timeout"]);

/** ルーム終了通知（全参加者へ配信。受信後、クライアントは接続を終了してよい） */
export const roomEndedSchema = z.object({
  type: z.literal("room_ended"),
  reason: roomEndedReasonSchema,
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  joinedSchema,
  transcriptInterimSchema,
  transcriptFinalSchema,
  utteranceCommittedSchema,
  messageSchema,
  audioServerSchema,
  participantJoinedSchema,
  participantLeftSchema,
  participantUpdatedSchema,
  peerPlaybackStateSchema,
  activeSpeakerSchema,
  errorSchema,
  roomEndedSchema,
]);
