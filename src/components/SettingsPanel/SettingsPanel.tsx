"use client";

/**
 * SettingsPanel: 表示名・話す言語・言語検出モード・TTSトグルをまとめた設定パネル。
 *
 * `docs/design/frontend-design.md`（SettingsPanel節）の Phase2 スコープ
 * （表示名・言語・言語検出トグル・TTS）を対象とする。しきい値設定（chunkMs等、
 * owner向け）は本タスクのスコープ外。
 *
 * 既存の `LanguageSelector` / `TTSToggle` をそのまま内包し、アクセシブルな
 * ロール・ラベル（`combobox`「話す言語」/ `switch`「読み上げ(TTS)」）を維持する
 * （既存テスト・利用側との互換性のため）。
 *
 * 値とコールバックをpropsで受ける制御コンポーネントとして自己完結させる。
 * RoomClient への WS 送信・reducer 更新は行わない（呼び出し側の責務）。
 */
import { useEffect, useState } from "react";
import type { SupportedLanguage } from "@shared/index";
import { LanguageSelector } from "@/components/LanguageSelector/LanguageSelector";
import { TTSToggle } from "@/components/TTSToggle/TTSToggle";
import styles from "./SettingsPanel.module.css";

export interface SettingsPanelProps {
  /** 現在の表示名（未設定の場合は空文字扱い） */
  displayName?: string;
  /** 表示名の変更が確定した時（blur/Enter）に呼ばれるコールバック */
  onDisplayNameChange: (displayName: string) => void;
  /** 現在選択されている自分の話す言語 */
  language: SupportedLanguage;
  /** 言語選択の変更コールバック */
  onLanguageChange: (language: SupportedLanguage) => void;
  /** true の場合、言語選択のみを無効化する（録音中等） */
  languageDisabled?: boolean;
  /** 言語検出モードのON/OFF（次回の録音開始時から有効） */
  detectLanguage: boolean;
  /** 言語検出モードの変更コールバック */
  onDetectLanguageChange: (detectLanguage: boolean) => void;
  /** 自分が聞き手としてTTSを受け取るか */
  ttsEnabled: boolean;
  /** TTSトグルの変更コールバック */
  onTtsChange: (enabled: boolean) => void;
  /** true の場合、パネル全体を操作不可にする（ルーム終了時等） */
  disabled?: boolean;
}

const MAX_DISPLAY_NAME_LENGTH = 50;

/**
 * 表示名・話す言語・言語検出モード・TTSをまとめた設定パネル。
 */
export function SettingsPanel({
  displayName,
  onDisplayNameChange,
  language,
  onLanguageChange,
  languageDisabled = false,
  detectLanguage,
  onDetectLanguageChange,
  ttsEnabled,
  onTtsChange,
  disabled = false,
}: SettingsPanelProps) {
  // 表示名は「確定（blur/Enter）」で親へ通知する方式のため、入力中の値は
  // ローカルstateで保持する。外部から displayName が変わった場合（他デバイス
  // からの反映等は現状無いが、再接続復帰時の初期値変更に備える）は同期する。
  const [nameInput, setNameInput] = useState(displayName ?? "");

  useEffect(() => {
    setNameInput(displayName ?? "");
  }, [displayName]);

  const commitDisplayName = () => {
    const trimmed = nameInput.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
    setNameInput(trimmed);
    if (trimmed !== (displayName ?? "")) {
      onDisplayNameChange(trimmed);
    }
  };

  return (
    <div className={styles.settingsPanel}>
      <div className={styles.field}>
        <label htmlFor="settings-display-name" className={styles.label}>
          表示名
        </label>
        <input
          id="settings-display-name"
          type="text"
          className={styles.textInput}
          value={nameInput}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          disabled={disabled}
          onChange={(event) => setNameInput(event.target.value)}
          onBlur={commitDisplayName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDisplayName();
            }
          }}
        />
      </div>

      <LanguageSelector
        value={language}
        onChange={onLanguageChange}
        disabled={disabled || languageDisabled}
      />

      <div className={styles.field}>
        <label className={styles.detectToggleLabel}>
          <input
            type="checkbox"
            checked={detectLanguage}
            disabled={disabled}
            onChange={(event) => onDetectLanguageChange(event.target.checked)}
            aria-describedby="settings-detect-language-hint"
          />
          言語検出モード
        </label>
        <p id="settings-detect-language-hint" className={styles.hint}>
          次回の録音開始時から話している言語を自動判定します。判定後は自動でOFFに戻ります。
        </p>
      </div>

      <TTSToggle enabled={ttsEnabled} onChange={onTtsChange} disabled={disabled} />
    </div>
  );
}
