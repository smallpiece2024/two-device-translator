/**
 * Jest グローバルセットアップ。
 *
 * `jest-environment-jsdom` は `TextEncoder`/`TextDecoder` をグローバルに
 * 提供しないため、jose（`shared/auth/guestToken.ts` が使用）を jsdom
 * 環境のテストで import すると `TextEncoder is not defined` で失敗する。
 * Node の `node:util` 実装をポリフィルとして注入する（testEnvironment: "node"
 * では既にグローバルに存在するため上書きしない）。
 */
const { TextEncoder, TextDecoder } = require("node:util");

if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecoder;
}

/**
 * 実 Supabase 認証情報の遮断（two-device-translator-17r）。
 *
 * ローカル開発機の OS 環境変数 / シェルプロファイルに実際の
 * `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`（および `NEXT_PUBLIC_` 版）が
 * 設定されていると、`server/db/supabaseAdmin.ts` の遅延初期化シングルトンが
 * テスト実行中（特に `resetSupabaseAdminClient()` 後の fire-and-forget な
 * `markRoomEnded`/`markRoomActive` の遅延実行）に実クライアントを生成し、
 * 実 Supabase プロジェクトへ通信してしまう事故が起こり得る。
 * テストから本番/実 DB への通信は原則違反のため、Jest プロセス起動時点で
 * これらの環境変数を確実に削除し、テスト内では常に「未設定」から始まる
 * ようにする。
 *
 * `tests/unit/supabaseAdmin.test.ts` 等、テスト内で明示的に
 * `process.env.SUPABASE_URL` 等を設定するテストは、各テスト自身が
 * beforeEach/afterEach で値を退避・復元しており、ここでの削除と競合しない
 * （復元先は「削除前の値」ではなく「このセットアップ後の未設定状態」を
 * 基準にしても、実クライアントは元々生成されないため影響しない）。
 */
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
