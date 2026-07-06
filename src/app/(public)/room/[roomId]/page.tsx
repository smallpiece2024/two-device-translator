/**
 * トークルーム画面（Server Component）。
 *
 * URL直打ちでの参加（簡易ルーム参加）に対応するため、まず `JoinForm` で
 * 表示名・話す言語・roleを選択させ、送信後に `RoomClient` をマウントして
 * WS接続・`join` 送信を開始する（`JoinForm` 内で結線）。
 * ルームはサーバー側で初回join時に自動作成される（`server/room/roomManager.ts`）。
 *
 * ## 認証トークンの結線（bd-2el 後続、オーナー結線）
 * - **オーナー**: Supabase セッションがあり、かつ `rooms.owner_user_id` が
 *   本人と一致する場合のみ、セッションのアクセストークンを `ownerToken` として
 *   `JoinForm`（→ `RoomClient` → WS `join.token`）へ渡す。WSサーバーの厳格検証
 *   （`server/auth/verifyParticipant.ts` の owner 分岐）がこのトークンを検証する。
 * - **ゲスト**: ゲスト参加フロー（`POST /api/guest/join`）で発行された
 *   `gtt_guest` クッキーが存在すれば `guestToken` として渡す
 *   （`docs/design/supabase-design.md#ゲストのクッキー識別との連携`）。
 * - オーナーと判定された場合は `guestToken` を渡さない（同一ブラウザで
 *   ゲスト参加の試験をした後などにクッキーが残っていても、オーナーとしての
 *   入室を優先する）。
 * - どちらも無い場合は従来どおり `JoinForm` を表示する（dev/E2E の
 *   `AUTH_MODE=insecure` 互換。本番の厳格検証では join が拒否される）。
 *
 * トークンの署名検証自体は WSサーバー側の責務であり、ここでは値の受け渡しのみ行う。
 */
import { cookies } from "next/headers";
import { GUEST_COOKIE_NAME } from "@shared/auth/guestToken";
import { createClient } from "@/lib/supabase/server";
import { JoinForm } from "./JoinForm";

const DEFAULT_WS_URL = "ws://localhost:3001/ws";

interface RoomPageProps {
  params: Promise<{ roomId: string }>;
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomId } = await params;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL;
  const cookieStore = await cookies();
  const guestToken = cookieStore.get(GUEST_COOKIE_NAME)?.value;

  // オーナー判定: 検証済みユーザー（getUser）が当該ルームの所有者であれば、
  // セッションのアクセストークンを WS join 用に渡す。rooms の select は
  // RLS（owner_user_id = auth.uid()）でも守られており、クエリ側の .eq と
  // 合わせて多層防御とする（rooms-page.tsx と同じ方針）。
  let ownerToken: string | undefined;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: ownedRoom, error: roomLookupError } = await supabase
      .from("rooms")
      .select("id")
      .eq("id", roomId)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (roomLookupError) {
      // 失敗時は安全側（ownerToken未設定＝オーナー扱いしない）に倒すが、
      // 一時的なDB障害の切り分けができるようログは残す（レビュー指摘）。
      console.error("[RoomPage] failed to look up room ownership", roomLookupError.message);
    }

    if (ownedRoom) {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      ownerToken = session?.access_token;
    }
  }

  return (
    <JoinForm
      roomId={roomId}
      wsUrl={wsUrl}
      ownerToken={ownerToken}
      guestToken={ownerToken ? undefined : guestToken}
    />
  );
}
