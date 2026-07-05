/**
 * `POST /api/guest/join` Route Handler の単体テスト（bd-jny）。
 *
 * `src/lib/supabase/admin.ts`（管理者権限クライアント）と
 * `shared/auth/guestToken.ts` の `signGuestToken` をモックし、
 * 実 Supabase / 実 JWT 署名には触れない。
 *
 * 検証観点:
 * - 正常系: invite有効（expires_at未来・room active）→ participants insert
 *   （role="guest"、サーバー生成 guest_cookie_id）→ gtt_guest クッキー
 *   （httpOnly・sameSite=lax・maxAge=7日）→ roomId 返却
 * - 異常系: 無効トークン・期限切れ・room非active → 4xx＋一律エラー文言
 * - 入力不正（zod）: inviteToken欠落・language不正 → 4xx
 * - insert失敗 → 一律エラー、クッキー未設定
 */
import { NextRequest } from "next/server";
import { DEFAULT_GUEST_TOKEN_TTL_SEC, GUEST_COOKIE_NAME } from "../../shared/auth/guestToken";

jest.mock("../../src/lib/supabase/admin", () => ({
  getSupabaseAdminClient: jest.fn(),
}));

jest.mock("../../shared/auth/guestToken", () => {
  const actual = jest.requireActual("../../shared/auth/guestToken");
  return {
    ...actual,
    signGuestToken: jest.fn(),
  };
});

import { getSupabaseAdminClient } from "../../src/lib/supabase/admin";
import { signGuestToken } from "../../shared/auth/guestToken";
// route.ts は上記モックの後に import する（ホイスト順に依存しないよう明示）。
import { POST } from "../../src/app/api/guest/join/route";

const mockedGetSupabaseAdminClient = getSupabaseAdminClient as jest.Mock;
const mockedSignGuestToken = signGuestToken as jest.Mock;

// ---------------------------------------------------------------------------
// テストヘルパー
// ---------------------------------------------------------------------------

type InviteResult = {
  data:
    | {
        room_id: string;
        expires_at: string;
        room: { status: string } | { status: string }[];
      }
    | null;
  error: { message: string } | null;
};
type ParticipantInsertResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

function makeMockSupabaseClient(options: {
  inviteResult?: InviteResult;
  participantInsertResult?: ParticipantInsertResult;
}) {
  const inviteResult: InviteResult = options.inviteResult ?? {
    data: null,
    error: { message: "not configured" },
  };
  const participantInsertResult: ParticipantInsertResult = options.participantInsertResult ?? {
    data: { id: "participant-1" },
    error: null,
  };

  // invites チェーン: from("invites").select().eq().maybeSingle()
  const inviteMaybeSingle = jest.fn().mockResolvedValue(inviteResult);
  const inviteEq = jest.fn().mockReturnValue({ maybeSingle: inviteMaybeSingle });
  const inviteSelect = jest.fn().mockReturnValue({ eq: inviteEq });

  // participants チェーン: from("participants").insert().select().single()
  const participantSingle = jest.fn().mockResolvedValue(participantInsertResult);
  const participantSelect = jest.fn().mockReturnValue({ single: participantSingle });
  const participantInsert = jest.fn().mockReturnValue({ select: participantSelect });

  const from = jest.fn((table: string) => {
    if (table === "invites") {
      return { select: inviteSelect };
    }
    if (table === "participants") {
      return { insert: participantInsert };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from },
    from,
    inviteSelect,
    inviteEq,
    inviteMaybeSingle,
    participantInsert,
    participantSelect,
    participantSingle,
  };
}

function futureIso(daysFromNow = 1): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(daysAgo = 1): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/guest/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    inviteToken: "valid-invite-token",
    displayName: "Guest花子",
    language: "en-US",
    ...overrides,
  };
}

/**
 * `process.env.NODE_ENV` を書き換える。
 *
 * この環境（jest 29 + ts-jest + Next.js の `next/server` を import するテスト）
 * では、`Object.defineProperty(process.env, "NODE_ENV", { value, writable: true, ... })`
 * で記述子を丸ごと再定義しても値が反映されない（`process.env` 自体の
 * `set` トラップ経由の代入のみが確実に反映される）ことを実測で確認したため、
 * あえて素朴な代入を用いる。`undefined` を渡した場合は `delete` して
 * 未設定状態に戻す（`beforeEach` で退避した元の値が undefined だったケースの復元用）。
 */
function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = value;
}

