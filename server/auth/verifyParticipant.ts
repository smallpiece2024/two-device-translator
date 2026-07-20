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

/** Postgres の一意制約違反エラーコード（`participants_room_owner_unique_idx`、bd-e3p マイグレーション参照） */
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

// `resolveOwnerParticipantId` の select 部分のみ抽出したヘルパー。
// 通常の照合と、insert 競合時の再照合（下記コードレビュー対応コメント参照）の
// 両方から使う。
async function selectOwnerParticipantId(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  roomId: string,
  userId: string,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("participants")
    .select("id")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error("[verifyParticipant] owner participant lookup error:", error.message);
    return { ok: false };
  }

  return { ok: true, id: data?.id ?? null };
}

/**
 * owner の `participants` 行を room_id + user_id + role='owner' で照合し、
 * 既存行があればその `id` を、無ければ新規 insert した行の `id` を返す
 * （bd-e3p: 再接続復帰の前提となる安定 participantId 化）。
 *
 * `display_name`/`language` は guest 側（`verifyGuestJoin`）と同じ方針で
 * **join メッセージの値を identity に採用し、既存行の DB 値は更新しない**。
 * 理由: これらは接続のたびにユーザーが変更しうる値であり、DB 側の更新は
 * `participant_updated` 配信時に別途行う運用（server-design.md「言語検出
 * モード」参照）とし、ここでの DB アクセスは「安定IDの解決」に限定して
 * 副作用（update）を持たせない（単純さ優先・YAGNI）。
 *
 * ## 同時 join の競合（TOCTOU）対策（コードレビュー指摘・bd-e3p 修正）
 *
 * 「select して無ければ insert」は、同一 (room_id, user_id, role='owner') に
 * 対する2つの join リクエストがほぼ同時に届くと、両方が select で
 * 「行なし」を確認したうえでそれぞれ insert してしまう TOCTOU 競合が起こり得る
 * （多重タブでの再接続・ネットワーク再送等）。DB 側に部分一意インデックス
 * （`supabase/migrations/..._participants_owner_unique.sql`）を追加した上で、
 * アプリ側は **insert が一意制約違反（Postgres `23505`）で失敗した場合、
 * 先に成功した側が作った行を select で取り直す**フォールバックを行う。
 * これにより通常時は従来どおり「select→（無ければ）insert」の1往復で完結し、
 * 競合が実際に起きた場合のみ追加の select が発生する（テスト互換・書き込み
 * 回数の両面で「常に insert を先に試みる」方式より単純）。
 */
async function resolveOwnerParticipantId(
  roomId: string,
  userId: string,
  join: JoinMessage,
): Promise<string | null> {
  const supabase = getSupabaseAdminClient();

  const existing = await selectOwnerParticipantId(supabase, roomId, userId);
  if (!existing.ok) {
    return null;
  }
  if (existing.id) {
    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("participants")
    .insert({
      room_id: roomId,
      role: "owner",
      user_id: userId,
      display_name: join.displayName ?? null,
      language: join.language,
      tts_enabled: join.enableTts,
    })
    .select("id")
    .single<{ id: string }>();

  if (!insertError && inserted) {
    return inserted.id;
  }

  if (insertError?.code === POSTGRES_UNIQUE_VIOLATION_CODE) {
    // 競合: 別の接続がこの between-select-and-insert の間に同じ行を
    // 作成済み。エラーにせず、その行を取り直して同じ participantId に揃える。
    console.warn(
      "[verifyParticipant] owner participant insert raced with a concurrent join; " +
        "re-selecting the row created by the other request",
    );
    const retry = await selectOwnerParticipantId(supabase, roomId, userId);
    if (retry.ok && retry.id) {
      return retry.id;
    }
    console.error(
      "[verifyParticipant] owner participant re-select after unique violation failed",
    );
    return null;
  }

  console.error(
    "[verifyParticipant] owner participant insert failed:",
    insertError?.message ?? "no row returned",
  );
  return null;
}

/**
 * owner の `join.token`（Supabase アクセストークン）を検証する。
 *
 * - `supabaseAdmin.auth.getUser(token)` でトークンの正当性とユーザーを取得。
 * - 対象ルーム（`rooms.id = join.roomId`）の `owner_user_id` を取得し、
 *   トークンのユーザーIDと一致することを確認する。
 * - トークン不正／ルーム不存在／所有者不一致はすべて `null`（理由はログにのみ出す）。
 * - `participantId` は `participants`（room_id + user_id + role='owner'）の
 *   安定ID（無ければ新規発行）を用いる（bd-e3p。再接続復帰の前提）。
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

  const participantId = await resolveOwnerParticipantId(join.roomId, userData.user.id, join);
  if (!participantId) {
    return null;
  }

  return {
    participantId,
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
 * - DB の `participants` 行が `id=payload.participantId AND room_id=payload.roomId
 *   AND role='guest'` で実在することを確認する（bd-jny の招待フロー実装により
 *   `/api/guest/join` が参加確定時に行を作成するようになったため、bd-0jy 時点の
 *   繰り延べ事項に対応）。行が無い場合はトークンの署名・roomId が正しくても
 *   認証失敗として扱う（招待取消・行削除後の古いクッキーでの再参加を拒否する）。
 * - `participantId` は payload 由来の安定IDを用いる（再接続時の同一参加者復帰の土台）。
 *
 * `displayName`/`language` は DB 行ではなく join メッセージの値を採用する。
 * これらは接続のたびにユーザーが変更しうる値（表示名編集・言語切替）であり、
 * DB 側の値は `participant_updated` 配信時に別途更新される運用（
 * docs/design/server-design.md「言語検出モード」参照）のため、ここでの
 * DB チェックは「行の存在（＝有効な参加者であること）」の確認に限定し、
 * identity の内容は join メッセージを正とする。
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

  const supabase = getSupabaseAdminClient();
  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id")
    .eq("id", payload.participantId)
    .eq("room_id", payload.roomId)
    .eq("role", "guest")
    .maybeSingle<{ id: string }>();

  if (participantError) {
    console.error(
      "[verifyParticipant] guest join failed: participants lookup error:",
      participantError.message,
    );
    return null;
  }

  if (!participant) {
    console.error("[verifyParticipant] guest join failed: participant row not found");
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
