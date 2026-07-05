/**
 * オーナー用ルーム一覧ページ（`/rooms`）。
 *
 * 認証は `(owner)/layout.tsx` で担保済み（未ログインは `/login` へ redirect）。
 * ここでは RLS（`owner_user_id = auth.uid()`）に加え、クエリ側でも
 * `.eq("owner_user_id", user.id)` を明示する（RLS 任せにしない多層防御、
 * `docs/design/supabase-design.md#rls-ポリシー` 参照）。表示順は作成日時降順
 * とし、`rooms_owner_user_id_created_at_idx`（`docs/design/db-design.md#インデックス戦略`）
 * と整合させる。
 *
 * @see docs/design/frontend-design.md#画面一覧とコンポーネント種別
 * @see docs/design/app-architecture.md#clientserver-component-境界とデータ取得
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RoomList, type RoomListItem } from "./RoomList";
import styles from "./page.module.css";

export default async function RoomsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // `(owner)/layout.tsx` で担保済みだが、RLS 任せにせずクエリ側でも
    // 所有者を明示することで多層防御とする（意図の可読性向上も兼ねる）。
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("rooms")
    .select("id, status, created_at")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: false });

  const rooms: RoomListItem[] = (data ?? []).map((room) => ({
    id: room.id as string,
    status: room.status as RoomListItem["status"],
    createdAt: room.created_at as string,
  }));

  return (
    <main className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>ルーム一覧</h1>
        <Link href="/rooms/new" className={styles.newRoomLink}>
          新規ルーム作成
        </Link>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          ルーム一覧の取得に失敗しました。時間をおいて再度お試しください。
        </p>
      )}

      {!error && <RoomList rooms={rooms} />}
    </main>
  );
}
