/**
 * resolveInviteBaseUrl（招待URLのベースURL解決）の単体テスト。
 *
 * `APP_BASE_URL` が設定されていれば最優先で使用し、末尾スラッシュを除去する。
 * 未設定の場合のみ `next/headers` の host / x-forwarded-proto ヘッダから
 * 組み立て、モジュール読み込み後最初の1回だけ `console.warn` を出す
 * （モジュール内の `hasWarnedFallback` は module-level state のため、
 * `jest.resetModules()` で毎テストごとにリセットしてから動的 `require` する）。
 */

const headersMock = jest.fn();

jest.mock("next/headers", () => ({
  headers: (...args: unknown[]) => headersMock(...args),
}));

describe("resolveInviteBaseUrl", () => {
  const ORIGINAL_ENV = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    headersMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("APP_BASE_URL設定時はそれを使用し、ヘッダは参照しない", async () => {
    process.env.APP_BASE_URL = "https://app.example.com";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveInviteBaseUrl } = require("../../src/app/(owner)/rooms/[roomId]/invite/resolveInviteBaseUrl");
    const result = await resolveInviteBaseUrl();

    expect(result).toBe("https://app.example.com");
    expect(headersMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("APP_BASE_URLの末尾スラッシュを除去する", async () => {
    process.env.APP_BASE_URL = "https://app.example.com///";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveInviteBaseUrl } = require("../../src/app/(owner)/rooms/[roomId]/invite/resolveInviteBaseUrl");
    const result = await resolveInviteBaseUrl();

    expect(result).toBe("https://app.example.com");
  });

  it("APP_BASE_URL未設定時はヘッダから組み立て、console.warnを出す", async () => {
    delete process.env.APP_BASE_URL;
    headersMock.mockResolvedValue({
      get: (key: string) => {
        if (key === "host") return "guest.example.com";
        if (key === "x-forwarded-proto") return "https";
        return null;
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveInviteBaseUrl } = require("../../src/app/(owner)/rooms/[roomId]/invite/resolveInviteBaseUrl");
    const result = await resolveInviteBaseUrl();

    expect(result).toBe("https://guest.example.com");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("ヘッダ未設定時はデフォルト値(localhost:3000, http)にフォールバックする", async () => {
    delete process.env.APP_BASE_URL;
    headersMock.mockResolvedValue({
      get: () => null,
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveInviteBaseUrl } = require("../../src/app/(owner)/rooms/[roomId]/invite/resolveInviteBaseUrl");
    const result = await resolveInviteBaseUrl();

    expect(result).toBe("http://localhost:3000");
  });

  it("フォールバックのconsole.warnはモジュール読み込み後最初の1回だけ発生する", async () => {
    delete process.env.APP_BASE_URL;
    headersMock.mockResolvedValue({
      get: (key: string) => (key === "host" ? "a.example.com" : null),
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveInviteBaseUrl } = require("../../src/app/(owner)/rooms/[roomId]/invite/resolveInviteBaseUrl");
    await resolveInviteBaseUrl();
    await resolveInviteBaseUrl();
    await resolveInviteBaseUrl();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
