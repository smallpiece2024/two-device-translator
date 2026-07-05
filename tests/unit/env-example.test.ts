import * as fs from "fs";
import * as path from "path";

/**
 * .env.example に実キーらしき値が誤ってコミットされていないことを保証する
 * 静的回帰ガードテスト。
 *
 * 目的: bd-882 (Supabase Auth + RLSポリシー) を含む、Supabase/GCP等の
 * 認証情報がプレースホルダーのままであることを機械的に保証する。
 * Supabase の secret key (`sb_secret_...`) や JWT形式のレガシー
 * anon/service_role key (`eyJ...` で始まる) が紛れ込むと、
 * リポジトリ経由で本物の認証情報が漏洩するリスクがある。
 */

const envExamplePath = path.resolve(__dirname, "../../.env.example");

describe(".env.example: 実キー混入防止ガード", () => {
  const content = fs.readFileSync(envExamplePath, "utf8");

  it("Supabase secret key 形式 (sb_secret_...) の値が含まれない", () => {
    expect(content).not.toMatch(/sb_secret_[A-Za-z0-9_-]+/);
  });

  it("JWT形式のキー (eyJ... で始まる値) が含まれない", () => {
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it("SUPABASE_SERVICE_KEY はプレースホルダーのままである", () => {
    expect(content).toMatch(/SUPABASE_SERVICE_KEY=your-service-role-key/);
  });

  it("NEXT_PUBLIC_SUPABASE_ANON_KEY はプレースホルダーのままである", () => {
    expect(content).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key/);
  });
});
