/**
 * `src/app/(owner)/rooms/new/actions.ts` の `createRoomAction` 単体テスト
 * （bd-two-device-translator-2x6）。
 *
 * `next/navigation` の `redirect` と `@/lib/supabase/server` の `createClient` を
 * モックし、実 Supabase 接続を行わない。`redirect` は本番同様に例外を投げる
 * 実装としてモックし（Next.js の実挙動: 呼び出し後の処理は実行されない）、
 * 成功時は例外送出（=redirect実行）を、失敗時は非送出（=redirect未実行）を検証する。
 *
 * @see src/app/(owner)/rooms/new/actions.ts
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createRoomAction } from "@/app/(owner)/rooms/new/actions";
import { initialCreateRoomState } from "@/app/(owner)/rooms/new/state";

jest.mock("next/navigation", () => ({
  redirect: jest.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const redirectMock = redirect as jest.MockedFunction<typeof redirect>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

/** `from(table).select().eq().single()` / `from(table).insert().select().single()` チェーンをモックする。 */
function buildQueryChain(finalResult: { data: unknown; error: { message: string } | null }) {
  const single = jest.fn().mockResolvedValue(finalResult);
  const eq = jest.fn().mockReturnValue({ single });
  const select = jest.fn().mockReturnValue({ eq, single });
  const insert = jest.fn().mockReturnValue({ select });
  return { select, insert, eq, single };
}

interface SetupOptions {
  user: { id: string } | null;
  userError?: { message: string } | null;
  profile?: { plan_id: string } | null;
  profileError?: { message: string } | null;
  plan?: { max_participants: number } | null;
  planError?: { message: string } | null;
  room?: { id: string } | null;
  insertError?: { message: string } | null;
}

function setupSupabaseMock(options: SetupOptions) {
  const userProfilesChain = buildQueryChain({
    data: options.profile ?? null,
    error: options.profileError ?? null,
  });
  const plansChain = buildQueryChain({
    data: options.plan ?? null,
    error: options.planError ?? null,
  });
  const roomsChain = buildQueryChain({
    data: options.room ?? null,
    error: options.insertError ?? null,
  });

  const from = jest.fn((table: string) => {
    if (table === "user_profiles") return userProfilesChain;
    if (table === "plans") return plansChain;
    if (table === "rooms") return roomsChain;
    throw new Error(`unexpected table: ${table}`);
  });

  const getUser = jest.fn().mockResolvedValue({
    data: { user: options.user },
    error: options.userError ?? null,
  });

  createClientMock.mockResolvedValue({
    auth: { getUser },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  return { from, getUser, userProfilesChain, plansChain, roomsChain };
}

describe("createRoomAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("認証あり・profile/plan取得成功 → rooms insertがowner_user_id/status/max_participants付きで呼ばれ、作成したルームへredirectする", async () => {
    const { roomsChain, plansChain } = setupSupabaseMock({
      user: { id: "user-1" },
      profile: { plan_id: "plan-pro" },
      plan: { max_participants: 5 },
      room: { id: "room-123" },
    });

    await expect(
      createRoomAction(initialCreateRoomState, new FormData())
    ).rejects.toThrow("NEXT_REDIRECT:/rooms/room-123/invite");

    expect(plansChain.eq).toHaveBeenCalledWith("id", "plan-pro");
    expect(roomsChain.insert).toHaveBeenCalledWith({
      owner_user_id: "user-1",
      status: "active",
      max_participants: 5,
    });
    expect(redirectMock).toHaveBeenCalledWith("/rooms/room-123/invite");
  });

  it("未認証（getUserがuser:nullを返す）→ insertは呼ばれず、エラーを返す（redirectも未実行）", async () => {
    const { userProfilesChain, plansChain, roomsChain } = setupSupabaseMock({
      user: null,
    });

    const result = await createRoomAction(initialCreateRoomState, new FormData());

    expect(result.error).toBe("ログインが必要です。再度ログインしてください。");
    expect(userProfilesChain.select).not.toHaveBeenCalled();
    expect(plansChain.select).not.toHaveBeenCalled();
    expect(roomsChain.insert).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("getUserがerrorを返す場合もログイン必須エラーとなり、insertは呼ばれない", async () => {
    const { roomsChain } = setupSupabaseMock({
      user: null,
      userError: { message: "invalid session" },
    });

    const result = await createRoomAction(initialCreateRoomState, new FormData());

    expect(result.error).toBe("ログインが必要です。再度ログインしてください。");
    expect(roomsChain.insert).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("user_profiles取得に失敗 → プロフィール取得エラーを返し、plans取得・insertは行われない", async () => {
    const { plansChain, roomsChain } = setupSupabaseMock({
      user: { id: "user-1" },
      profileError: { message: "profile db error" },
    });

    const result = await createRoomAction(initialCreateRoomState, new FormData());

    expect(result.error).toBe(
      "プロフィールの取得に失敗しました。時間をおいて再度お試しください。"
    );
    expect(plansChain.select).not.toHaveBeenCalled();
    expect(roomsChain.insert).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("plans取得に失敗 → フォールバック値(2)でinsertされる", async () => {
    const { roomsChain } = setupSupabaseMock({
      user: { id: "user-1" },
      profile: { plan_id: "plan-unknown" },
      planError: { message: "plan not found" },
      room: { id: "room-999" },
    });

    await expect(
      createRoomAction(initialCreateRoomState, new FormData())
    ).rejects.toThrow("NEXT_REDIRECT:/rooms/room-999/invite");

    expect(roomsChain.insert).toHaveBeenCalledWith({
      owner_user_id: "user-1",
      status: "active",
      max_participants: 2,
    });
  });

  it("rooms insertに失敗 → エラーを返し、redirectは実行されない", async () => {
    setupSupabaseMock({
      user: { id: "user-1" },
      profile: { plan_id: "plan-pro" },
      plan: { max_participants: 5 },
      room: null,
      insertError: { message: "insert failed" },
    });

    const result = await createRoomAction(initialCreateRoomState, new FormData());

    expect(result.error).toBe(
      "ルームの作成に失敗しました。時間をおいて再度お試しください。"
    );
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
