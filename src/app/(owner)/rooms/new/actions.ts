"use server";

/**
 * ルーム作成 Server Action。
 *
 * `docs/design/app-architecture.md#next-js-ページ構成とルーティング` の
 * `/rooms/new` = 「認証必須 / ルーム作成（Server Action）」方針に従う。
 *
 * `rooms` の insert は RLS 上 `owner_user_id = auth.uid()` であれば
 * authenticated ロールで可能なため（`docs/design/supabase-design.md#rls-ポリシー`
 * `rooms_insert_own`）、管理者権限クライアントは不要。`src/lib/supabase/server.ts`
 * （ユーザーセッション・RLS適用）で完結する。
 *
 * 参加者行（`participants`）の作成はこのタスクの対象外とする:
 * `participants` への insert は管理者権限クライアント限定であり
 * （`docs/design/supabase-design.md` の管理者権限クライアント使用箇所の節）、オーナー自身の
 * participant 行は WS の `join` 時に WSサーバー（管理者権限クライアント保持）が
 * 作成する方が設計の責務分担に沿う（`docs/design/app-architecture.md#フロント--wsサーバーの責務分担`
 * 「ルーム/セッション/参加者/話者識別...」は WSサーバー担当）。ここで先回りして
 * 作成すると WS 側の participant 復帰ロジックと二重管理になるため作らない。
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface CreateRoomState {
  error: string | null;
}

export const initialCreateRoomState: CreateRoomState = { error: null };

/** `plans` にも `user_profiles` にも該当行が見つからない場合のフォールバック上限。 */
const FALLBACK_MAX_PARTICIPANTS = 2;

export async function createRoomAction(
  // useActionState の契約上 (prevState, formData) の2引数が必須だが、
  // このアクションは入力フォームを持たないため両方とも未使用。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prevState: CreateRoomState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData
): Promise<CreateRoomState> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { error: "ログインが必要です。再度ログインしてください。" };
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("plan_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    console.error(
      "[createRoomAction] failed to load user_profiles",
      profileError?.message
    );
    return {
      error: "プロフィールの取得に失敗しました。時間をおいて再度お試しください。",
    };
  }

  let maxParticipants = FALLBACK_MAX_PARTICIPANTS;
  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("max_participants")
    .eq("id", profile.plan_id)
    .single();

  if (planError || !plan) {
    console.error("[createRoomAction] failed to load plan", planError?.message);
  } else {
    maxParticipants = plan.max_participants as number;
  }

  const { data: room, error: insertError } = await supabase
    .from("rooms")
    .insert({
      owner_user_id: user.id,
      status: "active",
      max_participants: maxParticipants,
    })
    .select("id")
    .single();

  if (insertError || !room) {
    console.error("[createRoomAction] failed to insert room", insertError?.message);
    return {
      error: "ルームの作成に失敗しました。時間をおいて再度お試しください。",
    };
  }

  redirect(`/room/${room.id}`);
}
