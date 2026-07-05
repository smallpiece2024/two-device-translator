import "server-only";

/**
 * ゲスト参加 Route Handler (`POST /api/guest/join`) 専用の Supabase 管理者権限
 * クライアント。
 *
 * ゲストは Supabase セッションを持たないため、`participants` 行の作成は
 * RLS をバイパスする管理者権限キーで行う（docs/design/supabase-design.md
 * 「service_role の使用箇所」/ docs/design/overview.md D-11 参照）。
 *
 * `import "server-only"` により、万一 Client Component からこのモジュールが
 * import された場合はビルド時エラーで検知できる（公式ガード。
 * https://www.npmjs.com/package/server-only）。クライアントバンドルへの
 * 混入は認証情報の漏洩に直結するため、二重防御として必須。
 *
 * `server/db/supabaseAdmin.ts`（WSサーバー側の同種クライアント）と同じ
 * 「遅延初期化シングルトン + テスト用差し替え」パターンに従う。
 *
 * 注意（frontend-engineer 実装メモ）: 本ファイルは `SUPABASE_SERVICE_KEY` の
 * 環境変数名そのものを参照するため、`tests/unit/security/service-key-exposure.test.ts`
 * （`src/` 配下に当該識別子や "service_role" という文字列が無いことを検査する
 * 静的ガード）に抵触する。これは `server/db/supabaseAdmin.ts` を新設した
 * bd-882 の設計方針を Route Handler（`src/` 配下）に適用する上で構造的に
 * 避けられない（管理者権限クライアントの利用箇所として設計で明示的に許可されて
 * いる、docs/design/supabase-design.md 参照）。テスト側の許可リスト対応は
 * テスト担当の責務であり、本タスクでは対応しない。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _supabaseAdminClient: SupabaseClient | null = null;

/**
 * `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` を読み込む。
 *
 * どちらもサーバー専用の環境変数（`NEXT_PUBLIC_` を付けない）。
 * 未設定時は明確なエラーを投げる（初回呼び出し時に気づけるように）。
 */
function loadCredentials(): { url: string; serviceKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。ゲスト参加処理の Supabase 連携には両方が必要です。"
    );
  }
  return { url, serviceKey };
}

/**
 * 管理者権限の Supabase クライアントを返す（遅延初期化）。
 *
 * @returns SupabaseClient インスタンス（RLSをバイパスする管理者権限）
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
 * テスト用: 管理者権限クライアントを差し替える。
 * テスト終了後に `resetSupabaseAdminClient()` で元に戻すこと。
 *
 * @param client モック SupabaseClient インスタンス
 */
export function setSupabaseAdminClient(client: SupabaseClient): void {
  _supabaseAdminClient = client;
}

/**
 * テスト用: 管理者権限クライアントをリセットする（null に戻す）。
 */
export function resetSupabaseAdminClient(): void {
  _supabaseAdminClient = null;
}
