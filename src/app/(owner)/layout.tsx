import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * オーナー用ルートグループ共通レイアウト。
 *
 * `middleware.ts`（Edge）で未ログインは `/login` へリダイレクト済みだが、
 * 多層防御として Server Component 側でも Supabase セッションを確認する
 * （`docs/design/security-design.md#オーナー認証` の
 * `Server Component: supabase.auth.getUser()` 確認に対応）。
 *
 * ナビ等の装飾は後続タスクで追加する（このタスクでは認証境界のみ）。
 */
export default async function OwnerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return <>{children}</>;
}
