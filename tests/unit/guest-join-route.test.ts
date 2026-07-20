/**
 * `POST /api/guest/join` Route Handler の単体テスト（bd-jny, bd-1oy）。
 *
 * `src/lib/supabase/admin.ts`（管理者権限クライアント）と
 * `shared/auth/guestToken.ts` の `signGuestToken` をモックし、
 * 実 Supabase / 実 JWT 署名には触れない。
 *
 * 検証観点:
 * - 正常系: invite有効（expires_at未来・room active・未使用）→ 原子的consume
 *   （update({used_at}).eq("token").is("used_at",null).gt("expires_at",now)）
 *   → participants insert（role="guest"、サーバー生成 guest_cookie_id）
 *   → gtt_guest クッキー（httpOnly・sameSite=lax・maxAge=7日）→ roomId 返却
 * - 異常系: 無効トークン・期限切れ・使用済み（いずれもconsumeが0行ヒット）・
 *   room非active（consume成功後に判明、補償updateが呼ばれる） → 4xx＋一律エラー文言
 * - 入力不正（zod）: inviteToken欠落・language不正 → 4xx
 * - insert失敗（補償updateが呼ばれる） → 一律エラー、クッキー未設定
 * - 単回消費化（bd-1oy）: consumeのWHERE句に token/used_at is null/expires_at > now
 *   が正しく渡ること（この条件が外れると同一トークンの2回目joinが拒否されなくなる）
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

type ConsumeResult = {
  data:
    | {
        id: string;
        room_id: string;
        room: { status: string } | { status: string }[];
      }
    | null;
  error: { message: string } | null;
};
type CompensateResult = { error: { message: string } | null };
type ParticipantInsertResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

function makeMockSupabaseClient(options: {
  consumeResult?: ConsumeResult;
  compensateResult?: CompensateResult;
  participantInsertResult?: ParticipantInsertResult;
}) {
  const consumeResult: ConsumeResult = options.consumeResult ?? {
    data: null,
    error: { message: "not configured" },
  };
  const compensateResult: CompensateResult = options.compensateResult ?? { error: null };
  const participantInsertResult: ParticipantInsertResult = options.participantInsertResult ?? {
    data: { id: "participant-1" },
    error: null,
  };

  // 消費チェーン: from("invites").update({used_at: iso}).eq("token", x)
  //   .is("used_at", null).gt("expires_at", now).select(...).maybeSingle()
  const consumeMaybeSingle = jest.fn().mockResolvedValue(consumeResult);
  const consumeSelect = jest.fn().mockReturnValue({ maybeSingle: consumeMaybeSingle });
  const consumeGt = jest.fn().mockReturnValue({ select: consumeSelect });
  const consumeIs = jest.fn().mockReturnValue({ gt: consumeGt });
  const consumeEq = jest.fn().mockReturnValue({ is: consumeIs });

  // 補償チェーン: from("invites").update({used_at: null}).eq("id", inviteId)
  // （終端。Supabaseのクエリビルダーはthenableなので直接resolveする）
  const compensateEq = jest.fn().mockResolvedValue(compensateResult);

  // update の呼び出しはペイロードで消費/補償を判別する
  // （実装は消費時に used_at: <iso文字列>、補償時に used_at: null を渡す）。
  const invitesUpdate = jest.fn((payload: { used_at: string | null }) => {
    if (payload.used_at === null) {
      return { eq: compensateEq };
    }
    return { eq: consumeEq };
  });

  // participants チェーン: from("participants").insert().select().single()
  const participantSingle = jest.fn().mockResolvedValue(participantInsertResult);
  const participantSelect = jest.fn().mockReturnValue({ single: participantSingle });
  const participantInsert = jest.fn().mockReturnValue({ select: participantSelect });

  const from = jest.fn((table: string) => {
    if (table === "invites") {
      return { update: invitesUpdate };
    }
    if (table === "participants") {
      return { insert: participantInsert };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    client: { from },
    from,
    invitesUpdate,
    consumeEq,
    consumeIs,
    consumeGt,
    consumeSelect,
    consumeMaybeSingle,
    compensateEq,
    participantInsert,
    participantSelect,
    participantSingle,
  };
}

function futureIso(daysFromNow = 1): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
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
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
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

      // 補償updateは呼ばれない（正常系のため）
      expect(mock.compensateEq).not.toHaveBeenCalled();
    });

    test("displayName未指定 → nullとしてinsertされる", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
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
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: [{ status: "active" }] },
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
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
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
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
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

    test("consumeのWHERE句が token一致・used_at is null・expires_at > now で構成される（単回消費化の検知ポイント）", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: { id: "participant-1" }, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const beforeCall = Date.now();
      const response = await POST(makeRequest(validBody({ inviteToken: "tok-abc" })));
      const afterCall = Date.now();

      expect(response.status).toBe(200);

      // update({used_at: <iso>}) が消費用ペイロードで呼ばれる
      const updatePayload = mock.invitesUpdate.mock.calls[0][0];
      expect(typeof updatePayload.used_at).toBe("string");
      const usedAtMs = new Date(updatePayload.used_at).getTime();
      expect(usedAtMs).toBeGreaterThanOrEqual(beforeCall);
      expect(usedAtMs).toBeLessThanOrEqual(afterCall);

      // WHERE句: eq("token", inviteToken)
      expect(mock.consumeEq).toHaveBeenCalledWith("token", "tok-abc");
      // WHERE句: is("used_at", null)
      expect(mock.consumeIs).toHaveBeenCalledWith("used_at", null);
      // WHERE句: gt("expires_at", <now以下のiso>)
      const gtArgs = mock.consumeGt.mock.calls[0];
      expect(gtArgs[0]).toBe("expires_at");
      expect(new Date(gtArgs[1] as string).getTime()).toBeGreaterThanOrEqual(beforeCall);
      expect(new Date(gtArgs[1] as string).getTime()).toBeLessThanOrEqual(afterCall);
    });
  });

  // -------------------------------------------------------------------------
  // 異常系: invite の有効性・単回消費化
  // -------------------------------------------------------------------------
  describe("異常系: 招待トークンの有効性・単回消費化", () => {
    test("consumeが0行ヒット（不存在・使用済み・期限切れのいずれか）→ 410＋一律エラー文言、participants insertされず、クッキーも設定されない", async () => {
      const mock = makeMockSupabaseClient({ consumeResult: { data: null, error: null } });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(410);
      const json = await response.json();
      expect(json.error).toContain("招待リンクは無効か、有効期限が切れています");
      expect(mock.participantInsert).not.toHaveBeenCalled();
      expect(response.cookies.get(GUEST_COOKIE_NAME)).toBeUndefined();
      expect(mockedSignGuestToken).not.toHaveBeenCalled();
      // 0行ヒットのため補償も不要（そもそも消費できていない）
      expect(mock.compensateEq).not.toHaveBeenCalled();
    });

    test("使用済みトークンで2回目のjoinを試みる（consumeが0行ヒット）→ 410で拒否される（単回消費化の主目的）", async () => {
      // 1回目で既に used_at が書き込まれているため、2回目の
      // update(...).eq("token",x).is("used_at",null)... は0行ヒットになる
      // （このテストのシナリオを模したモック: 2回目呼び出しなのでdata:null）。
      const mock = makeMockSupabaseClient({ consumeResult: { data: null, error: null } });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody({ inviteToken: "already-used-token" })));

      expect(response.status).toBe(410);
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });

    test("invite照合クエリがエラーを返す（DB障害）→ 5xx＋一律エラー文言（内部詳細は含まない）", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: { data: null, error: { message: "connection refused" } },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      const json = await response.json();
      expect(json.error).not.toContain("connection refused");
      expect(mock.participantInsert).not.toHaveBeenCalled();
    });

    test("consume成功だがルームがactiveでない（例: closed）→ 補償update（used_at:null）がinviteIdで呼ばれ、410＋一律エラー文言", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "closed" } },
          error: null,
        },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBe(410);
      const json = await response.json();
      expect(json.error).toContain("招待リンクは無効か、有効期限が切れています");
      expect(mock.participantInsert).not.toHaveBeenCalled();

      // 補償: update({used_at: null}).eq("id", "invite-1")
      const compensatePayloadCall = mock.invitesUpdate.mock.calls.find(
        (call) => call[0]?.used_at === null,
      );
      expect(compensatePayloadCall).toBeDefined();
      expect(mock.compensateEq).toHaveBeenCalledWith("id", "invite-1");
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
    test("insertがerrorを返す → 一律エラー、クッキー未設定、補償updateが呼ばれる", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
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

      // 補償: update({used_at: null}).eq("id", "invite-1")
      expect(mock.compensateEq).toHaveBeenCalledWith("id", "invite-1");
    });

    test("insertがdata:nullをerrorなしで返す → 一律エラー、クッキー未設定、補償updateが呼ばれる", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: null, error: null },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.cookies.get(GUEST_COOKIE_NAME)).toBeUndefined();
      expect(mock.compensateEq).toHaveBeenCalledWith("id", "invite-1");
    });

    test("補償update自体が失敗しても（ログのみで）一律エラー文言はそのまま返す", async () => {
      const mock = makeMockSupabaseClient({
        consumeResult: {
          data: { id: "invite-1", room_id: "room-1", room: { status: "active" } },
          error: null,
        },
        participantInsertResult: { data: null, error: { message: "unique violation" } },
        compensateResult: { error: { message: "compensation failed" } },
      });
      mockedGetSupabaseAdminClient.mockReturnValue(mock.client);

      const response = await POST(makeRequest(validBody()));

      expect(response.status).toBeGreaterThanOrEqual(500);
      const json = await response.json();
      expect(json.error).not.toContain("compensation failed");
      expect(json.error).not.toContain("unique violation");
    });
  });
});
