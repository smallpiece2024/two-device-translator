import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/middleware';

/**
 * `(owner)` ルートグループ（`/rooms/:path*`, `/history/:path*`）のみを
 * 対象とし、Supabase セッションを検証する。未ログインは `/login` へ
 * リダイレクトし、リダイレクト後に元のページへ戻れるよう `redirect`
 * クエリパラメータへ元パスを載せる。
 *
 * `(public)`（`/login`, `/join/*`, `/room/*`, `/auth/callback` 等）は
 * matcher の対象外とし、ゲストクッキー検証はここでは行わない
 * （各 `(public)` ページの Server Component の責務）。
 *
 * Edge Runtime で動作するため Node 専用 API は使用しない
 * （`@supabase/ssr` は fetch ベースで Edge 対応）。
 *
 * @see docs/design/app-architecture.md#next-js-ページ構成とルーティング
 * @see docs/design/security-design.md#edge-runtime-制約
 */
export async function middleware(request: NextRequest) {
  const { supabase, response } = createClient(request);

  let user = null;
  try {
    const {
      data: { user: fetchedUser },
    } = await supabase.auth.getUser();
    user = fetchedUser;
  } catch (error) {
    // Supabase セッション確認に失敗した場合はログを残し、未ログイン扱いで
    // /login へ誘導する（エラーを握りつぶさない）。
    console.error('[middleware] failed to verify Supabase session', error);
  }

  if (!user) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ['/rooms/:path*', '/history/:path*'],
};
