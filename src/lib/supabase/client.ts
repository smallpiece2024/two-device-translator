import { createBrowserClient } from '@supabase/ssr';

/**
 * ブラウザ用 Supabase クライアント（anon key、RLS適用）。
 * ログインフォーム等のクライアントコンポーネントから使用する。
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
