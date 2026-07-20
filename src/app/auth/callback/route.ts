/**
 * Supabase Auth（Google OAuth / メール確認リンク）のコールバック。
 *
 * `code` を `exchangeCodeForSession` でセッションに交換し、成功したら
 * `redirect` クエリパラメータ（`resolveSafeRedirect` で検証済みの安全な
 * パスのみ許可）または `/rooms` へリダイレクトする。失敗時は
 * `/login?error=oauth_failed` へリダイレクトする。
 *
 * `middleware.ts` の matcher（`/rooms/:path*`, `/history/:path*`）の対象外。
 * Route Handler（Node.js Runtime）のため Cookie の書き込みが可能。
 *
 * @see docs/design/app-architecture.md#next-js-ページ構成とルーティング
 * @see docs/design/security-design.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveSafeRedirect } from "@/lib/safeRedirect";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const redirectParam = searchParams.get("redirect");

  if (!code) {
    console.error("[auth/callback] missing code parameter");
    return NextResponse.redirect(new URL("/login?error=oauth_failed", origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] exchangeCodeForSession failed", error.message);
    return NextResponse.redirect(new URL("/login?error=oauth_failed", origin));
  }

  const destination = resolveSafeRedirect(redirectParam);

  // 多層防御: resolveSafeRedirect のホワイトリスト検証を通過した後も、
  // 実際に組み立てた URL のオリジンが自サイトと一致することを再検証する。
  // ここが最終防御であり、万一 resolveSafeRedirect 側にバイパスが
  // あった場合でも、外部ドメインへのリダイレクトを許さない。
  const destinationUrl = new URL(destination, request.nextUrl.origin);
  if (destinationUrl.origin !== request.nextUrl.origin) {
    console.error("[auth/callback] destination origin mismatch, falling back to /rooms", {
      destinationOrigin: destinationUrl.origin,
    });
    return NextResponse.redirect(new URL("/rooms", origin));
  }

  return NextResponse.redirect(destinationUrl);
}
