/**
 * ゲスト招待ページ（`/rooms/[roomId]/invite`、オーナーのみ）。
 *
 * 対象ルームの招待を発行（または有効期限内の既存招待を再利用）し、
 * 参加URL（`https://{host}/join/{token}`）をQR＋URLテキストで表示する（FR-2.2）。
 *
 * 認証は `(owner)/layout.tsx` および `middleware.ts`（matcher `/rooms/:path*`）で
 * 担保済みだが、`rooms/page.tsx` 等の既存パターンに倣い、ここでも
 * `owner_user_id = auth.uid()` をクエリ側で明示する多層防御を行う
 * （`docs/design/supabase-design.md#rls-ポリシー` 参照）。
 *
 * invite の insert は RLS 上 `本人所有ルーム` であれば authenticated ロールで
 * 可能なため（`invites` は service_role 不要、`docs/design/supabase-design.md`
 * 「service_role の使用箇所」に invites の記載が無いことに対応）、
 * `src/lib/supabase/server.ts`（ユーザーセッション・RLS適用）で完結する。
 *
 * 招待の再利用方針: `docs/design/db-design.md#invites招待qr` に「再開時は
 * 既存 invite の再利用」に関する明示的な既定は無いため、無駄な行の増殖を避ける
 * YAGNI の観点から「有効期限内かつ未使用の既存 invite があれば再利用し、
 * 無ければ新規発行」を採用する（このタスクでの判断。テスト担当への引き継ぎ事項）。
 * 単回消費化（bd-1oy）により招待は一度参加に使われると再利用不可になるため、
 * 既存招待の検索条件にも `used_at is null` を追加した（使用済みなら新規発行に
 * フォールバックする。これをしないと、既に消費された＝ゲストが参加済みの
 * トークンを再度案内してしまい、単回消費化の意味が失われるため）。
 *
 * 有効期限: `docs/design/db-design.md` は「例: 作成から24〜48時間」とするのみで
 * 具体値を確定していないため、安全側の24時間をこのタスクの既定値とする。
 *
 * token: `crypto.randomUUID()`（Web Crypto ベースの暗号学的乱数、122bitのランダム性）
 * を採用する。`docs/design/db-design.md` の例（`crypto.randomBytes(24)`）とは
 * 生成手段が異なるが、暗号学的乱数という要件（推測困難性）は同等に満たす。
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { QRDisplay } from "@/components/QRDisplay/QRDisplay";
import { resolveInviteBaseUrl } from "./resolveInviteBaseUrl";
import styles from "./page.module.css";

/** 招待の有効期限（時間）。既定値の根拠は本ファイル冒頭コメント参照。 */
const INVITE_TTL_HOURS = 24;

interface InvitePageProps {
  params: Promise<{ roomId: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { roomId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, status")
    .eq("id", roomId)
    .eq("owner_user_id", user.id)
    .maybeSingle();

  if (roomError) {
    console.error("[InvitePage] failed to load room", roomError.message);
  }

  if (!room) {
    notFound();
  }

  const nowIso = new Date().toISOString();

  const { data: existingInvite, error: existingInviteError } = await supabase
    .from("invites")
    .select("token, expires_at")
    .eq("room_id", roomId)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingInviteError) {
    console.error(
      "[InvitePage] failed to look up existing invite",
      existingInviteError.message
    );
  }

  let token = existingInvite?.token as string | undefined;
  let expiresAt = existingInvite?.expires_at as string | undefined;

  if (!token) {
    const newToken = crypto.randomUUID();
    const newExpiresAt = new Date(
      Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000
    ).toISOString();

    const { data: createdInvite, error: insertError } = await supabase
      .from("invites")
      .insert({ room_id: roomId, token: newToken, expires_at: newExpiresAt })
      .select("token, expires_at")
      .single();

    if (insertError || !createdInvite) {
      console.error("[InvitePage] failed to create invite", insertError?.message);
      return (
        <main className={styles.container}>
          <h1 className={styles.title}>招待</h1>
          <p className={styles.error} role="alert">
            招待の発行に失敗しました。時間をおいて再度お試しください。
          </p>
          <Link href={`/rooms`} className={styles.backLink}>
            ルーム一覧へ戻る
          </Link>
        </main>
      );
    }

    token = createdInvite.token as string;
    expiresAt = createdInvite.expires_at as string;
  }

  const baseUrl = await resolveInviteBaseUrl();
  const inviteUrl = new URL(`/join/${token}`, baseUrl).toString();

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>招待</h1>
      <p className={styles.description}>
        このQRコードまたはURLを相手に共有すると、ルームに参加できます。
      </p>
      <QRDisplay inviteUrl={inviteUrl} expiresAt={expiresAt} />
      <Link href={`/room/${roomId}`} className={styles.backLink}>
        ルームへ戻る
      </Link>
    </main>
  );
}
