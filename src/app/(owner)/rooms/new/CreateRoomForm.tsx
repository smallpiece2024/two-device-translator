"use client";

/**
 * ルーム作成フォーム（`/rooms/new`）。
 *
 * 現行スキーマの `rooms` テーブルにルーム名の列が無いため
 * （`RoomList.tsx` のコメント、`docs/design/db-design.md#rooms` 参照）、
 * 入力項目は無く「作成する」ボタンのみで `createRoomAction`（Server Action）
 * を呼び出す。作成成功時は Server Action 内で作成したルームへ redirect する。
 */
import { useActionState } from "react";
import Link from "next/link";
import { createRoomAction, initialCreateRoomState } from "./actions";
import styles from "./CreateRoomForm.module.css";

export function CreateRoomForm() {
  const [state, formAction, isPending] = useActionState(
    createRoomAction,
    initialCreateRoomState
  );

  return (
    <form className={styles.form} action={formAction} aria-label="ルーム作成フォーム">
      <p className={styles.description}>
        新しいルームを作成します。作成後、招待用のリンクで相手を招待できます。
      </p>

      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}

      <div className={styles.actions}>
        <Link href="/rooms" className={styles.cancelLink}>
          キャンセル
        </Link>
        <button type="submit" className={styles.submitButton} disabled={isPending}>
          {isPending ? "作成中..." : "ルームを作成する"}
        </button>
      </div>
    </form>
  );
}
