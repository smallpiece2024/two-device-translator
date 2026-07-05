/**
 * WSサーバー専用の Supabase service_role クライアント。
 *
 * RLS をバイパスするため、使用箇所を限定する（確定発話/要約の書き込み、
 * ルーム/参加者状態の更新、`join` 時のオーナートークン検証 `auth.getUser`。
 * docs/design/db-design.md「service_role の使用箇所」参照）。
 *
 * `server/gcp/translate.ts` 等と同じ「遅延初期化シングルトン + テスト用差し替え」
 * パターンに従う（モジュール import だけでは生成しない）。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _supabaseAdminClient: SupabaseClient | null = null;

/**
 * `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` を読み込む。
 *
 * どちらもサーバー専用の環境変数（`NEXT_PUBLIC_` を付けない）。
 * 未設定時は明確なエラーを投げる（起動時/初回呼び出し時に気づけるように）。
 */
function loadCredentials(): { url: string; serviceKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。WSサーバーの Supabase 連携（service_role）には両方が必要です。"
    );
  }
  return { url, serviceKey };
}

/**
 * service_role の Supabase クライアントを返す（遅延初期化）。
 *
 * @returns SupabaseClient インスタンス（RLSをバイパスする service_role）
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (_supabaseAdminClient === null) {
    const { url, serviceKey } = loadCredentials();
    _supabaseAdminClient = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _supabaseAdminClient;
}

/**
 * テスト用: Supabase admin クライアントを差し替える。
 * テスト終了後に `resetSupabaseAdminClient()` で元に戻すこと。
 *
 * @param client モック SupabaseClient インスタンス
 */
export function setSupabaseAdminClient(client: SupabaseClient): void {
  _supabaseAdminClient = client;
}

/**
 * テスト用: Supabase admin クライアントをリセットする（null に戻す）。
 */
export function resetSupabaseAdminClient(): void {
  _supabaseAdminClient = null;
}
