/**
 * 半二重ゲート（bd-0ee: 音響フィードバックループ対策）。
 *
 * 対面利用では2台のデバイスが近接するため、自デバイスのTTS再生音を自分の
 * マイクが拾い、「相手の翻訳音声 → 自分の発話として認識 → 翻訳 → 相手側で
 * 再生 → …」という無限ループが発生しうる（本番実機で発生、2026-07-07）。
 *
 * 対策として、**自デバイスでTTSを再生している間（＋残響を考慮した猶予時間）は
 * マイク音声のWS送信を抑止する**（録音自体は継続し、audio チャンクの送信のみ
 * 落とす）。`audioPlaybackQueue` の再生状態変化通知を受けて状態を管理する
 * 純粋モジュール（テスト容易性のため RoomClient から分離）。
 *
 * @see docs/design/frontend-design.md（TTSと録音の半二重制約）
 */

/**
 * TTS再生終了後もマイク送信の抑止を維持する猶予時間（ms）。
 * スピーカー再生の残響・エコーが録音チャンクに残留するのを避ける。
 */
export const TTS_ECHO_GRACE_MS = 300;

export interface HalfDuplexGate {
  /** audioPlaybackQueue の再生状態変化を受け取る（true=再生開始 / false=停止） */
  onPlaybackStateChange(playing: boolean): void;
  /** 現在マイク音声の送信を抑止すべきか */
  shouldSuppressAudio(): boolean;
  /** タイマーを破棄し抑止状態を解除する（アンマウント時） */
  dispose(): void;
}

/**
 * 半二重ゲートを生成する。
 * @param graceMs 再生終了後の抑止猶予（既定 {@link TTS_ECHO_GRACE_MS}）
 */
export function createHalfDuplexGate(graceMs: number = TTS_ECHO_GRACE_MS): HalfDuplexGate {
  let suppressed = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGraceTimer = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  return {
    onPlaybackStateChange(playing: boolean): void {
      if (playing) {
        // 猶予中に次の再生が始まったら猶予を取り消して抑止を継続する。
        clearGraceTimer();
        suppressed = true;
        return;
      }
      // 再生停止 → 猶予時間の経過後に抑止を解除する。
      clearGraceTimer();
      graceTimer = setTimeout(() => {
        suppressed = false;
        graceTimer = null;
      }, graceMs);
    },

    shouldSuppressAudio(): boolean {
      return suppressed;
    },

    dispose(): void {
      clearGraceTimer();
      suppressed = false;
    },
  };
}
