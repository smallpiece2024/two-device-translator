/**
 * ログイン画面(bd-63d)のリダイレクトガード E2E テスト。
 *
 * `(owner)` ルートグループ（`/rooms/:path*`, `/history/:path*`）は
 * `middleware.ts` により未ログイン時 `/login` へリダイレクトされる。
 * `(public)`（`/room/*` 等）は対象外でそのまま表示される。
 *
 * 実 Supabase セッションは用意しない（未ログイン状態のみ検証）。
 * `middleware.ts` はセッションcookieが無ければ Supabase へネットワーク
 * アクセスせずに `user: null` を返すため、実ネットワーク接続は発生しない。
 *
 * @see src/middleware.ts
 * @see src/app/(public)/login/LoginForm.tsx
 */
import { test, expect } from "@playwright/test";

test.describe("ログイン画面のリダイレクトガード（bd-63d）", () => {
  // NOTE: playwright.config.ts の webServer（Next.js側）にダミーの
  // `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を設定済み。
  // ダミー値では getUser が失敗し「未ログイン扱い（fail-closed）」になるため、
  // このテストが検証したいリダイレクト動作そのものが成立する（実値は不要）。
  test(
    "未ログインで/roomsへアクセスすると/loginへリダイレクトされ、redirectパラメータが付く",
    async ({ page }) => {
      await page.goto("/rooms");

      await expect(page).toHaveURL(/\/login\?redirect=%2Frooms/);
    }
  );

  test("public配下の/room/*はミドルウェア対象外のためリダイレクトされない", async ({ page }) => {
    const roomId = `e2e-guard-check-${Date.now()}`;

    const response = await page.goto(`/room/${roomId}`);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`));
  });

  test("/loginが200で表示され、ログインフォームが見える", async ({ page }) => {
    const response = await page.goto("/login");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("form", { name: "ログインフォーム" })).toBeVisible();
    await expect(page.getByLabel("メールアドレス")).toBeVisible();
    await expect(page.getByLabel("パスワード")).toBeVisible();
  });
});
