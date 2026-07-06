/**
 * トップページ（`/`）。
 *
 * - ログイン済みオーナー: `/rooms` へ redirect する（ルーム一覧が実質のホーム）。
 * - 未ログイン: サービス紹介＋ログイン導線（`/login`）のランディングを表示する。
 * - ゲストは招待QR（`/join/[inviteToken]`）から参加するため、トップページに
 *   ゲスト用の導線は置かない（案内文のみ）。
 *
 * 認証確認は `(owner)` 配下と同じ `createClient()` → `auth.getUser()` の
 * Server Component パターン（bd-6ez。docs/design/frontend-design.md 参照）。
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import styles from "./page.module.css";

export default async function Home() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/rooms");
  }

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>two-device-translator</h1>
      <p className={styles.description}>
        対面のためのリアルタイム通訳サービス。
        2つのデバイスで、それぞれの言語で話して、それぞれの言語で読めます。
      </p>
      <Link href="/login" className={styles.loginLink}>
        ログイン / はじめる
      </Link>
      <p className={styles.guestNote}>
        招待QRコードを受け取った方は、そのQRコードを読み取って参加してください。
      </p>
    </main>
  );
}
