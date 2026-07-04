/**
 * `join` メッセージの認証・検証。
 *
 * Phase1 はダミー実装（token の中身は検証しない。zod により非空のみ保証済み）。
 * Phase2 で Supabase アクセストークン（owner）/ ゲストJWT（guest）の検証へ
 * 差し替える（docs/design/server-design.md「接続時認証（verifyParticipant）」参照）。
 *
 * `server/index.ts` はこのモジュールの `verifyJoin` を注入可能な形で受け取り、
 * 差し替え（テスト用モック含む）を容易にする。
 */
import { randomUUID } from "node:crypto";
import type { JoinMessage } from "@shared/index";
import type { ParticipantIdentity } from "../room/session";

/**
 * `join` メッセージを検証し、参加者の識別情報を返す。
 * 検証に失敗した場合は `null` を返す（呼び出し側は `error(fatal:true)` で
 * 接続を閉じる）。
 *
 * Phase1ダミー実装: token の非空は zod スキーマで保証済みのため、
 * ここでは常に成功として新しい `participantId` を発行する。
 * 再接続時に同一参加者として復帰する仕組み（安定ID）は Phase2 で追加する。
 */
export function verifyJoin(join: JoinMessage): ParticipantIdentity | null {
  return {
    participantId: randomUUID(),
    role: join.role,
    displayName: join.displayName,
    language: join.language,
  };
}

/** `verifyJoin` と同じシグネチャの関数型（差し替え・テスト用モック向け） */
export type VerifyJoinFn = typeof verifyJoin;
