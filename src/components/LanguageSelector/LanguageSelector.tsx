"use client";

/**
 * LanguageSelector: 自分が話す言語を選択する制御コンポーネント。
 *
 * `shared/languages/registry.ts` の `LANGUAGE_REGISTRY` / `SUPPORTED_LANGUAGES`
 * を用いて選択肢を描画する（Phase1 は ja-JP / en-US の2言語）。
 *
 * 値とonChangeをpropsで受ける制御コンポーネントとして自己完結させる。
 * RoomClient への結線（reducer 更新・WS送信等）は行わない（後続タスクの責務）。
 * 録音中は言語変更を許可しない想定のため `disabled` を用意している。
 */
import { LANGUAGE_REGISTRY, type SupportedLanguage } from "@shared/index";
import styles from "./LanguageSelector.module.css";

export interface LanguageSelectorProps {
  /** 現在選択されている言語コード */
  value: SupportedLanguage;
  /** 選択変更時に呼ばれるコールバック */
  onChange: (language: SupportedLanguage) => void;
  /** true の場合は選択不可にする（録音中等） */
  disabled?: boolean;
  /** `<label>` のテキスト。既定は「話す言語」 */
  label?: string;
  /** `<select>` の id（`htmlFor` と紐付ける用途）。既定は "language-selector" */
  id?: string;
}

/**
 * 話す言語を選択する `<select>` ベースのコンポーネント。
 */
export function LanguageSelector({
  value,
  onChange,
  disabled = false,
  label = "話す言語",
  id = "language-selector",
}: LanguageSelectorProps) {
  return (
    <div className={styles.languageSelector}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as SupportedLanguage)}
      >
        {LANGUAGE_REGISTRY.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  );
}
