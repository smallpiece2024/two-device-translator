/**
 * src/lib/supabase/server.ts の単体テスト。
 *
 * @supabase/ssr の createServerClient と next/headers の cookies() を
 * モックし、実ネットワーク接続を一切行わない。
 * env（anon key）が正しく渡されること、cookie の getAll/setAll 配線が
 * 実装どおりであることを検証する。
 */

const createServerClientMock = jest.fn();
const cookiesMock = jest.fn();

jest.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

jest.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => cookiesMock(...args),
}));

describe("lib/supabase/server: createClient", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    createServerClientMock.mockReset();
    cookiesMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-value";
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("env に設定された URL / anon key で createServerClient を呼び出し、その戻り値を返す", async () => {
    const cookieStore = { getAll: jest.fn(), set: jest.fn() };
    cookiesMock.mockResolvedValue(cookieStore);
    const fakeClient = { fake: true };
    createServerClientMock.mockReturnValue(fakeClient);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/server");
    const client = await createClient();

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
    expect(client).toBe(fakeClient);
  });

  it("getAll は cookieStore.getAll() に委譲する", async () => {
    const cookieStore = {
      getAll: jest.fn().mockReturnValue([{ name: "a", value: "1" }]),
      set: jest.fn(),
    };
    cookiesMock.mockResolvedValue(cookieStore);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/server");
    await createClient();

    const options = createServerClientMock.mock.calls[0][2];
    const result = options.cookies.getAll();

    expect(cookieStore.getAll).toHaveBeenCalled();
    expect(result).toEqual([{ name: "a", value: "1" }]);
  });

  it("setAll は cookieStore.set を各cookieに対して呼び出す", async () => {
    const cookieStore = { getAll: jest.fn(), set: jest.fn() };
    cookiesMock.mockResolvedValue(cookieStore);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/server");
    await createClient();

    const options = createServerClientMock.mock.calls[0][2];
    options.cookies.setAll([
      { name: "a", value: "1", options: {} },
      { name: "b", value: "2", options: {} },
    ]);

    expect(cookieStore.set).toHaveBeenCalledTimes(2);
    expect(cookieStore.set).toHaveBeenCalledWith("a", "1", {});
    expect(cookieStore.set).toHaveBeenCalledWith("b", "2", {});
  });

  it("setAll は cookieStore.set が例外を投げても握りつぶす（Server Componentからの呼び出し対応）", async () => {
    const cookieStore = {
      getAll: jest.fn(),
      set: jest.fn(() => {
        throw new Error("cannot set cookie from Server Component");
      }),
    };
    cookiesMock.mockResolvedValue(cookieStore);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require("../../../src/lib/supabase/server");
    await createClient();

    const options = createServerClientMock.mock.calls[0][2];

    expect(() =>
      options.cookies.setAll([{ name: "a", value: "1", options: {} }]),
    ).not.toThrow();
  });
});
