/**
 * WebSocketメッセージの型定義。
 * `shared/ws-protocol/schema.ts` の zod スキーマから `z.infer` で導出する
 * ことで、スキーマと型が乖離しないようにする。
 */
import type { z } from "zod";
import type {
  joinSchema,
  updateSettingsSchema,
  startSchema,
  audioClientSchema,
  commitSchema,
  stopSchema,
  requestEndSchema,
  playbackStateSchema,
  audioLevelSchema,
  peerPlaybackStateSchema,
  activeSpeakerSchema,
  clientMessageSchema,
  participantSummarySchema,
  joinedSchema,
  transcriptInterimSchema,
  transcriptFinalSchema,
  utteranceCommitReasonSchema,
  utteranceCommittedSchema,
  messageSchema,
  audioServerSchema,
  participantJoinedSchema,
  participantLeftReasonSchema,
  participantLeftSchema,
  participantUpdatedSchema,
  errorSchema,
  roomEndedReasonSchema,
  roomEndedSchema,
  serverMessageSchema,
} from "./schema";

// client → server
export type JoinMessage = z.infer<typeof joinSchema>;
export type UpdateSettingsMessage = z.infer<typeof updateSettingsSchema>;
export type StartMessage = z.infer<typeof startSchema>;
export type AudioClientMessage = z.infer<typeof audioClientSchema>;
export type CommitMessage = z.infer<typeof commitSchema>;
export type StopMessage = z.infer<typeof stopSchema>;
/** オーナーによるルーム終了要求（bd-e3p） */
export type RequestEndMessage = z.infer<typeof requestEndSchema>;
/** 自デバイスのTTS再生状態通知（相互半二重化、bd-rwi） */
export type PlaybackStateMessage = z.infer<typeof playbackStateSchema>;
/** マイク入力レベル通知（話者交代制、bd-6h1） */
export type AudioLevelMessage = z.infer<typeof audioLevelSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// server → client
export type ParticipantSummary = z.infer<typeof participantSummarySchema>;
export type JoinedMessage = z.infer<typeof joinedSchema>;
export type TranscriptInterimMessage = z.infer<typeof transcriptInterimSchema>;
export type TranscriptFinalMessage = z.infer<typeof transcriptFinalSchema>;
/** 発話確定理由。`server/utterance/utteranceBuffer.ts` の型定義もこれを参照する */
export type UtteranceCommitReason = z.infer<typeof utteranceCommitReasonSchema>;
export type UtteranceCommittedMessage = z.infer<
  typeof utteranceCommittedSchema
>;
export type MessageMessage = z.infer<typeof messageSchema>;
export type AudioServerMessage = z.infer<typeof audioServerSchema>;
export type ParticipantJoinedMessage = z.infer<typeof participantJoinedSchema>;
/** 退室理由（bd-e3p）。`"disconnected"` | `"ended"` */
export type ParticipantLeftReason = z.infer<typeof participantLeftReasonSchema>;
export type ParticipantLeftMessage = z.infer<typeof participantLeftSchema>;
/** 参加者の設定変更イベント（bd-ecb で言語検出モード確定通知として追加。bd-fki で拡張） */
export type ParticipantUpdatedMessage = z.infer<typeof participantUpdatedSchema>;
/** 他参加者のTTS再生状態の中継（相互半二重化、bd-rwi） */
export type PeerPlaybackStateMessage = z.infer<typeof peerPlaybackStateSchema>;
/** 現在の話者の通知（話者交代制、bd-6h1）。`participantId: null` は話者なし */
export type ActiveSpeakerMessage = z.infer<typeof activeSpeakerSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
/** ルーム終了理由（bd-e3p）。`"owner_ended"` | `"auto_timeout"` */
export type RoomEndedReason = z.infer<typeof roomEndedReasonSchema>;
export type RoomEndedMessage = z.infer<typeof roomEndedSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * WebSocket close コード: 同一参加者の**新しい接続に置き換えられた**ことを示す
 * （サーバーが古い接続を閉じる際に使用。RFC 6455 のアプリケーション定義領域
 * 4000-4999）。
 *
 * このコードで閉じられた側は**再接続してはならない**。再接続すると今度は
 * 新しい接続側が置き換えられて閉じられ、互いに蹴り合う無限ループになる
 * （bd-8x0 で本番発生。同一ルームを2ウィンドウで開いた場合など）。
 */
export const WS_CLOSE_CODE_SUPERSEDED = 4000;
