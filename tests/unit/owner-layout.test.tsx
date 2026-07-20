/**
 * `src/app/(owner)/layout.tsx` の単体テスト（bd-two-device-translator-xev）。
 *
 * `middleware.ts`（Edge）で未ログインは既に `/login` へリダイレクト済みだが、
 * Server Component 側でも Supabase セッションを確認する多層防御を検証する。
 *
 * `next/navigation` の `redirect` と `@/lib/supabase/server` の
 * `createClient` をモックし、async Server Component を直接
 * `await OwnerLayout({ children })` の形で呼び出して検証する。
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OwnerLayout from "@/app/(owner)/layout";

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const redirectMock = redirect as jest.MockedFunction<typeof redirect>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(user: { id: string } | null) {
  createClientMock.mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user } }),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

describe("OwnerLayout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("未ログイン(user:null)の場合はredirect('/login')が呼ばれる", async () => {
    setupSupabaseMock(null);

    await OwnerLayout({ children: <div>children</div> });

    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("ログイン済み(userあり)の場合はchildrenがそのまま返される", async () => {
    setupSupabaseMock({ id: "user-1" });

    const result = await OwnerLayout({ children: <div>owner-content</div> });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toEqual(<>{<div>owner-content</div>}</>);
  });
});
