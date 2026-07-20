/**
 * server/db/supabaseAdmin.ts の単体テスト。
 *
 * `markRoomActive`（bd-gz1、endedルームの再開時にDBを 'active' に戻す）を中心に検証する。
 * 実 Supabase への接続は行わず、`setSupabaseAdminClient` でモックを注入する。
 *
 * @see server/db/supabaseAdmin.ts
 * @see docs/design/server-design.md 「実装確定事項（bd-gz1 で追加: endedルームの再開）」
 */
import {
  markRoomActive,
  markRoomEnded,
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";

describe("supabaseAdmin", () => {
  let originalUrl: string | undefined;
  let originalServiceKey: string | undefined;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    originalUrl = process.env.SUPABASE_URL;
    originalServiceKey = process.env.SUPABASE_SERVICE_KEY;
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetSupabaseAdminClient();
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
    consoleErrorSpy.mockRestore();
  });

  /** from().update().eq() のみをモックした最小クライアントを生成する */
  function createMockClient(eqResult: { error: { message: string } | null } = { error: null }) {
    const eq = jest.fn().mockResolvedValue(eqResult);
    const update = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ update });
    return { from, update, eq };
  }

  describe("markRoomActive", () => {
    it("rooms テーブルに対し status:'active', ended_at:null で update し、対象roomIdでeqする", async () => {
      const { from, update, eq } = createMockClient();
      setSupabaseAdminClient({ from } as never);

      await markRoomActive("room-1");

      expect(from).toHaveBeenCalledWith("rooms");
      expect(update).toHaveBeenCalledWith({ status: "active", ended_at: null });
      expect(eq).toHaveBeenCalledWith("id", "room-1");
    });

    it("update がエラーを返してもmarkRoomActiveは例外を投げない（ログ出力のみ）", async () => {
      const { from } = createMockClient({ error: { message: "db error" } });
      setSupabaseAdminClient({ from } as never);

      await expect(markRoomActive("room-1")).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to mark room active"),
        "db error",
      );
    });

    it("SUPABASE_URL/SUPABASE_SERVICE_KEYが未設定でも例外を投げない（クライアント取得失敗を捕捉する）", async () => {
      resetSupabaseAdminClient();
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;

      await expect(markRoomActive("room-1")).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[supabaseAdmin] markRoomActive unexpected error:",
        expect.stringContaining("SUPABASE_URL"),
      );
    });
  });

  describe("markRoomEnded（対になる既存関数、比較のため最小限のみ確認）", () => {
    it("rooms テーブルに対し status:'ended' で update し、対象roomIdでeqする", async () => {
      const { from, update, eq } = createMockClient();
      setSupabaseAdminClient({ from } as never);

      await markRoomEnded("room-1");

      expect(from).toHaveBeenCalledWith("rooms");
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ended", ended_at: expect.any(String) }),
      );
      expect(eq).toHaveBeenCalledWith("id", "room-1");
    });

    it("SUPABASE_URL/SUPABASE_SERVICE_KEYが未設定でも例外を投げない", async () => {
      resetSupabaseAdminClient();
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;

      await expect(markRoomEnded("room-1")).resolves.toBeUndefined();
    });
  });
});
