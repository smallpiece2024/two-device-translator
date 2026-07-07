/**
 * 半二重ゲート（bd-0ee / bd-rwi: 音響フィードバックループ対策）。
 *
 * 対面利用では2台のデバイスが近接するため、TTS再生音がマイクに拾われて
 * 「翻訳音声 → 発話として誤認識 → 翻訳 → 再生 → …」の無限ループが発生しうる
 * （本番実機で発生、2026-07-07）。拾われる経路は2つある:
 *
 * 1. **自デバイス**のスピーカー音を自分のマイクが拾う（bd-0ee）
 * 2. **相手デバイス**のスピーカー音を自分のマイクが拾う（bd-rwi。
 *    相手の再生状態は WS の `peer_playback_state` 中継で知る）
 *
 * 対策として、**自分または同室の誰かがTTSを再生している間（＋残響を考慮した
 * 猶予時間）はマイク音声のWS送信を抑止する**（録音自体は継続し、audio チャンクの
 * 送信のみ落とす）。テスト容易性のため RoomClient から分離した純粋モジュール。
 *
 * @see docs/design/frontend-design.md（TTSと録音の半二重制約）
 * @see docs/design/websocket-protocol.md（playback_state / peer_playback_state）
 */

/**
 * TTS再生終了後もマイク送信の抑止を維持する猶予時間（ms）。
 * スピーカー再生の残響・エコーが録音チャンクに残留するのを避ける。
 */
export const TTS_ECHO_GRACE_MS = 300;

export interface HalfDuplexGate {
  /** 自デバイスの audioPlaybackQueue の再生状態変化（true=再生開始 / false=停止） */
  onPlaybackStateChange(playing: boolean): void;
  /** 他参加者の再生状態変化（`peer_playback_state` 受信時） */
  onPeerPlaybackStateChange(participantId: string, playing: boolean): void;
  /**
   * 指定参加者の再生中記録をクリアする（`participant_left` / `participant_joined`
   * 受信時。切断・再接続をまたいで「再生中」が残留するのを防ぐ）。
   */
  clearPeer(participantId: string): void;
  /** 全参加者の再生中記録をクリアする（自分の再接続 `joined` 受信時） */
  clearPeers(): void;
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
  let selfPlaying = false;
  const playingPeers = new Set<string>();
  let suppressed = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGraceTimer = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const anyPlaying = (): boolean => selfPlaying || playingPeers.size > 0;

  /** 再生状態の変化を抑止状態へ反映する（再生中→即抑止 / 全停止→猶予後に解除） */
  const update = (): void => {
    if (anyPlaying()) {
      clearGraceTimer();
      suppressed = true;
      return;
    }
    if (!suppressed) {
      return;
    }
    // 全ソースが停止 → 猶予時間の経過後に抑止を解除する。
    clearGraceTimer();
    graceTimer = setTimeout(() => {
      suppressed = false;
      graceTimer = null;
    }, graceMs);
  };

  return {
    onPlaybackStateChange(playing: boolean): void {
      selfPlaying = playing;
      update();
    },

    onPeerPlaybackStateChange(participantId: string, playing: boolean): void {
      if (playing) {
        playingPeers.add(participantId);
      } else {
        playingPeers.delete(participantId);
      }
      update();
    },

    clearPeer(participantId: string): void {
      if (playingPeers.delete(participantId)) {
        update();
      }
    },

    clearPeers(): void {
      if (playingPeers.size > 0) {
        playingPeers.clear();
        update();
      }
    },

    shouldSuppressAudio(): boolean {
      return suppressed;
    },

    dispose(): void {
      clearGraceTimer();
      playingPeers.clear();
      selfPlaying = false;
      suppressed = false;
    },
  };
}