describe("POST /api/guest/join", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSignGuestToken.mockResolvedValue("signed.jwt.token");
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  // -------------------------------------------------------------------------
  // 正常系
  // -------------------------------------------------------------------------
  describe("正常系", () => {
    test("有効な招待トークン → participants insert（role=guest, guest_cookie_idはサーバー生成）→ gtt_guestクッキー設定 → roomId返却", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: {
            room_id: "room-1",
            expires_at: futureIso(),
            room: { status: "active" },
          },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ roomId: "room-1" });

      // participants insert の内容確認（role=guest、guest_cookie_idはUUID形式でサーバー生成）
      expect(mock.participantInsert).toHaveBeenCalledTimes(1);
      const insertArg = mock.participantInsert.mock.calls[0][0];
      expect(insertArg.room_id).toBe("room-1");
      expect(insertArg.role).toBe("guest");
      expect(insertArg.display_name).toBe("Guest花子");
      expect(insertArg.language).toBe("en-US");
      expect(typeof insertArg.guest_cookie_id).toBe("string");
      expect(insertArg.guest_cookie_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // signGuestToken には insert 結果の participantId が渡る
      expect(mockedSignGuestToken).toHaveBeenCalledWith({
        roomId: "room-1",
        participantId: "participant-1",
      });

      // クッキー属性の確認
      const setCookie = response.cookies.get(GUEST_COOKIE_NAME);
      expect(setCookie).toBeDefined();
      expect(setCookie!.value).toBe("signed.jwt.token");
      expect(setCookie!.httpOnly).toBe(true);
      expect(setCookie!.sameSite).toBe("lax");
      expect(setCookie!.maxAge).toBe(DEFAULT_GUEST_TOKEN_TTL_SEC);
    });

    test("displayName未指定 → nullとしてinsertされる", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const body = validBody();
      delete (body as Record<string, unknown>).displayName;

      const response = await POST(makeRequest(body));

      expect(response.status).toBe(200);
      const insertArg = mock.participantInsert.mock.calls[0][0];
      expect(insertArg.display_name).toBeNull();
    });

    test("room が配列形状（room: [{status:'active'}]）で返るケース → 正常にroomIdを返す（Array.isArray防御分岐のカバレッジ）", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: {
            room_id: "room-1",
            expires_at: futureIso(),
            room: [{ status: "active" }],
          },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ roomId: "room-1" });
      expect(mock.participantInsert).toHaveBeenCalledTimes(1);
    });

    test("NODE_ENV=production のとき、gtt_guestクッキーにsecure属性が付く", async () => {
      setNodeEnv("production");

      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(200);
      const setCookie = response.cookies.get(GUEST_COOKIE_NAME);
      expect(setCookie).toBeDefined();
      expect(setCookie!.secure).toBe(true);
    });

    test("NODE_ENV=production以外（例: development/test）のとき、gtt_guestクッキーにsecure属性が付かない", async () => {
      setNodeEnv("development");

      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(200);
      const setCookie = response.cookies.get(GUEST_COOKIE_NAME);
      expect(setCookie).toBeDefined();
      expect(setCookie!.secure).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // 異常系: invite の有効性
  // -------------------------------------------------------------------------
  describe("異常系: 招待トークンの有効性", () => {
    test("存在しないinviteToken（maybeSingleがdata:null）→ 4xx＋一律エラー文言", async () => {
      const mock = makeMockSupabaseClient({ inviteResult: { data: null, error: null } });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const json = await response.json();
      expect(json.error).toContain("招待リンクは無効か、有効期限が切れています");
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });

    test("期限切れ（expires_atが過去）→ 4xx＋一律エラー文言", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: pastIso(), room: { status: "active" } },
          error: null,
        },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const json = await response.json();
      expect(json.error).toContain("招待リンクは無効か、有効期限が切れています");
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });

    test("ルームがactiveでない（例: closed）→ 4xx＋一律エラー文言", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "closed" } },
          error: null,
        },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const json = await response.json();
      expect(json.error).toContain("招待リンクは無効か、有効期限が切れています");
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });

    test("invite照合クエリがエラーを返す（DB障害）→ 5xx＋一律エラー文言（内部詳細は含まない）", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: { data: null, error: { message: "connection refused" } },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      const json = await response.json();
      expect(json.error).not.toContain("connection refused");
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 異常系: 入力バリデーション（zod）
  // -------------------------------------------------------------------------
  describe("異常系: 入力バリデーション", () => {
    test("inviteToken欠落 → 4xx", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).inviteToken;

      const response = await POST(makeRequest(body));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(mockedGetSupabaseAdminClient).not.toHaveBeenCalled();
    });

    test("inviteTokenが空文字 → 4xx", async () => {
      const response = await POST(makeRequest(validBody({ inviteToken: "" })));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    test("languageが不正な値 → 4xx", async () => {
      const response = await POST(makeRequest(validBody({ language: "fr-FR" })));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(mockedGetSupabaseAdminClient).not.toHaveBeenCalled();
    });

    test("language欠落 → 4xx", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).language;

      const response = await POST(makeRequest(body));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    test("リクエストボディがJSONとして不正 → 4xx", async () => {
      const request = new NextRequest("http://localhost/api/guest/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      });

      const response = await POST(request);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(mockedGetSupabaseAdminClient).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 異常系: participants insert 失敗
  // -------------------------------------------------------------------------
  describe("異常系: participants insert 失敗", () => {
    test("insertがerrorを返す → 一律エラー、クッキー未設定", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: null, error: { message: "unique violation" } },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      const json = await response.json();
      expect(json.error).not.toContain("unique violation");
      expect(response.cookies.get(GUEST_COOKIE_NAME)).toBeUndefined();
      expect(mockedSignGuestToken).not.toHaveBeenCalled();
    });

    test("insertがdata:nullをerrorなしで返す → 一律エラー、クッキー未設定", async () => {
      const mock = makeMockSupabaseClient({
        inviteResult: {
          data: { room_id: "room-1", expires_at: futureIso(), room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: null, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.cookies.get(GUEST_COOKIE_NAME)).toBeUndefined();
    });
  });
});
