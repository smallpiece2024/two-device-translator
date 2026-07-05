"use client";

/**
 * ルーム参加フォーム（Phase1 簡易版 + ゲストクッキー連携）。
 *
 * URL直打ちでルームに入ってきたユーザーが、表示名（任意）・話す言語・
 * role（owner/guest、2台での動作確認用の簡易選択）を指定して参加するための
 * フォーム。送信すると `RoomClient` をマウントし、WS接続・`join` 送信を開始する。
 *
 * `guestToken`（`/api/guest/join` 経由で発行された `gtt_guest` クッキー）が
 * 存在する場合は、そのユーザーは既にゲストとして参加確定済みであるため、
 * 「役割」セレクトを表示せず role を強制的に `"guest"` に固定する。
 * このセレクトで誤って `"owner"` を選んでしまうと、ゲスト用トークンで
 * オーナーとして join しようとして認証に失敗し行き詰まる穴があったため
 * （コードレビュー指摘事項）。表示名・言語の入力欄は引き続き残す。
 *
 * 認証は Phase1 ダミーのまま（`guestToken` が無い場合は `RoomClient` 内の
 * 仮トークン発行にフォールバックする）。
 * ルームはサーバー側で初回join時に自動作成される（`server/room/roomManager.ts`）。
 */
import { useId, useState, type FormEvent } from "react";
import type { SupportedLanguage } from "@shared/index";
import { LanguageSelector } from "@/components/LanguageSelector/LanguageSelector";
import { RoomClient } from "./RoomClient";
import styles from "./JoinForm.module.css";

export interface JoinFormProps {
  roomId: string;
  wsUrl: string;
  /** `gtt_guest` クッキーがあれば渡される（`RoomClient` へそのまま中継する）。 */
  guestToken?: string;
}

type RoomRole = "owner" | "guest";

interface JoinConfig {
  displayName: string;
  language: SupportedLanguage;
  role: RoomRole;
}

const DEFAULT_LANGUAGE: SupportedLanguage = "ja-JP";

export function JoinForm({ roomId, wsUrl, guestToken }: JoinFormProps) {
  const [config, setConfig] = useState<JoinConfig | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState<SupportedLanguage>(DEFAULT_LANGUAGE);
  const [role, setRole] = useState<RoomRole>("guest");
  const displayNameId = useId();
  const roleId = useId();

  if (config) {
    return (
      <RoomClient
        roomId={roomId}
        wsUrl={wsUrl}
        role={config.role}
        displayName={config.displayName || undefined}
        language={config.language}
        guestToken={guestToken}
      />
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // `guestToken` がある場合はUI上の選択肢を隠しているが、state改ざん等の
    // 不測の経路を考慮し、送信時にも役割を "guest" に強制する多層防御。
    setConfig({ displayName: displayName.trim(), language, role: guestToken ? "guest" : role });
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-label="ルーム参加フォーム">
      <h1 className={styles.title}>ルーム「{roomId}」に参加</h1>

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
        />
      </div>

      <LanguageSelector value={language} onChange={setLanguage} />

      {!guestToken && (
        <div className={styles.field}>
          <label htmlFor={roleId} className={styles.label}>
            役割
          </label>
          <select
            id={roleId}
            className={styles.select}
            value={role}
            onChange={(event) => setRole(event.target.value as RoomRole)}
          >
            <option value="owner">オーナー</option>
            <option value="guest">ゲスト</option>
          </select>
        </div>
      )}

      <button type="submit" className={styles.submitButton}>
        参加する
      </button>
    </form>
  );
}
