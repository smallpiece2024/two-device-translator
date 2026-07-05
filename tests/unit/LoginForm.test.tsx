/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LoginForm } from "@/app/(public)/login/LoginForm";

/**
 * LoginForm（オーナー向けログイン/新規登録フォーム）の単体テスト（bd-63d）。
 *
 * `@/lib/supabase/client` の `createClient` と `next/navigation` の
 * `useRouter` をモックし、実 Supabase・ネットワーク接続を行わない。
 *
 * @see src/app/(public)/login/LoginForm.tsx
 * @see src/lib/safeRedirect.ts
 */
jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/lib/supabase/client", () => ({
  createClient: jest.fn(),
}));

const useRouterMock = useRouter as jest.MockedFunction<typeof useRouter>;
const createClientMock = createClient as jest.MockedFunction<typeof createClient>;

function setupSupabaseMock(overrides?: {
  signInWithPassword?: jest.Mock;
  signUp?: jest.Mock;
  signInWithOAuth?: jest.Mock;
}) {
  const signInWithPassword =
    overrides?.signInWithPassword ?? jest.fn().mockResolvedValue({ error: null });
  const signUp =
    overrides?.signUp ?? jest.fn().mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
  const signInWithOAuth = overrides?.signInWithOAuth ?? jest.fn().mockResolvedValue({ error: null });

  createClientMock.mockReturnValue({
    auth: {
      signInWithPassword,
      signUp,
      signInWithOAuth,
    },
  } as unknown as ReturnType<typeof createClient>);

  return { signInWithPassword, signUp, signInWithOAuth };
}

