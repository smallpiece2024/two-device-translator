/**
 * ゲスト招待リンクの着地ページ（`/join/[inviteToken]`）。
 *
 * QR読み込み・招待URLアクセス時にトークンを照合し、有効なら参加フォーム
 * （`JoinInviteForm`）を表示する。無効・期限切れの場合は日本語のエラー画面を表示する
 * （`docs/design/supabase-design.md#ゲストのクッキー識別との連携` の参加フローに対応）。
 *
 * `invites` テーブルの select は RLS 上「本人所有ルーム」に限定されており
 * （`docs/design/supabase-design.md#rls-ポリシー`）、ゲストは Supabase セッションを
 * 持たないため anon では参照できない。トークン照合ロジックは匿名ロールに開放せず
 * 「Route Handler / Server Component から service_role相当で行う」との設計方針
 * （同ドキュメント最終箇条）に従い、本ページ（Server Component）から管理者権限
 * クライアント（`src/lib/supabase/admin.ts`）で読み取り専用の照合を行う。
 *
 * 実際の参加確定（`participants` 行作成・クッキー発行）は `POST /api/guest/join`
 * （`../../api/guest/join/route.ts`）が担う。このページでの照合は「フォームを
 * 見せてよいか」の事前判定のみで、実際の参加処理では再度トークンを照合する
 * （TOCTOU対策。表示から送信までの間に期限切れ・無効化される可能性があるため）。
 *
 * 単回消費化（bd-1oy）: `used_at` が設定済み（＝既に消費済み）の招待は
 * 期限切れ等と同様に無効として扱う。実際の消費（`used_at` の書き込み）は
 * `POST /api/guest/join` が原子的に行うため、本ページでの `used_at is null`
 * 判定は「消費済みなら事前にエラー画面を出す」ための読み取り専用チェックに過ぎず、
 * ここで消費を確定させるものではない。
 */
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { JoinInviteForm } from "./JoinInviteForm";
import styles from "./page.module.css";

interface JoinPageProps {
  params: Promise<{ inviteToken: string }>;
}

async function isInviteValid(inviteToken: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();

  const { data: invite, error } = await supabase
    .from("invites")
    .select("expires_at, room:rooms(status)")
    .eq("token", inviteToken)
    .is("used_at", null)
    .maybeSingle();

  if (error) {
    console.error("[JoinPage] failed to look up invite", error.message);
    return false;
  }

  if (!invite) {
    return false;
  }

  const expiresAt = new Date(invite.expires_at as string);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return false;
  }

  const room = invite.room as { status?: string } | { status?: string }[] | null;
  const roomStatus = Array.isArray(room) ? room[0]?.status : room?.status;
  return roomStatus === "active";
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { inviteToken } = await params;
  const valid = await isInviteValid(inviteToken);

  if (!valid) {
    return (
      <main className={styles.container}>
        <h1 className={styles.title}>招待リンクが無効です</h1>
        <p className={styles.error} role="alert">
          この招待リンクは無効か、有効期限が切れています。招待した相手に新しいリンクの発行を依頼してください。
        </p>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <JoinInviteForm inviteToken={inviteToken} />
    </main>
  );
}
