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
/** 参加者の設定変更イベント（bd-ecb で言語検出モード確定通知として追加） */
export type ParticipantUpdatedMessage = z.infer<typeof participantUpdatedSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
/** ルーム終了理由（bd-e3p）。`"owner_ended"` | `"auto_timeout"` */
export type RoomEndedReason = z.infer<typeof roomEndedReasonSchema>;
export type RoomEndedMessage = z.infer<typeof roomEndedSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
