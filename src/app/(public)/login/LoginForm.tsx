"use client";

/**
 * オーナー向けログイン/新規登録フォーム（Supabase Auth）。
 *
 * メール+パスワードのログイン・新規登録と、Google OAuth ログインに対応する。
 * 成功後は `redirectTo`（`/login?redirect=...` 由来）が安全なパスであれば
 * そちらへ、そうでなければ `/rooms` へ遷移する（`resolveSafeRedirect` 参照）。
 *
 * @see docs/design/frontend-design.md#login
 * @see docs/design/security-design.md
 */
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveSafeRedirect } from "@/lib/safeRedirect";
import styles from "./LoginForm.module.css";

export interface LoginFormProps {
  /** ログイン/登録成功後の遷移先候補（未検証。内部で `resolveSafeRedirect` により検証する）。 */
  redirectTo?: string;
  /** `/auth/callback` からのリダイレクトで渡されるエラーコード（`?error=` クエリ由来）。 */
  initialError?: string;
}

type AuthMode = "signin" | "signup";

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "Googleログインに失敗しました。もう一度お試しください。",
};

/**
 * Supabase Auth の代表的なエラーメッセージを日本語化する。
 * 未知のメッセージはそのまま表示する（原因追跡のため隠さない）。
 */
function toJapaneseErrorMessage(message: string): string {
  if (message.includes("Invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }
  if (message.includes("User already registered")) {
    return "このメールアドレスは既に登録されています。";
  }
  if (message.includes("Password should be at least")) {
    return "パスワードは6文字以上で入力してください。";
  }
  return message;
}

export function LoginForm({ redirectTo, initialError }: LoginFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    initialError
      ? (CALLBACK_ERROR_MESSAGES[initialError] ?? "ログインに失敗しました。もう一度お試しください。")
      : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();

  const handleModeChange = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setNotice(null);
  };

  const buildCallbackUrl = () => {
    const callbackUrl = new URL("/auth/callback", window.location.origin);
    callbackUrl.searchParams.set("redirect", resolveSafeRedirect(redirectTo));
    return callbackUrl.toString();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("メールアドレスとパスワードを入力してください。");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();

    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });

        if (signInError) {
          setError(toJapaneseErrorMessage(signInError.message));
          return;
        }

        router.push(resolveSafeRedirect(redirectTo));
        router.refresh();
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          emailRedirectTo: buildCallbackUrl(),
        },
      });

      if (signUpError) {
        setError(toJapaneseErrorMessage(signUpError.message));
        return;
      }

      if (!data.session) {
        // メール確認が有効な環境ではサインアップ直後にセッションが発行されない。
        setNotice("確認メールを送信しました。メール内のリンクからログインを完了してください。");
        return;
      }

      router.push(resolveSafeRedirect(redirectTo));
      router.refresh();
    } catch (unexpectedError) {
      // パスワードやトークンを含まない一般的なメッセージのみログに残す。
      console.error(
        "[LoginForm] authentication request failed",
        unexpectedError instanceof Error ? unexpectedError.message : unexpectedError
      );
      setError("通信エラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildCallbackUrl(),
      },
    });

    if (oauthError) {
      console.error("[LoginForm] Google OAuth request failed", oauthError.message);
      setError("Googleログインの開始に失敗しました。もう一度お試しください。");
      setIsSubmitting(false);
    }
    // 成功時はブラウザがGoogleの認証画面へ遷移するため、ここでの状態更新は不要。
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-label="ログインフォーム">
      <h1 className={styles.title}>ログイン</h1>

      <div className={styles.tabs} role="tablist" aria-label="ログイン方法の切り替え">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signin"}
          className={mode === "signin" ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => handleModeChange("signin")}
        >
          ログイン
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signup"}
          className={mode === "signup" ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => handleModeChange("signup")}
        >
          新規登録
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      <div className={styles.field}>
        <label htmlFor={emailId} className={styles.label}>
          メールアドレス
        </label>
        <input
          id={emailId}
          type="email"
          className={styles.input}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          disabled={isSubmitting}
          required
        />
      </div>

      <div className={styles.field}>
        <label htmlFor={passwordId} className={styles.label}>
          パスワード
        </label>
        <input
          id={passwordId}
          type="password"
          className={styles.input}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={6}
          disabled={isSubmitting}
          required
        />
      </div>

      <button type="submit" className={styles.submitButton} disabled={isSubmitting}>
        {mode === "signin" ? "ログイン" : "登録する"}
      </button>

      <div className={styles.divider}>
        <span className={styles.dividerLine} />
        <span>または</span>
        <span className={styles.dividerLine} />
      </div>

      <button
        type="button"
        className={styles.googleButton}
        onClick={handleGoogleLogin}
        disabled={isSubmitting}
      >
        Googleでログイン
      </button>
    </form>
  );
}
