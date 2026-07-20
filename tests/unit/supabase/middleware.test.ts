/**
 * src/lib/supabase/middleware.ts の単体テスト（bd-two-device-translator-xev）。
 *
 * @supabase/ssr の createServerClient をモックし、実ネットワーク接続を
 * 一切行わない。env（URL / anon key）が正しく渡されること、
 * request/response 双方への cookie 同期配線が実装どおりであることを
 * `tests/unit/supabase/server.test.ts` と同じ粒度・流儀で検証する。
 *
 * middleware.test.ts（`src/middleware.ts`）では `createClient` を丸ごと
 * モックしているため、この `createClient` 自体の内部配線
 * （Edge セッション refresh の要である request/response cookie 同期）は
 * このファイルで検証する。
 *
 * `createClient` は env を呼び出し時に読むため（モジュールロード時ではない）、
 * `jest.resetModules()` は使わずトップレベル import のみで検証する
 * （resetModules すると `next/server` のモジュールレジストリも再生成され、
 * `NextResponse` へのスパイが createClient 側の実体に効かなくなるため）。
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/middleware";

const createServerClientMock = jest.fn();

jest.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

function buildRequest(url = "https://example.com/rooms"): NextRequest {
  return new NextRequest(new URL(url));
}

describe("lib/supabase/middleware: createClient", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    createServerClientMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-value";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("env に設定された URL / anon key で createServerClient を呼び出し、その戻り値を返す", () => {
    const fakeClient = { fake: true };
    createServerClientMock.mockReturnValue(fakeClient);

    const request = buildRequest();
    const { supabase } = createClient(request);

    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key-value",
      expect.objectContaining({
        cookies: expect.objectContaining({
          getAll: expect.any(Function),
          setAll: expect.any(Function),
        }),
      }),
    );
    expect(supabase).toBe(fakeClient);
  });

  it("getAll は request.cookies.getAll() に委譲する", () => {
    createServerClientMock.mockReturnValue({ fake: true });

    const request = buildRequest();
    request.cookies.set("existing", "1");
    createClient(request);

    const options = createServerClientMock.mock.calls[0][2];
    const result = options.cookies.getAll();

    expect(result).toEqual(request.cookies.getAll());
    expect(
      result.some((cookie: { name: string; value: string }) => cookie.name === "existing" && cookie.value === "1"),
    ).toBe(true);
  });

  it("setAll は request と response の両方の cookies.set に書き込む", () => {
    const originalNext = NextResponse.next.bind(NextResponse) as typeof NextResponse.next;
    const createdResponses: NextResponse[] = [];
    jest.spyOn(NextResponse, "next").mockImplementation((init?: Parameters<typeof NextResponse.next>[0]) => {
      const res = originalNext(init);
      createdResponses.push(res);
      return res;
    });

    createServerClientMock.mockReturnValue({ fake: true });

    const request = buildRequest();
    createClient(request);

    const options = createServerClientMock.mock.calls[0][2];
    options.cookies.setAll([
      { name: "sb-access-token", value: "refreshed-token", options: { path: "/" } },
      { name: "sb-refresh-token", value: "refreshed-refresh-token", options: { path: "/" } },
    ]);

    // request 側に反映される（次のミドルウェア処理やサーバーコンポーネントが
    // 同一リクエスト内で最新のcookieを参照できるようにするため）
    expect(request.cookies.get("sb-access-token")?.value).toBe("refreshed-token");
    expect(request.cookies.get("sb-refresh-token")?.value).toBe("refreshed-refresh-token");

    // response 側にも反映される（setAll呼び出しで再生成された最新のレスポンスが対象）
    const latestResponse = createdResponses[createdResponses.length - 1];
    expect(latestResponse.cookies.get("sb-access-token")?.value).toBe("refreshed-token");
    expect(latestResponse.cookies.get("sb-refresh-token")?.value).toBe("refreshed-refresh-token");
  });

  it("setAll 実行後にcreateClientが返すresponseは新しいNextResponseインスタンスに更新され、setAllで指定したcookieを保持する（Edgeセッションrefreshのresponse再生成漏れを検出）", () => {
    const originalNext = NextResponse.next.bind(NextResponse) as typeof NextResponse.next;
    const createdResponses: NextResponse[] = [];
    jest.spyOn(NextResponse, "next").mockImplementation((init?: Parameters<typeof NextResponse.next>[0]) => {
      const res = originalNext(init);
      createdResponses.push(res);
      return res;
    });

    createServerClientMock.mockImplementation(
      (
        _url: string,
        _key: string,
        options: {
          cookies: {
            setAll: (cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>) => void;
          };
        },
      ) => {
        // @supabase/ssr がセッションrefresh時にクライアント生成と同時にcookieを
        // ローテーションする状況を再現する（実運用で最も起こりやすいタイミング）。
        options.cookies.setAll([{ name: "sb-access-token", value: "refreshed-token", options: { path: "/" } }]);
        return { fake: true };
      },
    );

    const request = buildRequest();
    const { response } = createClient(request);

    // 初期生成分(1回目)とsetAll内での再生成分(2回目)で少なくとも2つの
    // NextResponseインスタンスが作られていること（同一インスタンスの使い回し・
    // ミューテートではなく、新規生成であることの確認）
    expect(createdResponses.length).toBeGreaterThanOrEqual(2);
    const initialResponse = createdResponses[0];
    const latestResponse = createdResponses[createdResponses.length - 1];
    expect(latestResponse).not.toBe(initialResponse);

    // createClientが最終的に返すresponseは、setAllによって再生成された
    // 最新のインスタンスであり、setAllで指定したcookieを保持している
    expect(response).toBe(latestResponse);
    expect(response.cookies.get("sb-access-token")?.value).toBe("refreshed-token");
  });
});
