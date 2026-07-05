/** @jest-environment jsdom */
/**
 * `src/app/(owner)/rooms/page.tsx`（RoomsPage）の単体テスト（bd-two-device-translator-2x6）。
 *
 * `@/lib/supabase/server` の `createClient` をモックし、実 Supabase 接続を行わない。
 * async Server Component を `await RoomsPage()` で直接呼び出し、返却された
 * React 要素を `render()` して検証する。
 *
 * @see src/app/(owner)/rooms/page.tsx
 * @see src/app/(owner)/rooms/RoomList.tsx
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RoomsPage from "@/app/(owner)/rooms/page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const redirectMock = redirect as jest.MockedFunction<typeof redirect>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(
  result: { data: unknown; error: { message: string } | null },
  options: { user?: { id: string } | null } = {}
) {
  const user = "user" in options ? options.user : { id: "user-1" };
  const getUser = jest.fn().mockResolvedValue({ data: { user } });
  const order = jest.fn().mockResolvedValue(result);
  const eq = jest.fn().mockReturnValue({ order });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });

  createClientMock.mockResolvedValue({
    auth: { getUser },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  return { from, select, eq, order, getUser };
}

describe("RoomsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("取得成功時: 複数件のルームがRoomListへ渡されて表示される", async () => {
    const { from, select, eq, order } = setupSupabaseMock(
      {
        data: [
          { id: "room-1", status: "active", created_at: "2026-01-01T00:00:00Z" },
          { id: "room-2", status: "ended", created_at: "2026-01-02T00:00:00Z" },
        ],
        error: null,
      },
      { user: { id: "user-1" } }
    );

    const result = await RoomsPage();
    render(result);

    expect(from).toHaveBeenCalledWith("rooms");
    expect(select).toHaveBeenCalledWith("id, status, created_at");
    expect(eq).toHaveBeenCalledWith("owner_user_id", "user-1");
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });

    expect(screen.getByText("進行中")).toBeInTheDocument();
    expect(screen.getByText("終了")).toBeInTheDocument();

    const enterLinks = screen.getAllByRole("link", { name: "入室する" });
    expect(enterLinks).toHaveLength(2);
    expect(enterLinks[0]).toHaveAttribute("href", "/room/room-1");
    expect(enterLinks[1]).toHaveAttribute("href", "/room/room-2");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("未ログイン（getUserがuser:nullを返す）→ redirect('/login')が呼ばれ、roomsクエリは実行されない（多層防御）", async () => {
    const { from } = setupSupabaseMock({ data: null, error: null }, { user: null });
    redirectMock.mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT:/login");
    });

    await expect(RoomsPage()).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(from).not.toHaveBeenCalled();
  });

  it("取得成功時（0件）: RoomListの空状態が表示される", async () => {
    setupSupabaseMock({ data: [], error: null });

    const result = await RoomsPage();
    render(result);

    expect(screen.getByText("まだルームがありません。")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("取得エラー時: role=alertでエラーメッセージを表示し、RoomListは表示しない", async () => {
    setupSupabaseMock({ data: null, error: { message: "db error" } });

    const result = await RoomsPage();
    render(result);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "ルーム一覧の取得に失敗しました。時間をおいて再度お試しください。"
    );
    expect(screen.queryByRole("link", { name: "入室する" })).not.toBeInTheDocument();
    expect(screen.queryByText("まだルームがありません。")).not.toBeInTheDocument();
  });

  it("常に新規ルーム作成リンク（/rooms/new）を表示する", async () => {
    setupSupabaseMock({ data: [], error: null });

    const result = await RoomsPage();
    render(result);

    expect(screen.getByRole("link", { name: "新規ルーム作成" })).toHaveAttribute(
      "href",
      "/rooms/new"
    );
  });
});
