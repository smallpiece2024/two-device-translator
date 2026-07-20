/**
 * オーナーのルーム一覧（表示専用 Server Component）。
 *
 * データ取得は `page.tsx` が行い、本コンポーネントは受け取った一覧を
 * 表示するのみ（`docs/design/frontend-design.md#画面一覧とコンポーネント種別`
 * の `RoomList` に対応）。
 *
 * 現行スキーマ（`supabase/migrations/20260705063916_phase2_auth_room.sql`）の
 * `rooms` テーブルにルーム名の列が無いため、識別は状態と作成日時で行う
 * （`docs/design/db-design.md#rooms` にも名称カラムの記載なし）。
 */
import Link from "next/link";
import styles from "./RoomList.module.css";

export interface RoomListItem {
  id: string;
  status: "active" | "ended";
  createdAt: string;
}

export interface RoomListProps {
  rooms: RoomListItem[];
}

const STATUS_LABEL: Record<RoomListItem["status"], string> = {
  active: "進行中",
  ended: "終了",
};

function formatCreatedAt(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function RoomList({ rooms }: RoomListProps) {
  if (rooms.length === 0) {
    return (
      <div className={styles.empty}>
        <p>まだルームがありません。</p>
        <Link href="/rooms/new" className={styles.emptyCreateLink}>
          最初のルームを作成する
        </Link>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {rooms.map((room) => (
        <li key={room.id} className={styles.item}>
          <div className={styles.itemInfo}>
            <span
              className={
                room.status === "active"
                  ? `${styles.statusBadge} ${styles.statusActive}`
                  : `${styles.statusBadge} ${styles.statusEnded}`
              }
            >
              {STATUS_LABEL[room.status]}
            </span>
            <span className={styles.createdAt}>{formatCreatedAt(room.createdAt)} 作成</span>
          </div>
          <div className={styles.itemActions}>
            {room.status === "active" && (
              <Link href={`/rooms/${room.id}/invite`} className={styles.inviteLink}>
                招待
              </Link>
            )}
            <Link href={`/room/${room.id}`} className={styles.enterLink}>
              入室する
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
