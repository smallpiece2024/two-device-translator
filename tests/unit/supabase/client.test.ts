/**
 * src/lib/supabase/client.ts の単体テスト。
 *
 * @supabase/ssr の createBrowserClient をモックし、実ネットワーク接続を
 * 一切行わない。env（anon key）が正しく渡されることのみを検証する。
 */

const createBrowserClientMock = jest.fn();

jest.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => createBrowserClientMock(...args),
}));

describe("lib/supabase/client: createClient", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    createBrowserClientMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("env に設定された URL / anon key で createBrowserClient を呼び出し、その戻り値を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-value";
    const fakeClient = { fake: true };
    createBrowserClientMock.mockReturnValue(fakeClient);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/client");
    const client = createClient();

    expect(createBrowserClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key-value",
    );
    expect(client).toBe(fakeClient);
  });

  it("service_role key 等のサーバー専用環境変数を一切参照しない（anon keyのみ使用）", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-value";
    process.env.SUPABASE_SERVICE_KEY = "should-not-be-used";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/client");
    createClient();

    const calledArgs = createBrowserClientMock.mock.calls[0];
    expect(calledArgs).not.toContain("should-not-be-used");
  });
});
