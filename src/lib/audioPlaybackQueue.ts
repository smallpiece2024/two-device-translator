/**
 * 音声再生キュー（TTS音声の順次再生）
 *
 * サーバーから受信する合成音声（`audio` メッセージ、mp3 base64）を
 * 受信順に1件ずつ再生する。同時再生・割り込みは発生しない。
 *
 * Audio API（HTMLAudioElement 等）は本ファイルに直接依存させず、
 * 注入可能なファクトリ（{@link AudioPlayerFactory}）でラップする。
 * これによりキューイングロジック自体を Node 環境（jsdom 不要）で
 * 単体テストできる。
 *
 * 【設計判断】setEnabled(false) 時の挙動について
 * frontend-design.md には OFF 時の途中停止/再生し切りの明記がない。
 * このモジュールでは「再生中のものは最後まで再生し、キューに溜まっている
 * 未再生分は破棄する」を採用する。理由:
 *   - 発話の途中で音声が切れるとユーザー体験として不自然（聞き取りにくい）。
 *   - トグルOFFは「これから受け取る音声を再生しない」という意図が主目的であり、
 *     現在再生中の一件を即座に切ることまでは要求しない。
 *   - dispose() は明確にリソース解放が必要な場面（アンマウント等）のため、
 *     即時停止する（setEnabled とは異なるセマンティクス）。
 */

/** 再生可能なプレイヤーの最小インターフェース。 */
export interface AudioPlayer {
  /** 再生を開始する。完了時に渡されたコールバックが呼ばれる想定。 */
  play(): void;
  /** 再生を即座に停止する。 */
  stop(): void;
  /** 再生完了時に呼ばれるコールバックを設定する。 */
  onEnded(callback: () => void): void;
  /** 再生エラー時に呼ばれるコールバックを設定する。 */
  onError(callback: (error: unknown) => void): void;
}

/** base64 mp3 データから AudioPlayer を生成するファクトリ関数。 */
export type AudioPlayerFactory = (base64Mp3: string) => AudioPlayer;

/**
 * ブラウザの HTMLAudioElement を用いたデフォルトファクトリ。
 * `data:audio/mpeg;base64,...` の Data URL を再生する。
 */
export const createHtmlAudioPlayer: AudioPlayerFactory = (base64Mp3: string) => {
  const audio = new Audio(`data:audio/mpeg;base64,${base64Mp3}`);
  let endedCallback: (() => void) | null = null;
  let errorCallback: ((error: unknown) => void) | null = null;

  audio.addEventListener("ended", () => {
    endedCallback?.();
  });
  audio.addEventListener("error", (event) => {
    errorCallback?.(event);
  });

  return {
    play(): void {
      void audio.play().catch((error) => {
        errorCallback?.(error);
      });
    },
    stop(): void {
      audio.pause();
      audio.currentTime = 0;
    },
    onEnded(callback: () => void): void {
      endedCallback = callback;
    },
    onError(callback: (error: unknown) => void): void {
      errorCallback = callback;
    },
  };
};

/** 音声再生キューの公開インターフェース。 */
export interface AudioPlaybackQueue {
  /**
   * base64 mp3 データをキューに追加する。
   * 再生中でなければ即座に再生を開始し、再生中ならキューに積んで待機する。
   * setEnabled(false) の状態では無視する（キューに積まない）。
   */
  enqueue(base64Mp3: string): void;
  /**
   * 再生の有効/無効を切り替える。
   * false にすると、以降の enqueue を無視し、キューに残っている未再生分を破棄する。
   * 現在再生中の音声は最後まで再生する（モジュール先頭コメントの設計判断を参照）。
   * true に戻すと以降の enqueue を再び受け付ける。
   */
  setEnabled(enabled: boolean): void;
  /** 全停止・リソース解放を行う。以降 enqueue しても何も起きない。 */
  dispose(): void;
}

/**
 * 音声再生キューを生成する。
 * @param playerFactory base64 mp3 から AudioPlayer を生成するファクトリ（未指定時は HTMLAudioElement 実装）
 */
export function createAudioPlaybackQueue(
  playerFactory: AudioPlayerFactory = createHtmlAudioPlayer,
): AudioPlaybackQueue {
  const queue: string[] = [];
  let currentPlayer: AudioPlayer | null = null;
  let enabled = true;
  let disposed = false;

  const playNext = (): void => {
    if (disposed) {
      return;
    }
    if (currentPlayer !== null) {
      // 既に再生中（呼び出し側の不整合防止のガード）。
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      return;
    }

    const player = playerFactory(next);
    currentPlayer = player;

    const advance = (): void => {
      currentPlayer = null;
      playNext();
    };

    player.onEnded(advance);
    player.onError(advance);
    player.play();
  };

  return {
    enqueue(base64Mp3: string): void {
      if (disposed || !enabled) {
        return;
      }
      queue.push(base64Mp3);
      if (currentPlayer === null) {
        playNext();
      }
    },

    setEnabled(nextEnabled: boolean): void {
      if (disposed) {
        return;
      }
      enabled = nextEnabled;
      if (!enabled) {
        // 未再生分は破棄。再生中のものは最後まで再生させる。
        queue.length = 0;
      }
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      queue.length = 0;
      if (currentPlayer !== null) {
        currentPlayer.stop();
        currentPlayer = null;
      }
    },
  };
}
