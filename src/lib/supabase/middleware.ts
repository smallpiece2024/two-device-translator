import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * middleware.ts からのセッション refresh 用 Supabase クライアント生成。
 *
 * Edge Runtime で動作するため `@supabase/ssr` の fetch ベース実装を使う
 * （Node 版 `crypto` 等には依存しない）。`request`/`response` 双方の
 * cookie を同期させることで、有効期限が近いセッションの自動更新
 * （リフレッシュトークンでのローテーション）を反映する。
 *
 * @see docs/design/security-design.md#edge-runtime-制約
 * @see docs/design/supabase-design.md#クライアント生成supabasessr
 */
export function createClient(request: NextRequest) {
  // NextResponse は cookie 書き込みのたびに新しいインスタンスへ差し替える
  // 必要があるため、let で保持する（@supabase/ssr 標準パターン）。
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  return { supabase, response };
}