describe("LoginForm", () => {
  const pushMock = jest.fn();
  const refreshMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    useRouterMock.mockReturnValue({
      push: pushMock,
      refresh: refreshMock,
    } as unknown as ReturnType<typeof useRouter>);
  });

  describe("ログイン", () => {
    it("入力値で signInWithPassword が呼ばれ、成功時に /rooms へ遷移する（redirectTo未指定時）", async () => {
      const user = userEvent.setup();
      const { signInWithPassword } = setupSupabaseMock();
      render(<LoginForm />);

      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "taro@example.com",
        password: "password123",
      });
      expect(pushMock).toHaveBeenCalledWith("/rooms");
      expect(refreshMock).toHaveBeenCalled();
    });

    it("安全な redirectTo が指定されている場合はそのパスへ遷移する", async () => {
      const user = userEvent.setup();
      setupSupabaseMock();
      render(<LoginForm redirectTo="/history/abc" />);

      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(pushMock).toHaveBeenCalledWith("/history/abc");
    });

    it("安全でない redirectTo（プロトコル相対URL）の場合は /rooms へフォールバックする", async () => {
      const user = userEvent.setup();
      setupSupabaseMock();
      render(<LoginForm redirectTo="//evil.com" />);

      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(pushMock).toHaveBeenCalledWith("/rooms");
    });

    it("ログイン失敗時は role=alert で日本語エラーメッセージを表示し、遷移しない", async () => {
      const user = userEvent.setup();
      setupSupabaseMock({
        signInWithPassword: jest
          .fn()
          .mockResolvedValue({ error: { message: "Invalid login credentials" } }),
      });
      render(<LoginForm />);

      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "wrongpass");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "メールアドレスまたはパスワードが正しくありません。"
      );
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("メール・パスワード未入力の場合はバリデーションエラーを表示し、signInWithPasswordを呼ばない", async () => {
      const user = userEvent.setup();
      const { signInWithPassword } = setupSupabaseMock();
      render(<LoginForm />);

      // required 属性による標準検証を回避するため novalidate 相当のフォーム送信を
      // シミュレートせず、直接ボタンクリックで実装側のガード節を検証する。
      const form = screen.getByRole("form", { name: "ログインフォーム" });
      form.setAttribute("novalidate", "true");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "メールアドレスとパスワードを入力してください。"
      );
      expect(signInWithPassword).not.toHaveBeenCalled();
    });
  });

  describe("新規登録", () => {
    it("session が発行される場合は成功時と同様に遷移する", async () => {
      const user = userEvent.setup();
      const { signUp } = setupSupabaseMock({
        signUp: jest.fn().mockResolvedValue({ data: { session: { access_token: "t" } }, error: null }),
      });
      render(<LoginForm />);

      await user.click(screen.getByRole("tab", { name: "新規登録" }));
      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "登録する" }));

      expect(signUp).toHaveBeenCalledWith({
        email: "taro@example.com",
        password: "password123",
        options: {
          emailRedirectTo: "http://localhost/auth/callback?redirect=%2Frooms",
        },
      });
      expect(pushMock).toHaveBeenCalledWith("/rooms");
    });

    it("session がない場合は確認メール案内を role=status で表示し、遷移しない", async () => {
      const user = userEvent.setup();
      setupSupabaseMock({
        signUp: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      });
      render(<LoginForm />);

      await user.click(screen.getByRole("tab", { name: "新規登録" }));
      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "登録する" }));

      expect(await screen.findByRole("status")).toHaveTextContent(
        "確認メールを送信しました。メール内のリンクからログインを完了してください。"
      );
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("登録失敗時は role=alert で日本語エラーメッセージを表示する", async () => {
      const user = userEvent.setup();
      setupSupabaseMock({
        signUp: jest
          .fn()
          .mockResolvedValue({ data: { session: null }, error: { message: "User already registered" } }),
      });
      render(<LoginForm />);

      await user.click(screen.getByRole("tab", { name: "新規登録" }));
      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "登録する" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "このメールアドレスは既に登録されています。"
      );
    });
  });

  describe("Googleログイン", () => {
    it("signInWithOAuth が provider:google と /auth/callback へのredirectToで呼ばれる", async () => {
      const user = userEvent.setup();
      const { signInWithOAuth } = setupSupabaseMock();
      render(<LoginForm redirectTo="/history/abc" />);

      await user.click(screen.getByRole("button", { name: "Googleでログイン" }));

      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: "http://localhost/auth/callback?redirect=%2Fhistory%2Fabc",
        },
      });
    });

    it("安全でないredirectToの場合、コールバックURLのredirectパラメータは/roomsになる", async () => {
      const user = userEvent.setup();
      const { signInWithOAuth } = setupSupabaseMock();
      render(<LoginForm redirectTo="https://evil.com" />);

      await user.click(screen.getByRole("button", { name: "Googleでログイン" }));

      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: "http://localhost/auth/callback?redirect=%2Frooms",
        },
      });
    });

    it("Google OAuth開始に失敗した場合はエラーを表示する", async () => {
      const user = userEvent.setup();
      setupSupabaseMock({
        signInWithOAuth: jest.fn().mockResolvedValue({ error: { message: "oauth error" } }),
      });
      render(<LoginForm />);

      await user.click(screen.getByRole("button", { name: "Googleでログイン" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Googleログインの開始に失敗しました。もう一度お試しください。"
      );
    });
  });

  describe("送信中の二重送信防止", () => {
    it("送信中はログイン/登録ボタンとGoogleボタンがdisabledになる", async () => {
      const user = userEvent.setup();
      let resolveSignIn: (value: { error: null }) => void = () => {};
      const pending = new Promise<{ error: null }>((resolve) => {
        resolveSignIn = resolve;
      });
      setupSupabaseMock({
        signInWithPassword: jest.fn().mockReturnValue(pending),
      });
      render(<LoginForm />);

      await user.type(screen.getByLabelText("メールアドレス"), "taro@example.com");
      await user.type(screen.getByLabelText("パスワード"), "password123");
      await user.click(screen.getByRole("button", { name: "ログイン" }));

      expect(screen.getByRole("button", { name: "ログイン" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Googleでログイン" })).toBeDisabled();

      resolveSignIn({ error: null });
      await screen.findByRole("button", { name: "ログイン" });
    });
  });

  describe("initialError", () => {
    it("initialError=oauth_failed の場合、初期表示でエラーメッセージを表示する", () => {
      setupSupabaseMock();
      render(<LoginForm initialError="oauth_failed" />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Googleログインに失敗しました。もう一度お試しください。"
      );
    });

    it("未知のinitialErrorコードの場合、汎用エラーメッセージを表示する", () => {
      setupSupabaseMock();
      render(<LoginForm initialError="unknown_code" />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "ログインに失敗しました。もう一度お試しください。"
      );
    });
  });
});
