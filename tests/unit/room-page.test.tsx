/** @jest-environment jsdom */
/**
 * `src/app/(public)/room/[roomId]/page.tsx`（RoomPage）の単体テスト（bd-fmk）。
 *
 * オーナーWS認証結線: Supabase セッションのユーザーが当該ルームの所有者で
 * ある場合のみ `ownerToken`（アクセストークン）が JoinForm へ渡り、その場合
 * `guestToken` は渡されない（オーナー入室を優先）ことを検証する。
 *
 * `next/headers` の `cookies` と `@/lib/supabase/server` の `createClient` を
 * モックし、async Server Component を `await RoomPage()` で直接呼び出す
 * （`tests/unit/rooms-page.test.tsx` と同じ流儀）。
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyGuestToken } from "@shared/auth/guestToken";
import RoomPage from "@/app/(public)/room/[roomId]/page";

const cookieGetMock = jest.fn();

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: cookieGetMock })),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

jest.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: jest.fn(),
}));

jest.mock("@shared/auth/guestToken", () => ({
  GUEST_COOKIE_NAME: "gtt_guest",
  verifyGuestToken: jest.fn(),
}));

jest.mock("@/app/(public)/room/[roomId]/JoinForm", () => ({
  JoinForm: (props: {
    roomId: string;
    wsUrl: string;
    ownerToken?: string;
    guestToken?: string;
    guestProfile?: { displayName?: string; language: string };
  }) => <div data-testid="join-form-mock" data-props={JSON.stringify(props)} />,
}));

const createClientMock = createClient as jest.MockedFunction<typeof createClient>;
const getSupabaseAdminClientMock = getSupabaseAdminClient as jest.MockedFunction<
  typeof getSupabaseAdminClient
>;
const verifyGuestTokenMock = verifyGuestToken as jest.MockedFunction<typeof verifyGuestToken>;

function setupAdminMock(
  participant: { display_name: string | null; language: string } | null,
  error: { message: string } | null = null
) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: participant, error });
  const eqRoom = jest.fn().mockReturnValue({ maybeSingle });
  const eqId = jest.fn().mockReturnValue({ eq: eqRoom });
  const select = jest.fn().mockReturnValue({ eq: eqId });
  const from = jest.fn().mockReturnValue({ select });
  getSupabaseAdminClientMock.mockReturnValue({ from } as unknown as ReturnType<
    typeof getSupabaseAdminClient
  >);
  return { from, select, eqId, eqRoom };
}

function setupSupabaseMock(options: {
  user?: { id: string } | null;
  ownedRoom?: { id: string } | null;
  accessToken?: string;
}) {
  const user = options.user ?? null;
  const getUser = jest.fn().mockResolvedValue({ data: { user } });
  const getSession = jest.fn().mockResolvedValue({
    data: {
      session: options.accessToken ? { access_token: options.accessToken } : null,
    },
  });
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: options.ownedRoom ?? null, error: null });
  const eqOwner = jest.fn().mockReturnValue({ maybeSingle });
  const eqId = jest.fn().mockReturnValue({ eq: eqOwner });
  const select = jest.fn().mockReturnValue({ eq: eqId });
  const from = jest.fn().mockReturnValue({ select });

  createClientMock.mockResolvedValue({
    auth: { getUser, getSession },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  return { from, select, eqId, eqOwner, getSession };
}

async function renderRoomPage() {
  const result = await RoomPage({ params: Promise.resolve({ roomId: "room-1" }) });
  render(result);
  const mock = screen.getByTestId("join-form-mock");
  return JSON.parse(mock.getAttribute("data-props") ?? "{}");
}

describe("RoomPage（トークン結線）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cookieGetMock.mockReturnValue(undefined);
  });

  it("所有者としてログイン済みの場合、ownerTokenがJoinFormへ渡る", async () => {
    const { from, eqId, eqOwner } = setupSupabaseMock({
      user: { id: "user-1" },
      ownedRoom: { id: "room-1" },
      accessToken: "supabase-access-token",
    });

    const props = await renderRoomPage();

    expect(from).toHaveBeenCalledWith("rooms");
    expect(eqId).toHaveBeenCalledWith("id", "room-1");
    expect(eqOwner).toHaveBeenCalledWith("owner_user_id", "user-1");
    expect(props.ownerToken).toBe("supabase-access-token");
  });

  it("所有者の場合、guestTokenクッキーが残っていてもguestTokenは渡されない（オーナー優先）", async () => {
    setupSupabaseMock({
      user: { id: "user-1" },
      ownedRoom: { id: "room-1" },
      accessToken: "supabase-access-token",
    });
    cookieGetMock.mockReturnValue({ value: "stale-guest-jwt" });

    const props = await renderRoomPage();

    expect(props.ownerToken).toBe("supabase-access-token");
    expect(props.guestToken).toBeUndefined();
  });

  it("ログイン済みでも当該ルームの所有者でない場合、ownerTokenは渡されない", async () => {
    setupSupabaseMock({
      user: { id: "user-2" },
      ownedRoom: null,
      accessToken: "supabase-access-token",
    });
    cookieGetMock.mockReturnValue({ value: "guest-jwt" });

    const props = await renderRoomPage();

    expect(props.ownerToken).toBeUndefined();
    expect(props.guestToken).toBe("guest-jwt");
  });

  it("未ログインの場合、ownerTokenは渡されずguestTokenクッキーがそのまま渡る（既存動作）", async () => {
    const { from } = setupSupabaseMock({ user: null });
    cookieGetMock.mockReturnValue({ value: "guest-jwt" });

    const props = await renderRoomPage();

    expect(from).not.toHaveBeenCalled();
    expect(props.ownerToken).toBeUndefined();
    expect(props.guestToken).toBe("guest-jwt");
  });

  it("未ログイン・クッキーなしの場合、どちらのトークンも渡されない（dev/E2E互換）", async () => {
    setupSupabaseMock({ user: null });

    const props = await renderRoomPage();

    expect(props.ownerToken).toBeUndefined();
    expect(props.guestToken).toBeUndefined();
    expect(props.roomId).toBe("room-1");
  });

  it("有効なゲストクッキー+participants行ありの場合、guestProfileが渡りフォームをスキップできる（bd-1is）", async () => {
    setupSupabaseMock({ user: null });
    cookieGetMock.mockReturnValue({ value: "guest-jwt" });
    verifyGuestTokenMock.mockResolvedValue({ roomId: "room-1", participantId: "p-1" });
    const { from, eqId, eqRoom } = setupAdminMock({
      display_name: "はなこ",
      language: "en-US",
    });

    const props = await renderRoomPage();

    expect(verifyGuestTokenMock).toHaveBeenCalledWith("guest-jwt");
    expect(from).toHaveBeenCalledWith("participants");
    expect(eqId).toHaveBeenCalledWith("id", "p-1");
    expect(eqRoom).toHaveBeenCalledWith("room_id", "room-1");
    expect(props.guestToken).toBe("guest-jwt");
    expect(props.guestProfile).toEqual({ displayName: "はなこ", language: "en-US" });
  });

  it("ゲストJWTのroomIdがURLと一致しない場合、guestProfileは渡されない（フォーム表示）", async () => {
    setupSupabaseMock({ user: null });
    cookieGetMock.mockReturnValue({ value: "guest-jwt" });
    verifyGuestTokenMock.mockResolvedValue({ roomId: "other-room", participantId: "p-1" });
    const { from } = setupAdminMock(null);

    const props = await renderRoomPage();

    expect(from).not.toHaveBeenCalled();
    expect(props.guestProfile).toBeUndefined();
    expect(props.guestToken).toBe("guest-jwt");
  });

  it("participants行が見つからない場合、guestProfileは渡されない（フォーム表示にフォールバック）", async () => {
    setupSupabaseMock({ user: null });
    cookieGetMock.mockReturnValue({ value: "guest-jwt" });
    verifyGuestTokenMock.mockResolvedValue({ roomId: "room-1", participantId: "p-gone" });
    setupAdminMock(null);

    const props = await renderRoomPage();

    expect(props.guestProfile).toBeUndefined();
    expect(props.guestToken).toBe("guest-jwt");
  });

  it("オーナー判定された場合、ゲストクッキーの検証・プロフィール取得は行われない", async () => {
    setupSupabaseMock({
      user: { id: "user-1" },
      ownedRoom: { id: "room-1" },
      accessToken: "supabase-access-token",
    });
    cookieGetMock.mockReturnValue({ value: "stale-guest-jwt" });

    const props = await renderRoomPage();

    expect(verifyGuestTokenMock).not.toHaveBeenCalled();
    expect(props.ownerToken).toBe("supabase-access-token");
    expect(props.guestProfile).toBeUndefined();
  });
});
