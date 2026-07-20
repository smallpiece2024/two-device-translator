/**
 * `src/middleware.ts` の単体テスト（bd-two-device-translator-xev）。
 *
 * `(owner)` ルートグループ（`/rooms/:path*`, `/history/:path*`）の
 * セッション検証・リダイレクト・matcher 設定を検証する。
 *
 * `@/lib/supabase/middleware` の `createClient` をモックし、
 * `supabase.auth.getUser()` の戻り値/例外を制御することで
 * 未ログイン・ログイン済み・getUser例外の3パターンを検証する。
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/middleware";
import { middleware, config } from "@/middleware";

jest.mock("@/lib/supabase/middleware", () => ({
  createClient: jest.fn(),
}));

const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(options: { user: { id: string } | null; throwError?: unknown }) {
  const passThroughResponse = NextResponse.next();
  const getUser = options.throwError
    ? jest.fn().mockRejectedValue(options.throwError)
    : jest.fn().mockResolvedValue({ data: { user: options.user } });

  createClientMock.mockReturnValue({
    supabase: {
      auth: { getUser },
    },
    response: passThroughResponse,
  } as unknown as ReturnType<typeof createClient>);

  return { passThroughResponse, getUser };
}

describe("middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("未ログイン(user:null)で/roomsにアクセスすると/loginへ307リダイレクトし、redirectパラメータにpathnameが入る", async () => {
    setupSupabaseMock({ user: null });
    const request = new NextRequest(new URL("https://example.com/rooms"));

    const response = await middleware(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const locationUrl = new URL(location!);
    expect(locationUrl.pathname).toBe("/login");
    expect(locationUrl.searchParams.get("redirect")).toBe("/rooms");
  });

  it("未ログインで/history/abc?x=1にアクセスするとredirectパラメータにpathname+searchが入る", async () => {
    setupSupabaseMock({ user: null });
    const request = new NextRequest(new URL("https://example.com/history/abc?x=1"));

    const response = await middleware(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    const locationUrl = new URL(location!);
    expect(locationUrl.pathname).toBe("/login");
    expect(locationUrl.searchParams.get("redirect")).toBe("/history/abc?x=1");
  });

  it("getUserが例外を投げた場合は未ログイン扱いで/loginへリダイレクトする(fail-closed)", async () => {
    setupSupabaseMock({ user: null, throwError: new Error("network error") });
    const request = new NextRequest(new URL("https://example.com/rooms"));

    const response = await middleware(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    const locationUrl = new URL(location!);
    expect(locationUrl.pathname).toBe("/login");
    // エラーを握りつぶさずログに残すこと（nextjs-edge-runtimeルール）
    expect(console.error).toHaveBeenCalled();
  });

  it("ログイン済み(userあり)で/roomsにアクセスした場合はリダイレクトしない", async () => {
    const { passThroughResponse } = setupSupabaseMock({ user: { id: "user-1" } });
    const request = new NextRequest(new URL("https://example.com/rooms"));

    const response = await middleware(request);

    expect(response.headers.get("location")).toBeNull();
    expect(response).toBe(passThroughResponse);
  });

  it(
    "redirectパラメータの形状検証: Location自体のoriginはリクエストと同一であり、" +
      "redirectパラメータは`/`始まりのパスである（通常経路）。" +
      "redirect値を消費する側（/loginでのリダイレクト実行）の再検証は/login実装タスク(bd-63d)に持ち越し",
    async () => {
      setupSupabaseMock({ user: null });
      const request = new NextRequest(new URL("https://example.com/history/abc?x=1"));

      const response = await middleware(request);

      const location = response.headers.get("location");
      const locationUrl = new URL(location!);
      expect(locationUrl.origin).toBe("https://example.com");
      const redirectParam = locationUrl.searchParams.get("redirect");
      expect(redirectParam).not.toBeNull();
      expect(redirectParam!.startsWith("/")).toBe(true);
      expect(redirectParam!.startsWith("//")).toBe(false);
    },
  );

  it(
    "redirectパラメータの形状検証(能動検証): pathnameが`//evil.com`のようなプロトコル相対風の値でも、" +
      "middleware自身が生成するLocationのoriginは常にリクエストのoriginのまま変わらない。" +
      "redirectパラメータの値自体はpathnameをそのまま転記するため`//evil.com`のような値が入り得ることを" +
      "現状の実装として記録する（redirect値をクライアント側で消費する際のオープンリダイレクト対策は" +
      "/login実装タスク(bd-63d)側で別途検証する）",
    async () => {
      setupSupabaseMock({ user: null });
      // URLパーサはオリジン直後の`//`をpathnameの一部として保持する
      // （プロトコル相対URLへの誘導を模したpathname）
      const request = new NextRequest(new URL("https://example.com//evil.com"));
      expect(request.nextUrl.pathname).toBe("//evil.com");

      const response = await middleware(request);

      const location = response.headers.get("location");
      const locationUrl = new URL(location!);
      // Locationのoriginはリクエストのoriginと同一のまま
      // （middleware自体がオープンリダイレクトを起こすことはない）
      expect(locationUrl.origin).toBe("https://example.com");
      expect(locationUrl.pathname).toBe("/login");
      // redirectパラメータの値はpathnameをそのまま転記するだけの現状仕様
      expect(locationUrl.searchParams.get("redirect")).toBe("//evil.com");
    },
  );

  it("matcher設定が/rooms/:path*と/history/:path*のみであること（回帰ガード）", () => {
    expect(config.matcher).toEqual(["/rooms/:path*", "/history/:path*"]);
  });
});
