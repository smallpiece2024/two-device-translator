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
  participantLeftSchema,
  errorSchema,
  serverMessageSchema,
} from "./schema";

// client → server
export type JoinMessage = z.infer<typeof joinSchema>;
export type UpdateSettingsMessage = z.infer<typeof updateSettingsSchema>;
export type StartMessage = z.infer<typeof startSchema>;
export type AudioClientMessage = z.infer<typeof audioClientSchema>;
export type CommitMessage = z.infer<typeof commitSchema>;
export type StopMessage = z.infer<typeof stopSchema>;
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
export type ParticipantLeftMessage = z.infer<typeof participantLeftSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
