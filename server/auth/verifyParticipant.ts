/**
 * `join` メッセージの認証・検証（Phase2 本実装）。
 *
 * role に応じて検証方式を分岐する
 * （docs/design/server-design.md「接続時認証（verifyParticipant）」、
 * docs/design/security-design.md「認証フロー」参照）。
 *
 * | role  | 検証方法                                                                   |
 * |-------|-----------------------------------------------------------------------------|
 * | owner | `token` を Supabase アクセストークンとして `supabaseAdmin.auth.getUser` で検証し、
 * |       | `sub`(userId) がルームの `owner_user_id` と一致することを確認する           |
 * | guest | `shared/auth/guestToken.ts` の `verifyGuestToken` で検証し、payload の
 * |       | `roomId` が join 先の `roomId` と一致することを確認する                     |
 *
 * 検証失敗（トークン不正・期限切れ・roomId不一致・所有者不一致等）は `null` を
 * 返す。呼び出し側（`server/index.ts`）は `error(fatal:true)` で接続を閉じる。
 * 失敗理由はサーバーログにのみ出す（トークン本文・鍵は出さない）。
 *
 * ## 移行互換モード（`AUTH_MODE=insecure`）
 *
 * ログインUI（bd-63d）・招待フロー（bd-jny）が未実装のため、既定の厳格検証
 * （strict）のままでは既存の Playwright E2E（仮トークンでの join）や
 * `npm run dev` の手動確認が成立しない。`GCP_MODE=mock` と同じ流儀で、
 * 環境変数 `AUTH_MODE=insecure` のときのみ Phase1 相当のダミー検証（token の
 * 中身を見ず常に成功）に切り替える。**本番では絶対に設定しないこと**
 * （起動時に `server/index.ts` が警告ログを出す）。
 *
 * `server/index.ts` はこのモジュールの `verifyJoin` を注入可能な形で受け取り、
 * 差し替え（テスト用モック含む）を容易にする。
 */
import { randomUUID } from "node:crypto";
import type { JoinMessage } from "@shared/index";
import { verifyGuestToken } from "@shared/index";
import type { ParticipantIdentity } from "../room/session";
import { getSupabaseAdminClient } from "../db/supabaseAdmin";

/**
 * `AUTH_MODE=insecure` のとき true（token の中身を検証しない Phase1 相当の
 * ダミー実装で動作させる。本番使用禁止）。
 */
export function isInsecureAuthMode(): boolean {
  return process.env.AUTH_MODE === "insecure";
}

/**
 * Phase1 相当のダミー検証（`AUTH_MODE=insecure` 専用）。
 * token の非空は zod スキーマで保証済みのため、常に成功として新しい
 * `participantId` を発行する。
 */
function verifyJoinInsecure(join: JoinMessage): ParticipantIdentity {
  return {
    participantId: randomUUID(),
    role: join.role,
    displayName: join.displayName,
    language: join.language,
  };
}

/**
 * owner の `join.token`（Supabase アクセストークン）を検証する。
 *
 * - `supabaseAdmin.auth.getUser(token)` でトークンの正当性とユーザーを取得。
 * - 対象ルーム（`rooms.id = join.roomId`）の `owner_user_id` を取得し、
 *   トークンのユーザーIDと一致することを確認する。
 * - トークン不正／ルーム不存在／所有者不一致はすべて `null`（理由はログにのみ出す）。
 *
 * `participantId` は現時点では毎回新規発行する（オーナーの再接続時の安定ID
 * 復帰は、ルーム作成時に participants 行を発行する招待フロー実装後の
 * 別タスクで対応する）。
 */
async function verifyOwnerJoin(join: JoinMessage): Promise<ParticipantIdentity | null> {
  const supabase = getSupabaseAdminClient();

  const { data: userData, error: userError } = await supabase.auth.getUser(join.token);
  if (userError || !userData.user) {
    console.error(
      "[verifyParticipant] owner token verification failed:",
      userError?.message ?? "no user returned",
    );
    return null;
  }

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("owner_user_id")
    .eq("id", join.roomId)
    .single<{ owner_user_id: string }>();

  if (roomError || !room) {
    console.error(
      "[verifyParticipant] owner join failed: room not found",
      roomError?.message ?? join.roomId,
    );
    return null;
  }

  if (room.owner_user_id !== userData.user.id) {
    console.error("[verifyParticipant] owner join failed: user is not the room owner");
    return null;
  }

  return {
    participantId: randomUUID(),
    role: "owner",
    displayName: join.displayName,
    language: join.language,
  };
}

/**
 * guest の `join.token`（ゲスト識別JWT）を検証する。
 *
 * - `verifyGuestToken` で署名・期限を検証（不正・期限切れは null）。
 * - payload の `roomId` が join 先の `roomId` と一致することを確認する
 *   （他ルーム向けに発行されたトークンでの join を拒否する）。
 * - `participantId` は payload 由来の安定IDを用いる（再接続時の同一参加者復帰の土台）。
 *
 * DB の Participant 行の存在確認は、招待フロー（ゲスト参加時の行作成、
 * bd-jny）実装後に別タスクで追加する（現時点では participants 行を
 * 事前作成する経路が無いため、トークンの署名・roomId 整合のみで判定する）。
 */
async function verifyGuestJoin(join: JoinMessage): Promise<ParticipantIdentity | null> {
  const payload = await verifyGuestToken(join.token);
  if (!payload) {
    return null;
  }

  if (payload.roomId !== join.roomId) {
    console.error("[verifyParticipant] guest join failed: roomId mismatch");
    return null;
  }

  return {
    participantId: payload.participantId,
    role: "guest",
    displayName: join.displayName,
    language: join.language,
  };
}

/**
 * `join` メッセージを検証し、参加者の識別情報を返す。
 * 検証に失敗した場合は `null` を返す（呼び出し側は `error(fatal:true)` で
 * 接続を閉じる）。
 *
 * `AUTH_MODE=insecure` のときは role によらず常に成功する（本番使用禁止）。
 */
export async function verifyJoin(join: JoinMessage): Promise<ParticipantIdentity | null> {
  if (isInsecureAuthMode()) {
    return verifyJoinInsecure(join);
  }

  if (join.role === "owner") {
    return verifyOwnerJoin(join);
  }

  return verifyGuestJoin(join);
}

/** `verifyJoin` と同じシグネチャの関数型（差し替え・テスト用モック向け） */
export type VerifyJoinFn = typeof verifyJoin;
