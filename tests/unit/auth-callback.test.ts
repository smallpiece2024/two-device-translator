/**
 * `src/app/auth/callback/route.ts`（Supabase Auth コールバック）の単体テスト（bd-63d）。
 *
 * `@/lib/supabase/server` の `createClient` をモックし、実 Supabase・
 * ネットワーク接続を行わない。`NextRequest` を組み立てて `GET` を直接呼び出す。
 *
 * @see src/app/auth/callback/route.ts
 * @see src/lib/safeRedirect.ts
 */
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as safeRedirectModule from "@/lib/safeRedirect";
import { GET } from "@/app/auth/callback/route";

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}));

const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(exchangeResult: { error: { message: string } | null }) {
  const exchangeCodeForSession = jest.fn().mockResolvedValue(exchangeResult);
  createClientMock.mockResolvedValue({
    auth: {
      exchangeCodeForSession,
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { exchangeCodeForSession };
}

function makeRequest(path: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("codeパラメータがない場合は/login?error=oauth_failedへリダイレクトする", async () => {
    const { exchangeCodeForSession } = setupSupabaseMock({ error: null });

    const response = await GET(makeRequest("/auth/callback"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=oauth_failed");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchangeCodeForSessionが失敗した場合は/login?error=oauth_failedへリダイレクトする", async () => {
    setupSupabaseMock({ error: { message: "invalid code" } });

    const response = await GET(makeRequest("/auth/callback?code=abc123"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=oauth_failed");
  });

  it("成功時はredirectパラメータで指定された安全なパスへリダイレクトする", async () => {
    const { exchangeCodeForSession } = setupSupabaseMock({ error: null });

    const response = await GET(makeRequest("/auth/callback?code=abc123&redirect=%2Fhistory%2Fabc"));

    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/history/abc");
  });

  it("redirectパラメータがない場合は/roomsへリダイレクトする", async () => {
    setupSupabaseMock({ error: null });

    const response = await GET(makeRequest("/auth/callback?code=abc123"));

    expect(response.headers.get("location")).toBe("http://localhost:3000/rooms");
  });

  it("redirectパラメータが安全でない（プロトコル相対URL）場合は/roomsへフォールバックする", async () => {
    setupSupabaseMock({ error: null });

    const response = await GET(makeRequest("/auth/callback?code=abc123&redirect=%2F%2Fevil.com"));

    expect(response.headers.get("location")).toBe("http://localhost:3000/rooms");
  });

  describe("origin再検証による多層防御（コードレビュー起因の回帰テスト）", () => {
    // `resolveSafeRedirect` のホワイトリスト検証に万一バイパスがあった場合でも、
    // route.ts 側で「組み立てたURLのoriginが自サイトと一致するか」を再検証し、
    // 一致しなければ /rooms にフォールバックする（多層防御）。
    // ここでは resolveSafeRedirect 自体をモックし、外部ドメインへ正規化される
    // ような値（バイパスされたケースを模擬）を返させることで、route.ts側の
    // origin再検証が単独でも機能することを検証する。
    it("resolveSafeRedirectが（バイパス等により）外部ドメインへ正規化される値を返しても、origin不一致で/roomsへフォールバックする", async () => {
      const resolveSafeRedirectSpy = jest
        .spyOn(safeRedirectModule, "resolveSafeRedirect")
        .mockReturnValue("//evil.com");
      setupSupabaseMock({ error: null });

      const response = await GET(makeRequest("/auth/callback?code=abc123&redirect=anything"));

      expect(response.headers.get("location")).toBe("http://localhost:3000/rooms");

      resolveSafeRedirectSpy.mockRestore();
    });
  });
});
