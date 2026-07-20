/** @jest-environment jsdom */
/**
 * `src/app/(owner)/rooms/[roomId]/invite/page.tsx`（InvitePage）の単体テスト。
 *
 * `tests/unit/rooms-page.test.tsx` の流儀に倣い、`@/lib/supabase/server` の
 * `createClient` と `next/navigation` の `redirect` / `notFound` をモックし、
 * 実 Supabase 接続を行わない。async Server Component を直接呼び出し、
 * 返却された React 要素を `render()` して検証する。
 *
 * `resolveInviteBaseUrl` は実装のまま利用し、`APP_BASE_URL` を設定して
 * ヘッダ（`next/headers`）参照を経由しない経路に固定する
 * （未設定時はリクエストコンテキスト外の `headers()` 呼び出しでエラーになるため）。
 *
 * 単回消費化（bd-1oy）: 既存招待の再利用検索は `.is("used_at", null)` を
 * 条件に含める（使用済みの招待を再度案内しないため）。
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import InvitePage from "@/app/(owner)/rooms/[roomId]/invite/page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
  notFound: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const redirectMock = redirect as jest.MockedFunction<typeof redirect>;
const notFoundMock = notFound as jest.MockedFunction<typeof notFound>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

/** `.select().eq().maybeSingle()` の rooms クエリ用チェイン可能ビルダー */
function makeRoomsBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ["select", "eq"]) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn().mockResolvedValue(result);
  return builder;
}

/**
 * invites テーブル用チェイン可能ビルダー。
 * `.select().eq().is().gt().order().limit().maybeSingle()`（既存招待の検索。
 * 単回消費化 bd-1oy により `.is("used_at", null)` が条件に加わる）と
 * `.insert().select().single()`（新規発行）の両方をサポートする
 * （同一ビルダーオブジェクト上で `maybeSingle` と `single` の終端が異なるため両立する）。
 */
function makeInvitesBuilder(
  existingInviteResult: { data: unknown; error: { message: string } | null },
  insertResult?: { data: unknown; error: { message: string } | null },
) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ["select", "eq", "is", "gt", "order", "limit", "insert"]) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn().mockResolvedValue(existingInviteResult);
  builder.single = jest.fn().mockResolvedValue(
    insertResult ?? { data: null, error: { message: "insert not expected to be called" } },
  );
  return builder;
}

