/**
 * オーナー向けログイン画面（`/login`）。
 *
 * `middleware.ts` の matcher 対象外（`(public)` ルートグループ）。
 * `redirect` / `error` クエリパラメータは Server Component 側で読み取り、
 * 未検証の文字列として `LoginForm`（Client Component）へ props で渡す。
 * 実際の検証・遷移先決定は `resolveSafeRedirect`（`src/lib/safeRedirect.ts`）
 * で行う。
 *
 * @see docs/design/app-architecture.md#next-js-ページ構成とルーティング
 * @see docs/design/frontend-design.md#login
 */
import { LoginForm } from "./LoginForm";

interface LoginPageProps {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { redirect, error } = await searchParams;

  return <LoginForm redirectTo={redirect} initialError={error} />;
}
