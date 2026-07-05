import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server Component / Route Handler / Server Action 用 Supabase クライアント
 * （ユーザーセッション、RLS適用）。
 *
 * Next.js 15 では `cookies()` が非同期のため await する。
 * Server Component からは cookie の書き込みができないため、その場合は
 * `setAll` の失敗を握りつぶす（Route Handler / Server Action / middleware
 * 側でのセッション refresh を前提とする）。
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Component から呼ばれた場合は cookie を書き込めない。
            // セッション refresh は Route Handler / Server Action / middleware
            // 側で行うため、ここでは無視してよい。
          }
        },
      },
    }
  );
}
