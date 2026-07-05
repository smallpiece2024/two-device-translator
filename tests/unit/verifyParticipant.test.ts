/**
 * server/auth/verifyParticipant.ts の単体テスト（bd-0jy、bd-e3p でowner安定ID化を追加）。
 *
 * - owner: supabaseAdmin.auth.getUser + rooms.owner_user_id 照合 +
 *   participants(room_id/user_id/role='owner') による安定ID解決（bd-e3p）
 * - guest: verifyGuestToken + payload.roomId 照合
 * - AUTH_MODE=insecure: 常に成功するダミー検証
 *
 * Supabase / GCP への実通信は行わない（setSupabaseAdminClient でモック注入）。
 */
import { verifyJoin, isInsecureAuthMode } from "../../server/auth/verifyParticipant";
import {
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";
import { signGuestToken } from "../../shared/auth/guestToken";
import type { JoinMessage } from "../../shared/index";

// ---------------------------------------------------------------------------
// テストヘルパー
// ---------------------------------------------------------------------------

/**
 * supabaseAdmin モッククライアントを構築する。
 * `auth.getUser(token)` と `from("rooms").select().eq().single()`、
 * `from("participants").select().eq().eq().eq().maybeSingle()`、
 * `from("participants").insert().select().single()`（bd-e3p、owner安定ID発行用）の
 * チェーンをモックする（テーブル名に応じて分岐する）。
 */
function makeMockSupabaseClient(options: {
  getUserResult?: { data: { user: { id: string } | null }; error: { message: string } | null };
  roomResult?: { data: { owner_user_id: string } | null; error: { message: string } | null };
  participantResult?: { data: { id: string } | null; error: { message: string } | null };
  participantInsertResult?: { data: { id: string } | null; error: { message: string } | null };
}) {
  const getUserResult = options.getUserResult ?? {
    data: { user: null },
    error: { message: "not configured" },
  };
  const roomResult = options.roomResult ?? {
    data: null,
    error: { message: "not configured" },
  };
  const participantResult = options.participantResult ?? {
    data: { id: "guest-xyz" },
    error: null,
  };
  const participantInsertResult = options.participantInsertResult ?? {
    data: { id: "inserted-id" },
    error: null,
  };

  // rooms チェーン: from("rooms").select().eq().single()
  const roomsSingle = jest.fn().mockResolvedValue(roomResult);
  const roomsEq = jest.fn().mockReturnValue({ single: roomsSingle });
  const roomsSelect = jest.fn().mockReturnValue({ eq: roomsEq });

  // participants select チェーン: from("participants").select().eq().eq().eq().maybeSingle()
  const participantsMaybeSingle = jest.fn().mockResolvedValue(participantResult);
  const participantsEq3 = jest.fn().mockReturnValue({ maybeSingle: participantsMaybeSingle });
  const participantsEq2 = jest.fn().mockReturnValue({ eq: participantsEq3 });
  const participantsEq1 = jest.fn().mockReturnValue({ eq: participantsEq2 });
  const participantsSelect = jest.fn().mockReturnValue({ eq: participantsEq1 });

  // participants insert チェーン: from("participants").insert(obj).select("id").single()
  const participantsInsertSingle = jest.fn().mockResolvedValue(participantInsertResult);
  const participantsInsertSelect = jest.fn().mockReturnValue({ single: participantsInsertSingle });
  const participantsInsert = jest.fn().mockReturnValue({ select: participantsInsertSelect });

  const from = jest.fn((table: string) => {
    if (table === "participants") {
      return { select: participantsSelect, insert: participantsInsert };
    }
    return { select: roomsSelect };
  });
  const getUser = jest.fn().mockResolvedValue(getUserResult);

  return {
    client: { auth: { getUser }, from } as never,
    getUser,
    from,
    select: roomsSelect,
    eq: roomsEq,
    single: roomsSingle,
    participantsSelect,
    participantsEq1,
    participantsEq2,
    participantsEq3,
    participantsMaybeSingle,
    participantsInsert,
    participantsInsertSelect,
    participantsInsertSingle,
  };
}

function makeJoin(overrides: Partial<JoinMessage> = {}): JoinMessage {
  return {
    type: "join",
    roomId: "room-1",
    role: "owner",
    token: "some-token",
    language: "ja-JP",
    ...overrides,
  };
}

describe("verifyParticipant", () => {
  let originalAuthMode: string | undefined;
  let originalGuestSecret: string | undefined;

  beforeEach(() => {
    originalAuthMode = process.env.AUTH_MODE;
    originalGuestSecret = process.env.GUEST_COOKIE_SECRET;
    delete process.env.AUTH_MODE;
    process.env.GUEST_COOKIE_SECRET = "a".repeat(32);
  });

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
    if (originalGuestSecret === undefined) {
      delete process.env.GUEST_COOKIE_SECRET;
    } else {
      process.env.GUEST_COOKIE_SECRET = originalGuestSecret;
    }
    resetSupabaseAdminClient();
  });

  // -------------------------------------------------------------------------
  // owner role
  // -------------------------------------------------------------------------
  describe("owner join", () => {
    test("getUser成功＋owner_user_id一致 → identityを返す（role/participantIdの内容確認）", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: { id: "user-abc" } }, error: null },
        roomResult: { data: { owner_user_id: "user-abc" }, error: null },
        participantResult: { data: { id: "owner-p-1" }, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const join = makeJoin({ role: "owner", roomId: "room-1", displayName: "Owner太郎" });
      const identity = await verifyJoin(join);

      expect(identity).not.toBeNull();
      expect(identity!.role).toBe("owner");
      expect(identity!.displayName).toBe("Owner太郎");
      expect(identity!.language).toBe("ja-JP");
      expect(typeof identity!.participantId).toBe("string");
      expect(identity!.participantId.length).toBeGreaterThan(0);

      expect(mock.getUser).toHaveBeenCalledWith("some-token");
      expect(mock.from).toHaveBeenCalledWith("rooms");
      expect(mock.eq).toHaveBeenCalledWith("id", "room-1");
    });

    test("getUserが失敗（error返却）→ null", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: null }, error: { message: "invalid token" } },
      });
      setSupabaseAdminClient(mock.client);

      const identity = await verifyJoin(makeJoin({ role: "owner" }));

      expect(identity).toBeNull();
    });

    test("getUserがuser:nullをerrorなしで返す → null", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: null }, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const identity = await verifyJoin(makeJoin({ role: "owner" }));

      expect(identity).toBeNull();
    });

    test("rooms該当なし（data:null）→ null", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: { id: "user-abc" } }, error: null },
        roomResult: { data: null, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const identity = await verifyJoin(makeJoin({ role: "owner" }));

      expect(identity).toBeNull();
    });

    test("rooms取得がerrorを返す → null", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: { id: "user-abc" } }, error: null },
        roomResult: { data: null, error: { message: "db error" } },
      });
      setSupabaseAdminClient(mock.client);

      const identity = await verifyJoin(makeJoin({ role: "owner" }));

      expect(identity).toBeNull();
    });

    test("owner_user_id不一致 → null", async () => {
      const mock = makeMockSupabaseClient({
        getUserResult: { data: { user: { id: "user-abc" } }, error: null },
        roomResult: { data: { owner_user_id: "someone-else" }, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const identity = await verifyJoin(makeJoin({ role: "owner" }));

      expect(identity).toBeNull();
    });

    // -----------------------------------------------------------------------
    // owner安定ID化（bd-e3p、resolveOwnerParticipantId）
    // -----------------------------------------------------------------------
    describe("owner安定ID化（bd-e3p）", () => {
      test("participantsに既存行がある場合、その id が participantId として使われ、insertは呼ばれない", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: { id: "existing-owner-participant-id" }, error: null },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(
          makeJoin({ role: "owner", roomId: "room-1", displayName: "Owner太郎" }),
        );

        expect(identity).not.toBeNull();
        expect(identity!.participantId).toBe("existing-owner-participant-id");
        expect(mock.participantsEq1).toHaveBeenCalledWith("room_id", "room-1");
        expect(mock.participantsEq2).toHaveBeenCalledWith("user_id", "user-abc");
        expect(mock.participantsEq3).toHaveBeenCalledWith("role", "owner");
        expect(mock.participantsInsert).not.toHaveBeenCalled();
      });

      test("participantsに既存行が無い場合、insertされ新しいidがparticipantIdとして使われる", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: null },
          participantInsertResult: { data: { id: "new-owner-participant-id" }, error: null },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(
          makeJoin({
            role: "owner",
            roomId: "room-1",
            displayName: "Owner太郎",
            language: "ja-JP",
            enableTts: true,
          }),
        );

        expect(identity).not.toBeNull();
        expect(identity!.participantId).toBe("new-owner-participant-id");
        expect(mock.participantsInsert).toHaveBeenCalledWith({
          room_id: "room-1",
          role: "owner",
          user_id: "user-abc",
          display_name: "Owner太郎",
          language: "ja-JP",
          tts_enabled: true,
        });
        expect(mock.participantsInsertSelect).toHaveBeenCalledWith("id");
      });

      test("displayName省略時、insertのdisplay_nameはnullになる", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: null },
          participantInsertResult: { data: { id: "new-owner-participant-id" }, error: null },
        });
        setSupabaseAdminClient(mock.client);

        await verifyJoin(makeJoin({ role: "owner", roomId: "room-1", displayName: undefined }));

        expect(mock.participantsInsert).toHaveBeenCalledWith(
          expect.objectContaining({ display_name: null }),
        );
      });

      test("insertがerrorを返す → null（fail-closed）", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: null },
          participantInsertResult: { data: null, error: { message: "insert failed" } },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

        expect(identity).toBeNull();
      });

      test("insertがerrorなしで行を返さない（data:null）→ null（fail-closed）", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: null },
          participantInsertResult: { data: null, error: null },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

        expect(identity).toBeNull();
      });

      test("participants照合（select）がerrorを返す → null（insertは呼ばれない）", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: { message: "db error" } },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

        expect(identity).toBeNull();
        expect(mock.participantsInsert).not.toHaveBeenCalled();
      });

      // -----------------------------------------------------------------------
      // TOCTOU競合フォールバック（must-fix2、コードレビュー指摘対応）
      // -----------------------------------------------------------------------
      test(
        "insertが一意制約違反（code:'23505'）で失敗した場合、再selectで既存行を取得して" +
          "participantIdに使う（同時joinの競合フォールバック）",
        async () => {
          const mock = makeMockSupabaseClient({
            getUserResult: { data: { user: { id: "user-abc" } }, error: null },
            roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          });
          // 1回目のselect: 行なし（→insertを試みる） / 2回目（再select）: 競合相手が
          // 先に作成した行が見つかる、という順序をシミュレートする。
          mock.participantsMaybeSingle
            .mockReset()
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({
              data: { id: "row-created-by-concurrent-request" },
              error: null,
            });
          // insertは一意制約違反（Postgres 23505）で失敗する。
          mock.participantsInsertSingle.mockResolvedValue({
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          });
          setSupabaseAdminClient(mock.client);

          const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

          expect(identity).not.toBeNull();
          expect(identity!.participantId).toBe("row-created-by-concurrent-request");
          expect(mock.participantsInsert).toHaveBeenCalledTimes(1);
          expect(mock.participantsMaybeSingle).toHaveBeenCalledTimes(2);
        },
      );

      test(
        "insertが一意制約違反で失敗し、再selectでも行が見つからない場合 → null（fail-closed）",
        async () => {
          const mock = makeMockSupabaseClient({
            getUserResult: { data: { user: { id: "user-abc" } }, error: null },
            roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          });
          mock.participantsMaybeSingle
            .mockReset()
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: null, error: null });
          mock.participantsInsertSingle.mockResolvedValue({
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          });
          setSupabaseAdminClient(mock.client);

          const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

          expect(identity).toBeNull();
        },
      );

      test("insertが一意制約違反以外のerrorで失敗した場合は再selectせずnullを返す", async () => {
        const mock = makeMockSupabaseClient({
          getUserResult: { data: { user: { id: "user-abc" } }, error: null },
          roomResult: { data: { owner_user_id: "user-abc" }, error: null },
          participantResult: { data: null, error: null },
        });
        mock.participantsInsertSingle.mockResolvedValue({
          data: null,
          error: { message: "some other db error", code: "OTHER" },
        });
        setSupabaseAdminClient(mock.client);

        const identity = await verifyJoin(makeJoin({ role: "owner", roomId: "room-1" }));

        expect(identity).toBeNull();
        // 通常select(1回) + insert(1回) のみ。一意制約違反以外では再selectしない。
        expect(mock.participantsMaybeSingle).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // guest role
  // -------------------------------------------------------------------------
  describe("guest join", () => {
    test("正常な署名済みトークン・roomId一致＋participants行実在 → identityを返す（participantIdはpayload由来）", async () => {
      const mock = makeMockSupabaseClient({
        participantResult: { data: { id: "guest-xyz" }, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });

      const identity = await verifyJoin(
        makeJoin({ role: "guest", roomId: "room-1", token, displayName: "Guest花子", language: "en-US" }),
      );

      expect(identity).not.toBeNull();
      expect(identity!.role).toBe("guest");
      expect(identity!.participantId).toBe("guest-xyz");
      expect(identity!.displayName).toBe("Guest花子");
      expect(identity!.language).toBe("en-US");
    });

    test("署名不正なトークン → null", async () => {
      const identity = await verifyJoin(
        makeJoin({ role: "guest", roomId: "room-1", token: "not-a-valid-jwt" }),
      );

      expect(identity).toBeNull();
    });

    test("期限切れトークン → null", async () => {
      const token = await signGuestToken(
        { roomId: "room-1", participantId: "guest-xyz" },
        { expSec: -10 },
      );

      const identity = await verifyJoin(makeJoin({ role: "guest", roomId: "room-1", token }));

      expect(identity).toBeNull();
    });

    test("トークンのroomIdとjoin先roomIdが不一致 → null（改ざん・流用防止）", async () => {
      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });

      const identity = await verifyJoin(
        makeJoin({ role: "guest", roomId: "room-DIFFERENT", token }),
      );

      expect(identity).toBeNull();
    });

    test("別の鍵で署名されたトークン（GUEST_COOKIE_SECRET不一致）→ null", async () => {
      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });

      process.env.GUEST_COOKIE_SECRET = "b".repeat(32);

      const identity = await verifyJoin(makeJoin({ role: "guest", roomId: "room-1", token }));

      expect(identity).toBeNull();
    });

    test("participants行が存在しない（maybeSingleがdata:null）→ null（招待取消・行削除後の古いクッキーでの再参加を拒否）", async () => {
      const mock = makeMockSupabaseClient({
        participantResult: { data: null, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });
      const identity = await verifyJoin(makeJoin({ role: "guest", roomId: "room-1", token }));

      expect(identity).toBeNull();
    });

    test("participantsの照合クエリがエラーを返す → null", async () => {
      const mock = makeMockSupabaseClient({
        participantResult: { data: null, error: { message: "db error" } },
      });
      setSupabaseAdminClient(mock.client);

      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });
      const identity = await verifyJoin(makeJoin({ role: "guest", roomId: "room-1", token }));

      expect(identity).toBeNull();
    });

    test("participants照合条件（id/room_id/roleの3つのeq）が正しい引数で呼ばれる", async () => {
      const mock = makeMockSupabaseClient({
        participantResult: { data: { id: "guest-xyz" }, error: null },
      });
      setSupabaseAdminClient(mock.client);

      const token = await signGuestToken({ roomId: "room-1", participantId: "guest-xyz" });
      await verifyJoin(makeJoin({ role: "guest", roomId: "room-1", token }));

      expect(mock.from).toHaveBeenCalledWith("participants");
      expect(mock.participantsSelect).toHaveBeenCalledWith("id");
      expect(mock.participantsEq1).toHaveBeenCalledWith("id", "guest-xyz");
      expect(mock.participantsEq2).toHaveBeenCalledWith("room_id", "room-1");
      expect(mock.participantsEq3).toHaveBeenCalledWith("role", "guest");
    });
  });

  // -------------------------------------------------------------------------
  // AUTH_MODE=insecure
  // -------------------------------------------------------------------------
  describe("AUTH_MODE=insecure（移行互換モード）", () => {
    test("insecureのとき、owner roleで任意トークンでも成功する", async () => {
      process.env.AUTH_MODE = "insecure";

      const identity = await verifyJoin(
        makeJoin({ role: "owner", token: "dummy-token", displayName: "誰でも" }),
      );

      expect(identity).not.toBeNull();
      expect(identity!.role).toBe("owner");
      expect(identity!.displayName).toBe("誰でも");
    });

    test("insecureのとき、guest roleで任意トークン（不正JWT）でも成功する", async () => {
      process.env.AUTH_MODE = "insecure";

      const identity = await verifyJoin(
        makeJoin({ role: "guest", token: "totally-invalid-token" }),
      );

      expect(identity).not.toBeNull();
      expect(identity!.role).toBe("guest");
    });

    test("isInsecureAuthMode() はAUTH_MODE=insecureのときtrueを返す", () => {
      process.env.AUTH_MODE = "insecure";
      expect(isInsecureAuthMode()).toBe(true);
    });

    test("AUTH_MODE未設定のときisInsecureAuthMode()はfalse（strict）", () => {
      delete process.env.AUTH_MODE;
      expect(isInsecureAuthMode()).toBe(false);
    });

    test("AUTH_MODEが'insecure'以外の値（例: 'strict'）のときはstrict検証のまま", async () => {
      process.env.AUTH_MODE = "strict";

      const identity = await verifyJoin(
        makeJoin({ role: "guest", token: "totally-invalid-token" }),
      );

      expect(identity).toBeNull();
      expect(isInsecureAuthMode()).toBe(false);
    });

    test("AUTH_MODE='INSECURE'（大文字）は厳密一致で無効・strictのまま", async () => {
      process.env.AUTH_MODE = "INSECURE";

      expect(isInsecureAuthMode()).toBe(false);

      const identity = await verifyJoin(
        makeJoin({ role: "guest", token: "totally-invalid-token" }),
      );

      expect(identity).toBeNull();
    });
  });
});
