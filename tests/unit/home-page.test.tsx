/** @jest-environment jsdom */
/**
 * `src/app/page.tsx`（トップページ）の単体テスト（bd-6ez）。
 *
 * `@/lib/supabase/server` の `createClient` をモックし、実 Supabase 接続を行わない。
 * async Server Component を `await Home()` で直接呼び出して検証する
 * （`tests/unit/rooms-page.test.tsx` と同じ流儀）。
 *
 * @see src/app/page.tsx
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Home from "@/app/page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const redirectMock = redirect as jest.MockedFunction<typeof redirect>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(user: { id: string } | null) {
  const getUser = jest.fn().mockResolvedValue({ data: { user } });
  createClientMock.mockResolvedValue({
    auth: { getUser },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { getUser };
}

describe("Home（トップページ）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("未ログイン時: サービス名の見出しとログイン導線（/login）が表示される", async () => {
    setupSupabaseMock(null);

    const result = await Home();
    render(result);

    expect(
      screen.getByRole("heading", { name: "two-device-translator" })
    ).toBeInTheDocument();

    const loginLink = screen.getByRole("link", { name: "ログイン / はじめる" });
    expect(loginLink).toHaveAttribute("href", "/login");

    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("未ログイン時: ゲスト向けの案内文（QRから参加）が表示される", async () => {
    setupSupabaseMock(null);

    const result = await Home();
    render(result);

    expect(
      screen.getByText(/招待QRコードを受け取った方は/)
    ).toBeInTheDocument();
  });

  it("未ログイン時: Phase1 の雛形文言が表示されない", async () => {
    setupSupabaseMock(null);

    const result = await Home();
    render(result);

    expect(screen.queryByText(/プロジェクト雛形/)).not.toBeInTheDocument();
  });

  it("ログイン済み時: /rooms へ redirect される", async () => {
    setupSupabaseMock({ id: "user-1" });

    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/rooms");
    expect(redirectMock).toHaveBeenCalledWith("/rooms");
  });
});
