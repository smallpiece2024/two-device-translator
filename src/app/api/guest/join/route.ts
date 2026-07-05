/**
 * ゲスト参加 Route Handler（`POST /api/guest/join`）。
 *
 * ゲストは Supabase セッションを持たないため、招待トークンの照合・
 * `participants` 行の作成は管理者権限クライアント（`src/lib/supabase/admin.ts`、
 * service_role 相当。docs/design/overview.md D-11）で行う。
 *
 * 手順:
 *   1. `inviteToken` を `invites` から照合（存在・`expires_at`・所属 `room.status=active`）
 *   2. `participants` に guest 行を insert
 *      （`role='guest'`、`guest_cookie_id` は新規UUID、CHECK制約に適合）
 *   3. `signGuestToken({ roomId, participantId })` でゲスト識別JWTを発行
 *   4. `gtt_guest` クッキーを httpOnly・sameSite=lax・path=/・maxAge=JWTと同一TTL でセット
 *   5. `{ roomId }` を返す（画面遷移はクライアント側で行う）
 *
 * エラーは一律の日本語文言のみを返し、トークンの有効性以外の内部情報
 * （DBエラー詳細等）は漏らさない（このタスクの指示事項）。
 * レート制限・bot対策はスコープ外。
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { LanguageEnum } from "@shared/index";
import {
  signGuestToken,
  GUEST_COOKIE_NAME,
  DEFAULT_GUEST_TOKEN_TTL_SEC,
} from "@shared/auth/guestToken";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const requestBodySchema = z.object({
  inviteToken: z.string().min(1),
  displayName: z.string().trim().max(50).optional(),
  language: LanguageEnum,
});

/** 一律のエラー文言（内部情報を漏らさないため、原因によらず同一文言とする）。 */
const GENERIC_ERROR_MESSAGE =
  "この招待リンクは無効か、有効期限が切れています。招待した相手に新しいリンクの発行を依頼してください。";

function errorResponse(status: number, message = GENERIC_ERROR_MESSAGE) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "リクエストの形式が正しくありません。");
  }

  const parsed = requestBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "入力内容を確認してください。");
  }

  const { inviteToken, displayName, language } = parsed.data;
  const supabase = getSupabaseAdminClient();

  const { data: invite, error: inviteError } = await supabase
    .from("invites")
    .select("room_id, expires_at, room:rooms(status)")
    .eq("token", inviteToken)
    .maybeSingle();

  if (inviteError) {
    console.error("[api/guest/join] failed to look up invite", inviteError.message);
    return errorResponse(500, "参加処理に失敗しました。時間をおいて再度お試しください。");
  }

  if (!invite) {
    return errorResponse(404);
  }

  const expiresAt = new Date(invite.expires_at as string);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return errorResponse(410);
  }

  const room = invite.room as { status?: string } | { status?: string }[] | null;
  const roomStatus = Array.isArray(room) ? room[0]?.status : room?.status;
  if (roomStatus !== "active") {
    return errorResponse(410);
  }

  const roomId = invite.room_id as string;
  const guestCookieId = crypto.randomUUID();

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .insert({
      room_id: roomId,
      role: "guest",
      guest_cookie_id: guestCookieId,
      display_name: displayName ?? null,
      language,
    })
    .select("id")
    .single();

  if (participantError || !participant) {
    console.error(
      "[api/guest/join] failed to create participant",
      participantError?.message
    );
    return errorResponse(500, "参加処理に失敗しました。時間をおいて再度お試しください。");
  }

  const participantId = participant.id as string;
  const token = await signGuestToken({ roomId, participantId });

  const response = NextResponse.json({ roomId });
  response.cookies.set(GUEST_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // クッキーの有効期限をJWT本体のTTL（既定7日、shared/auth/guestToken.ts）と
    // 一致させる。指定しないとセッションクッキー（ブラウザを閉じるまで）扱いに
    // なり、JWTは失効しているのにクッキーだけ残る/ブラウザを閉じるとJWTがまだ
    // 有効なのにクッキーが消える、という不整合が生じるため。
    maxAge: DEFAULT_GUEST_TOKEN_TTL_SEC,
  });

  return response;
}
