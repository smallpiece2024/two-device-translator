/**
 * ゲスト参加 Route Handler（`POST /api/guest/join`）。
 *
 * ゲストは Supabase セッションを持たないため、招待トークンの照合・
 * `participants` 行の作成は管理者権限クライアント（`src/lib/supabase/admin.ts`、
 * service_role 相当。docs/design/overview.md D-11）で行う。
 *
 * 手順:
 *   1. `inviteToken` を `invites` から**原子的に消費**する
 *      （`update ... where token=? and used_at is null and expires_at > now()`
 *      を1文で実行し、`used_at` を書き込む。bd-1oy: 単回消費化。
 *      同時に2リクエストが来ても消費に成功するのは片方だけになる。TOCTOU完全解消）
 *   2. 消費できた invite の room が `status=active` か確認
 *      （非active・不整合の場合は消費を取り消す補償を行う。後述コメント参照）
 *   3. `participants` に guest 行を insert
 *      （`role='guest'`、`guest_cookie_id` は新規UUID、CHECK制約に適合）
 *      失敗した場合は招待の消費を取り消す補償を行う（best-effort）。
 *   4. `signGuestToken({ roomId, participantId })` でゲスト識別JWTを発行
 *   5. `gtt_guest` クッキーを httpOnly・sameSite=lax・path=/・maxAge=JWTと同一TTL でセット
 *   6. `{ roomId }` を返す（画面遷移はクライアント側で行う）
 *
 * 消費順序の設計判断（bd-1oy、テスト担当への引き継ぎ事項）:
 *   - room の status（active か）は `invites` 単体の WHERE 句だけでは判定できない
 *     （`rooms` との結合が必要）ため、まず token/used_at/expires_at のみで
 *     原子的に消費し、その後で room.status を確認する2段構成にした。
 *   - 消費後に room が非active と判明した場合、または participants insert が
 *     失敗した場合は、`used_at` を null に戻す補償更新を行う（best-effort。
 *     補償自体が失敗してもユーザーには一律のエラー文言のみを返す）。
 *   - この設計では「消費 → room非active判明 → 補償」の間、ごく短時間だけ
 *     トークンが使用済み状態になるが、他リクエストが同時にこの隙間を突いて
 *     消費に成功することはない（このリクエストが既に消費済みにしているため）。
 *     よって「同一トークンで複数の participants 行が作られる」ことは発生しない
 *     （このタスクの目的である単回消費化は補償の有無に関わらず担保される）。
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

/**
 * 消費済みにした invite の `used_at` を null に戻す（best-effort 補償）。
 *
 * 呼び出し元では既に別のエラーレスポンスを返すことが確定しているため、
 * ここでの失敗はログ出力のみに留め、レスポンス内容には影響させない
 * （一律のエラー文言のみを返す方針を維持するため）。
 */
async function compensateInviteConsumption(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  inviteId: string
): Promise<void> {
  const { error } = await supabase
    .from("invites")
    .update({ used_at: null })
    .eq("id", inviteId);

  if (error) {
    console.error(
      "[api/guest/join] failed to compensate invite consumption",
      error.message
    );
  }
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
  const nowIso = new Date().toISOString();

  // 原子的消費: token/used_at/expires_at の条件を満たす行のみ used_at を
  // 書き込む。この1文がヒットするのは常に高々1リクエストのみ
  // （同時リクエストがあっても後発は0行ヒットになる）。
  const { data: consumedInvite, error: consumeError } = await supabase
    .from("invites")
    .update({ used_at: nowIso })
    .eq("token", inviteToken)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("id, room_id, room:rooms(status)")
    .maybeSingle();

  if (consumeError) {
    console.error("[api/guest/join] failed to consume invite", consumeError.message);
    return errorResponse(500, "参加処理に失敗しました。時間をおいて再度お試しください。");
  }

  if (!consumedInvite) {
    // 存在しない・使用済み・期限切れのいずれも一律の文言で返す
    // （内部状態を推測されないため）。
    return errorResponse(410);
  }

  const inviteId = consumedInvite.id as string;
  const room = consumedInvite.room as { status?: string } | { status?: string }[] | null;
  const roomStatus = Array.isArray(room) ? room[0]?.status : room?.status;

  if (roomStatus !== "active") {
    await compensateInviteConsumption(supabase, inviteId);
    return errorResponse(410);
  }

  const roomId = consumedInvite.room_id as string;
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
    await compensateInviteConsumption(supabase, inviteId);
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
