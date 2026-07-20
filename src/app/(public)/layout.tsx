/**
 * 公開ルートグループ（`/login`, `/join/*`, `/room/*`, `/auth/callback`）
 * の共通レイアウト。
 *
 * `middleware.ts` の matcher 対象外であり、認証チェックは行わない
 * （ゲストクッキー検証は各ページの Server Component の責務）。
 * 現時点では装飾なしのパススルー。
 */
export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
