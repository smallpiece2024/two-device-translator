"use client";

/**
 * 「このタブを閉じる」ボタン（bd: ルームから開いたQRタブの二重入室対策）。
 *
 * ルーム画面の「招待QRを表示」は新しいタブで開く（元タブのWS接続を維持する
 * ため）。このタブに「入室する」導線があると、同一 participantId の再joinで
 * 元タブのWSが切断され二重ウィンドウ状態になるため、`?from=room` で開かれた
 * 場合は入室リンクの代わりに本ボタンを表示する。
 *
 * `window.close()` はスクリプト（`target="_blank"` リンク含む）で開かれ、
 * 履歴が1件のタブでは動作するが、ブラウザ設定によっては拒否されるため、
 * 閉じられなかった場合は手動で閉じるよう促すヒントを表示する。
 */
import { useState } from "react";
import styles from "./CloseTabButton.module.css";

/** window.close() 後にタブが閉じたかを確認するまでの待ち時間（ms）。 */
const CLOSE_CHECK_DELAY_MS = 300;

export function CloseTabButton() {
  const [showHint, setShowHint] = useState(false);

  const handleClick = () => {
    window.close();
    // 閉じられた場合このコードは実行されない（またはタブごと破棄される）。
    // 実行が続き window.closed が false のままなら、ブラウザに拒否されている。
    setTimeout(() => {
      if (!window.closed) {
        setShowHint(true);
      }
    }, CLOSE_CHECK_DELAY_MS);
  };

  return (
    <div className={styles.wrapper}>
      <button type="button" onClick={handleClick} className={styles.closeButton}>
        このタブを閉じる
      </button>
      {showHint && (
        <p className={styles.hint} role="status">
          タブを自動で閉じられませんでした。お手数ですが手動で閉じてください。
        </p>
      )}
    </div>
  );
}
