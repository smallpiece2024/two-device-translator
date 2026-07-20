/**
 * jest.setup.js による実 Supabase 認証情報の遮断を検証する回帰テスト
 * （two-device-translator-17r）。
 *
 * ローカル開発機の OS 環境変数 / シェルプロファイルに実際の
 * `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` 等が設定されていても、Jest
 * プロセス内では必ず未設定から始まることを検証する。このテスト自体が、
 * 将来 `jest.setup.js` の削除処理が誤って外された場合に検知する
 * ガードレールとなる。
 *
 * @see jest.setup.js
 * @see server/db/supabaseAdmin.ts
 */
describe("jest.setup.js による環境変数の遮断", () => {
  it("SUPABASE_URL がテスト環境で未定義である", () => {
    expect(process.env.SUPABASE_URL).toBeUndefined();
  });

  it("SUPABASE_SERVICE_KEY がテスト環境で未定義である", () => {
    expect(process.env.SUPABASE_SERVICE_KEY).toBeUndefined();
  });

  it("NEXT_PUBLIC_SUPABASE_URL がテスト環境で未定義である", () => {
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
  });

  it("NEXT_PUBLIC_SUPABASE_ANON_KEY がテスト環境で未定義である", () => {
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeUndefined();
  });
});
