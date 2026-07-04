/**
 * WebSocketメッセージの zod スキーマ定義。
 *
 * Next.js（src/）と WSサーバー（server/）の型ドリフトを防ぐため、この
 * ファイルを唯一の正本とする（docs/design/websocket-protocol.md 参照）。
 *
 * 本ファイルは Phase1 の範囲（join / start / audio / commit / stop、および
 * joined / transcript_interim / transcript_final / utterance_committed /
 * message / audio / error）のみを定義する。Phase2/3 のメッセージ
 * （update_settings, request_end, participant_*, idle_hint, summary,
 * room_ended 等）は将来追加する。`z.discriminatedUnion` は配列へスキーマを
 * 追加するだけで拡張できるため、追加を阻害しない設計になっている。
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

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinSchema,
  startSchema,
  audioClientSchema,
  commitSchema,
  stopSchema,
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

/** 発話区切り確定（話者本人にのみ） */
export const utteranceCommittedSchema = z.object({
  type: z.literal("utterance_committed"),
  text: z.string(),
  reason: z.enum(["silence", "maxChars", "maxSeconds", "commit", "stop"]),
});

/** 合成音声（mp3 base64）。TTS ON の聞き手へ配信 */
export const audioServerSchema = z.object({
  type: z.literal("audio"),
  messageId: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string().min(1),
});

/** エラー通知。`fatal:true` の場合は接続終了 */
export const errorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  fatal: z.boolean(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  joinedSchema,
  transcriptInterimSchema,
  transcriptFinalSchema,
  utteranceCommittedSchema,
  messageSchema,
  audioServerSchema,
  errorSchema,
]);
