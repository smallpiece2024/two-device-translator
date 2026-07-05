/**
 * server/db/supabaseAdmin.ts の単体テスト（bd-0jy）。
 *
 * 遅延初期化シングルトン（getSupabaseAdminClient/setSupabaseAdminClient/
 * resetSupabaseAdminClient）と、env未設定時のエラーを検証する。
 * 実 Supabase への通信は行わない。
 */
import {
  getSupabaseAdminClient,
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";

describe("supabaseAdmin", () => {
  let originalUrl: string | undefined;
  let originalServiceKey: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.SUPABASE_URL;
    originalServiceKey = process.env.SUPABASE_SERVICE_KEY;
  });

  afterEach(() => {
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
    resetSupabaseAdminClient();
  });

  test("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定のとき、getSupabaseAdminClient()は明確なエラーを投げる", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(() => getSupabaseAdminClient()).toThrow(
      /SUPABASE_URL.*SUPABASE_SERVICE_KEY/,
    );
  });

  test("SUPABASE_URL のみ未設定のときもエラーを投げる", () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = "service-key";

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("SUPABASE_SERVICE_KEY のみ未設定のときもエラーを投げる", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("setSupabaseAdminClient() で注入したクライアントが getSupabaseAdminClient() で返る", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;

    setSupabaseAdminClient(mockClient);

    expect(getSupabaseAdminClient()).toBe(mockClient);
  });

  test("getSupabaseAdminClient() を2回呼んでも同一インスタンスが返る（シングルトン）", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(mockClient);

    const first = getSupabaseAdminClient();
    const second = getSupabaseAdminClient();

    expect(first).toBe(second);
  });

  test("resetSupabaseAdminClient() 後は再度env未設定エラーになる（クライアントが破棄される）", () => {
    const mockClient = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(mockClient);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    resetSupabaseAdminClient();

    expect(() => getSupabaseAdminClient()).toThrow();
  });

  test("resetSupabaseAdminClient() 後、env設定済みなら新しいクライアントが生成される（差し替え確認）", () => {
    const firstMock = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(firstMock);

    resetSupabaseAdminClient();

    const secondMock = { auth: { getUser: jest.fn() }, from: jest.fn() } as never;
    setSupabaseAdminClient(secondMock);

    expect(getSupabaseAdminClient()).toBe(secondMock);
    expect(getSupabaseAdminClient()).not.toBe(firstMock);
  });
});
