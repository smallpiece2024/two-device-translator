"use client";

/**
 * ゲスト参加フォーム（`/join/[inviteToken]`）。
 *
 * 表示名（任意）・話す言語を入力し、`POST /api/guest/join` を呼び出す。
 * 成功すると Route Handler が発行した `gtt_guest` クッキーがブラウザに
 * 保存されるため、レスポンスの `roomId` を使って `/room/[roomId]` へ遷移する
 * （`docs/design/supabase-design.md#ゲストのクッキー識別との連携` 参照）。
 */
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SupportedLanguage } from "@shared/index";
import { LanguageSelector } from "@/components/LanguageSelector/LanguageSelector";
import styles from "./JoinInviteForm.module.css";

export interface JoinInviteFormProps {
  inviteToken: string;
}

const DEFAULT_LANGUAGE: SupportedLanguage = "ja-JP";

export function JoinInviteForm({ inviteToken }: JoinInviteFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState<SupportedLanguage>(DEFAULT_LANGUAGE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayNameId = useId();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/guest/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken,
          displayName: displayName.trim() || undefined,
          language,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "参加処理に失敗しました。時間をおいて再度お試しください。");
        return;
      }

      const body = (await response.json()) as { roomId: string };
      router.push(`/room/${body.roomId}`);
    } catch (unexpectedError) {
      console.error(
        "[JoinInviteForm] request failed",
        unexpectedError instanceof Error ? unexpectedError.message : unexpectedError
      );
      setError("通信エラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-label="ゲスト参加フォーム">
      <h1 className={styles.title}>ルームに参加</h1>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.field}>
        <label htmlFor={displayNameId} className={styles.label}>
          表示名（任意）
        </label>
        <input
          id={displayNameId}
          type="text"
          className={styles.input}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="表示名を入力（省略可）"
          maxLength={50}
          disabled={isSubmitting}
        />
      </div>

      <LanguageSelector value={language} onChange={setLanguage} disabled={isSubmitting} />

      <button type="submit" className={styles.submitButton} disabled={isSubmitting}>
        {isSubmitting ? "参加処理中..." : "参加する"}
      </button>
    </form>
  );
}