function setupSupabaseMock(options: {
  user?: { id: string } | null;
  roomsResult: { data: unknown; error: { message: string } | null };
  existingInviteResult?: { data: unknown; error: { message: string } | null };
  insertResult?: { data: unknown; error: { message: string } | null };
}) {
  const user = "user" in options ? options.user : { id: "user-1" };
  const getUser = jest.fn().mockResolvedValue({ data: { user } });
  const roomsBuilder = makeRoomsBuilder(options.roomsResult);
  const invitesBuilder = makeInvitesBuilder(
    options.existingInviteResult ?? { data: null, error: null },
    options.insertResult,
  );
  const from = jest.fn((table: string) => {
    if (table === "rooms") return roomsBuilder;
    if (table === "invites") return invitesBuilder;
    throw new Error(`unexpected table: ${table}`);
  });

  createClientMock.mockResolvedValue({
    auth: { getUser },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  return { from, roomsBuilder, invitesBuilder, getUser };
}

describe("InvitePage", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, APP_BASE_URL: "https://default.example.com" };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("未ログイン（getUserがuser:nullを返す）→ redirect('/login')が呼ばれ、後続クエリは実行されない", async () => {
    const { from } = setupSupabaseMock({
      user: null,
      roomsResult: { data: null, error: null },
    });
    redirectMock.mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT:/login");
    });

    await expect(
      InvitePage({ params: Promise.resolve({ roomId: "room-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(from).not.toHaveBeenCalled();
  });

  it("room不存在（またはowner_user_id不一致でクエリがnullを返す）→ notFound()が呼ばれる", async () => {
    // 実装は `.eq("owner_user_id", user.id)` をクエリ側で明示するため、
    // room不存在・所有者不一致のいずれも同じ「data: null」経路になる。
    const { roomsBuilder } = setupSupabaseMock({
      roomsResult: { data: null, error: null },
    });
    notFoundMock.mockImplementationOnce(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      InvitePage({ params: Promise.resolve({ roomId: "room-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(roomsBuilder.eq).toHaveBeenCalledWith("owner_user_id", "user-1");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("有効期限内かつ未使用の既存invite があれば再利用し、insertは呼ばれない", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { invitesBuilder } = setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: {
        data: { token: "existing-token-abc", expires_at: futureIso },
        error: null,
      },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    // 単回消費化（bd-1oy）: 既存招待の検索条件に is("used_at", null) が含まれる
    expect(invitesBuilder.is).toHaveBeenCalledWith("used_at", null);
    expect(invitesBuilder.insert).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "https://default.example.com/join/existing-token-abc" }),
    ).toHaveAttribute("href", "https://default.example.com/join/existing-token-abc");
  });

  it("既存invite が無ければ新規発行する（insertがtoken/expires_atを伴い呼ばれる）", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const insertedExpiresAt = "2026-01-02T00:00:00.000Z"; // +24h
    const { invitesBuilder } = setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: { data: null, error: null },
      insertResult: {
        data: { token: "new-token-xyz", expires_at: insertedExpiresAt },
        error: null,
      },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    jest.useRealTimers();

    expect(invitesBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        room_id: "room-1",
        token: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        expires_at: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(
      screen.getByRole("link", { name: "https://default.example.com/join/new-token-xyz" }),
    ).toBeInTheDocument();
  });

  it("使用済み招待しか存在しない場合（is(\"used_at\",null)条件により既存検索が0件）→ 再利用されず新規発行される（単回消費化 bd-1oy）", async () => {
    // 実装の `.is("used_at", null)` により、使用済みの招待は既存招待検索の
    // maybeSingle 結果から除外される（data: null として返る）。このテストは
    // その場合に既存招待が再利用されず、新規招待が発行されることを検証する
    // （単回消費化の目的: 消費済みトークンを再度案内しないこと）。
    const insertedExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { invitesBuilder } = setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      // used_at is null 条件により、使用済み招待は該当なし(data:null)として返る
      existingInviteResult: { data: null, error: null },
      insertResult: {
        data: { token: "fresh-token-after-used", expires_at: insertedExpiresAt },
        error: null,
      },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    expect(invitesBuilder.is).toHaveBeenCalledWith("used_at", null);
    expect(invitesBuilder.insert).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", {
        name: "https://default.example.com/join/fresh-token-after-used",
      }),
    ).toBeInTheDocument();
  });

  it("insert失敗時はrole=alertでエラーメッセージとルーム一覧への戻りリンクを表示する", async () => {
    setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: { data: null, error: null },
      insertResult: { data: null, error: { message: "insert failed" } },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "招待の発行に失敗しました。時間をおいて再度お試しください。",
    );
    expect(screen.getByRole("link", { name: "ルーム一覧へ戻る" })).toHaveAttribute(
      "href",
      "/rooms",
    );
  });

  it("通常アクセス時は「ルームへ戻る」リンクが表示され、閉じるボタンは表示されない", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: {
        data: { token: "tok-nav", expires_at: futureIso },
        error: null,
      },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    expect(screen.getByRole("link", { name: "ルームへ戻る" })).toHaveAttribute(
      "href",
      "/room/room-1",
    );
    expect(
      screen.queryByRole("button", { name: "このタブを閉じる" }),
    ).not.toBeInTheDocument();
  });

  it("from=roomで開かれた場合は「このタブを閉じる」ボタンが表示され、入室リンクは表示されない（bd-5a2）", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: {
        data: { token: "tok-from-room", expires_at: futureIso },
        error: null,
      },
    });

    const result = await InvitePage({
      params: Promise.resolve({ roomId: "room-1" }),
      searchParams: Promise.resolve({ from: "room" }),
    });
    render(result);

    expect(screen.getByRole("button", { name: "このタブを閉じる" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ルームへ戻る" })).not.toBeInTheDocument();
  });

  it("inviteUrlはAPP_BASE_URLとtokenから`<base>/join/<token>`の形で組み立てられる", async () => {
    process.env.APP_BASE_URL = "https://custom.example.com";
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setupSupabaseMock({
      roomsResult: { data: { id: "room-1", status: "active" }, error: null },
      existingInviteResult: {
        data: { token: "tok-123", expires_at: futureIso },
        error: null,
      },
    });

    const result = await InvitePage({ params: Promise.resolve({ roomId: "room-1" }) });
    render(result);

    expect(
      screen.getByRole("link", { name: "https://custom.example.com/join/tok-123" }),
    ).toHaveAttribute("href", "https://custom.example.com/join/tok-123");
  });
});
