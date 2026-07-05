"use client";

/**
 * TTSToggle: 自分が聞き手としてTTS（音声読み上げ）を受け取るかどうかのON/OFFトグル。
 *
 * 値とonChangeをpropsで受ける制御コンポーネントとして自己完結させる。
 * RoomClient への結線（reducer 更新・WS `start.enableTts` への反映等）は
 * 行わない（後続タスクの責務）。
 *
 * アクセシビリティ: `role="switch"` + `aria-checked` でスイッチとして扱う。
 */
import { useId } from "react";
import styles from "./TTSToggle.module.css";

export interface TTSToggleProps {
  /** 現在の有効/無効状態 */
  enabled: boolean;
  /** 切り替え時に呼ばれるコールバック */
  onChange: (enabled: boolean) => void;
  /** true の場合は操作不可にする */
  disabled?: boolean;
  /** ラベルテキスト。既定は「読み上げ(TTS)」 */
  label?: string;
}

/**
 * TTS ON/OFF を切り替えるスイッチコンポーネント。
 */
export function TTSToggle({
  enabled,
  onChange,
  disabled = false,
  label = "読み上げ(TTS)",
}: TTSToggleProps) {
  const labelId = useId();

  const handleClick = () => {
    if (disabled) return;
    onChange(!enabled);
  };

  return (
    <div className={styles.ttsToggle}>
      <span className={styles.label} id={labelId}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={handleClick}
        className={`${styles.switch} ${enabled ? styles.switchOn : ""}`}
      >
        <span className={styles.thumb} aria-hidden="true" />
      </button>
    </div>
  );
}
