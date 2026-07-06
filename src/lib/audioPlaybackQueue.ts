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
 * 自動再生制限アンロック用の無音WAV（44バイトの空データ）。
 * ユーザー操作（ジェスチャ）中にこれを一度 play() することで、以降
 * 同じ Audio 要素での再生がモバイルブラウザに許可される。
 */
const SILENT_AUDIO_DATA_URL =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

/**
 * アンロック済みの共有 Audio 要素。
 *
 * モバイルブラウザ（特に iOS Safari）は「ユーザー操作の外」で呼ばれた
 * `audio.play()` を拒否するため、TTS音声（WS受信時に再生）はそのままでは
 * 無音になる（bd-8bd で本番実機にて発覚）。対策として、ユーザー操作中に
 * 無音データで play 済みの **単一の Audio 要素を使い回す**（要素単位で
 * 再生許可が付与される仕様を利用した定石）。
 */
let sharedAudio: HTMLAudioElement | null = null;
let sharedAudioPrimed = false;
/**
 * 共有要素が実再生（TTS音声）に使用中か。prime と実再生の排他制御に使う:
 * 使用中に prime が src を無音WAVへ書き換えたり pause したりすると、
 * 再生中のTTSが中断される（レビュー指摘のレースコンディション）。
 */
let sharedAudioInUse = false;

// 注意: 共有要素・アンロック状態はモジュールスコープのシングルトン。
// createAudioPlaybackQueue はファクトリ注入で複数インスタンスを作れるが、
// デフォルトファクトリ経由の再生は全キューでこの単一要素を共有する
// （現状は1ページ1キュー運用のため問題ない。複数キュー同時再生が必要に
// なったらこの設計を見直すこと）。

/**
 * ユーザー操作（pointerdown / touchend 等のジェスチャハンドラ）の中から
 * 呼び出し、共有 Audio 要素の再生許可を取得する。
 *
 * - アンロック成功後の再呼び出しは no-op（イベントリスナーに繋いだままでよい）。
 * - 失敗（まだ制限中）の場合は primed にせず、次のジェスチャで再試行する。
 *
 * @param createElement テスト用の Audio 要素ファクトリ（省略時は `new Audio()`）
 */
export function primeHtmlAudioPlayback(createElement?: () => HTMLAudioElement): void {
  if (sharedAudioPrimed) {
    return;
  }
  // デフォルトの `new Audio()` はブラウザ環境でのみ生成できる
  // （SSR/Node では no-op。テストはファクトリ注入で Node 環境でも検証可能）。
  if (createElement === undefined && typeof window === "undefined") {
    return;
  }
  if (sharedAudio === null) {
    sharedAudio = (createElement ?? (() => new Audio()))();
  }
  // 実再生（TTS音声）が共有要素を使用中なら触らない（src書き換え・pauseで
  // 再生を中断させないための排他制御）。次のジェスチャで再試行される。
  if (sharedAudioInUse) {
    return;
  }
  const element = sharedAudio;
  element.src = SILENT_AUDIO_DATA_URL;
  const playResult = element.play();
  if (playResult && typeof playResult.then === "function") {
    playResult
      .then(() => {
        // play() 成功＝この要素はアンロック済み。pause は「無音WAVのまま」の
        // 場合のみ行う（解決までの間に実再生が src を差し替えていた場合、
        // pause するとそのTTS再生を止めてしまうため）。
        if (element.src === SILENT_AUDIO_DATA_URL) {
          element.pause();
        }
        sharedAudioPrimed = true;
      })
      .catch(() => {
        // まだ制限中（ジェスチャ外での呼び出し等）、または実再生の play() に
        // 中断された（AbortError）。次のジェスチャで再試行する。
      });
  } else {
    // play() が Promise を返さない古い実装（テスト用フェイク含む）は成功扱い。
    sharedAudioPrimed = true;
  }
}

/** テスト用: 共有 Audio 要素とアンロック状態をリセットする。 */
export function resetHtmlAudioPlaybackForTest(): void {
  sharedAudio = null;
  sharedAudioPrimed = false;
  sharedAudioInUse = false;
}

/**
 * ブラウザの HTMLAudioElement を用いたデフォルトファクトリ。
 * `data:audio/mpeg;base64,...` の Data URL を再生する。
 *
 * `primeHtmlAudioPlayback()` でアンロック済みの共有要素があればそれを
 * 使い回す（モバイルの自動再生制限対策）。キューは同時に1件しか再生しない
 * ため、共有要素の逐次再利用で競合しない。コールバックはプロパティ代入
 * （`onended`/`onerror`）で毎回上書きし、共有要素へのリスナー蓄積を防ぐ。
 */
export const createHtmlAudioPlayer: AudioPlayerFactory = (base64Mp3: string) => {
  const usesSharedElement = sharedAudio !== null;
  const audio = sharedAudio ?? new Audio();
  audio.src = `data:audio/mpeg;base64,${base64Mp3}`;
  let endedCallback: (() => void) | null = null;
  let errorCallback: ((error: unknown) => void) | null = null;

  const releaseSharedElement = () => {
    if (usesSharedElement) {
      sharedAudioInUse = false;
    }
  };

  audio.onended = () => {
    releaseSharedElement();
    endedCallback?.();
  };
  audio.onerror = (event) => {
    releaseSharedElement();
    errorCallback?.(event);
  };

  return {
    play(): void {
      if (usesSharedElement) {
        sharedAudioInUse = true;
      }
      void audio.play().catch((error) => {
        releaseSharedElement();
        errorCallback?.(error);
      });
    },
    stop(): void {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // 未ロード状態での巻き戻しは環境により例外になるが、停止目的は達成済み。
      }
      releaseSharedElement();
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
    player.onError((error) => {
      // 黙って握りつぶすと「音が出ない」原因の切り分けができないため警告は残す
      // （モバイルの自動再生制限が典型。bd-8bd）。error オブジェクトそのもの
      // （Event 経由で音声ペイロードに到達できる）は出力せずメッセージのみ整形。
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[audioPlaybackQueue] 音声の再生に失敗しました:", message);
      advance();
    });
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
