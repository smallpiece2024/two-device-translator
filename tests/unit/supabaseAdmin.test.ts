/**
 * server/db/supabaseAdmin.ts の単体テスト（bd-0jy、bd-e3p で markRoomEnded を追加）。
 *
 * 遅延初期化シングルトン（getSupabaseAdminClient/setSupabaseAdminClient/
 * resetSupabaseAdminClient）と、env未設定時のエラー、markRoomEnded の
 * fire-and-forget的な例外安全性を検証する。実 Supabase への通信は行わない。
 */
import {
  getSupabaseAdminClient,
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
  markRoomEnded,
} from "../../server/db/supabaseAdmin";

describe("supabaseAdmin", () => {
  let originalUrl: string | undefined;
  let originalServiceKey: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.SUPABASE_URL;
    originalServiceKey = process.env.SUPABASE_SERVICE_KEY;
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.SUPABASE_URL;
    } else {
      process.env.SUPABASE_URL = originalUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_KEY = originalServiceKey;
    }
    resetSupabaseAdminClient();
    jest.restoreAllMocks();
  });

  test("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定のとき、getSupabaseAdminClient()は明確なエラーを投げる", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(() => getSupabaseAdminClient()).toThrow(
      /SUPABASE_URL.*SUPABASE_SERVICE_KEY/,
    );
  });

  test("SUPABASE_URL のみ未設定のときもエラーを投げる", () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = "service-key";

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("SUPABASE_SERVICE_KEY のみ未設定のときもエラーを投げる", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("setSupabaseAdminClient() で注入したクライアントが getSupabaseAdminClient() で返る", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;

    setSupabaseAdminClient(mockClient);

    expect(getSupabaseAdminClient()).toBe(mockClient);
  });

  test("getSupabaseAdminClient() を2回呼んでも同一インスタンスが返る（シングルトン）", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(mockClient);

    const first = getSupabaseAdminClient();
    const second = getSupabaseAdminClient();

    expect(first).toBe(second);
  });

  test("resetSupabaseAdminClient() 後は再度env未設定エラーになる（クライアントが破棄される）", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(mockClient);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    resetSupabaseAdminClient();

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("resetSupabaseAdminClient() 後、env設定済みなら新しいクライアントが生成される（差し替え確認）", () => {
    const firstMock = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(firstMock);

    resetSupabaseAdminClient();

    const secondMock = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(secondMock);

    expect(getSupabaseAdminClient()).toBe(secondMock);
    expect(getSupabaseAdminClient()).not.toBe(firstMock);
  });

  // ---------------------------------------------------------------------------
  // markRoomEnded（bd-e3p）
  // ---------------------------------------------------------------------------
  describe("markRoomEnded", () => {
    /** from("rooms").update({...}).eq("id", roomId) のチェーンをモックする */
    function makeMockClient(updateResult: { error: { message: string } | null }) {
      const eq = jest.fn().mockResolvedValue(updateResult);
      const update = jest.fn().mockReturnValue({ eq });
      const from = jest.fn().mockReturnValue({ update });
      return { client: { from } as never, from, update, eq };
    }

    test("rooms.update が status:'ended' と ended_at(ISO文字列) で呼ばれ、eqにroomIdが渡される", async () => {
      const mock = makeMockClient({ error: null });
      setSupabaseAdminClient(mock.client);

      await markRoomEnded("room-1");

      expect(mock.from).toHaveBeenCalledWith("rooms");
      expect(mock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ended",
          ended_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      );
      expect(mock.eq).toHaveBeenCalledWith("id", "room-1");
    });

    test("update がerrorを返しても例外を投げない", async () => {
      const mock = makeMockClient({ error: { message: "db error" } });
      setSupabaseAdminClient(mock.client);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(markRoomEnded("room-1")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    test("SUPABASE_URL/SUPABASE_SERVICE_KEY未設定（getSupabaseAdminClient自体が例外）でも例外を投げない", async () => {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      resetSupabaseAdminClient();
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(markRoomEnded("room-1")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    test("fromが例外を投げるクライアントでも例外を投げない", async () => {
      const throwingClient = {
        from: jest.fn(() => {
          throw new Error("unexpected client error");
        }),
      } as never;
      setSupabaseAdminClient(throwingClient);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(markRoomEnded("room-1")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
