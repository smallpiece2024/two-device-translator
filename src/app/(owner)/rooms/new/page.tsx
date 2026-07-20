/**
 * ルーム作成ページ（`/rooms/new`）。
 *
 * 認証は `(owner)/layout.tsx` で担保済み。実際の作成処理は
 * `CreateRoomForm`（Client Component）から `createRoomAction`
 * （Server Action、`./actions.ts`）を呼び出して行う。
 *
 * @see docs/design/app-architecture.md#next-js-ページ構成とルーティング
 */
import { CreateRoomForm } from "./CreateRoomForm";
import styles from "./page.module.css";

export default function NewRoomPage() {
  return (
    <main className={styles.container}>
      <h1 className={styles.title}>新規ルーム作成</h1>
      <CreateRoomForm />
    </main>
  );
}
