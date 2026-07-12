/**
 * マイク入力の WebAudio パイプライン（bd-1or: 話者交代制の基盤）。
 *
 * getUserMedia のストリームを直接 MediaRecorder に渡すのではなく、
 *
 *   source → gain → destination（→ MediaRecorder）
 *          └→ analyser（レベル測定、ゲイン適用前）
 *
 * の経路を構築する。目的は2つ:
 *
 * 1. **ゲイン方式ミュート**: 半二重ミュートを `MediaStreamTrack.enabled=false`
 *    ではなく GainNode のゲイン0で行う。トラック無効化はモバイルブラウザで
 *    MediaRecorder がサイズ0チャンクを出し、音声供給の途絶で Google Streaming
 *    STT が Audio Timeout になる（本番実機 2026-07-12）。ゲイン0なら
 *    エンコーダは無音の**実データ**を出し続けるため、STTストリームが途切れない。
 * 2. **入力レベル測定**: 話者交代制（生声クロストーク対策）の主判定材料として、
 *    ゲイン適用前の実際のマイク入力レベル（RMS、0..1）を提供する。
 *
 * AudioContext が使えない環境（テスト・旧ブラウザ）では元ストリームをそのまま
 * 返すフォールバックで動作する（ミュートは従来の track.enabled 方式、
 * レベル測定は不可 = null）。
 *
 * @see docs/design/frontend-design.md（半二重制約・話者交代制）
 */

/** AnalyserNode の FFT サイズ（時間領域サンプル数。約21ms@48kHz 分） */
const ANALYSER_FFT_SIZE = 1024;

export interface AudioPipeline {
  /**
   * MediaRecorder に渡す録音用ストリーム。
   * WebAudio 利用時は GainNode 通過後の destination ストリーム、
   * フォールバック時は元ストリームそのもの。
   */
  recordingStream: MediaStream;
  /** WebAudio パイプラインが有効か（フォールバック時 false） */
  usingWebAudio: boolean;
  /**
   * ミュート切替。WebAudio 利用時はゲイン 0/1、フォールバック時は
   * 全オーディオトラックの enabled を切り替える。
   */
  setMuted(muted: boolean): void;
  /**
   * 現在の入力レベル（ゲイン適用前の RMS、0..1）。
   * フォールバック時（測定不可）は null。
   */
  getLevel(): number | null;
  /**
   * AudioContext 等の資源を解放する。元ストリームのトラック停止
   * （`track.stop()`）は呼び出し側の責務（従来どおり Recorder が行う）。
   */
  dispose(): void;
}

/**
 * ブラウザの AudioContext コンストラクタを解決する（Safari の webkit プレフィクス対応）。
 * 利用不可（jsdom 等）なら null。
 */
function resolveDefaultAudioContextFactory(): (() => AudioContext) | null {
  if (typeof window === "undefined") {
    return null;
  }
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  return () => new Ctor();
}

/** フォールバック実装（track.enabled 方式。従来 bd-dnh の挙動） */
function createFallbackPipeline(stream: MediaStream): AudioPipeline {
  return {
    recordingStream: stream,
    usingWebAudio: false,
    setMuted(muted: boolean): void {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    getLevel(): number | null {
      return null;
    },
    dispose(): void {
      // 解放すべき WebAudio 資源はない（トラック停止は呼び出し側の責務）
    },
  };
}

/**
 * マイクストリームから WebAudio パイプラインを構築する。
 *
 * AudioContext はユーザージェスチャ起点（録音開始ボタンのハンドラ内）で
 * 呼び出すこと。suspended 状態（モバイルの自動再生制限）なら resume を試みる。
 *
 * @param stream getUserMedia で取得したマイクストリーム
 * @param audioContextFactory テスト用の AudioContext 生成関数（省略時はブラウザ実装）
 */
export function createAudioPipeline(
  stream: MediaStream,
  audioContextFactory?: () => AudioContext,
): AudioPipeline {
  const factory = audioContextFactory ?? resolveDefaultAudioContextFactory();
  if (!factory) {
    return createFallbackPipeline(stream);
  }

  let ctx: AudioContext;
  let gain: GainNode;
  let analyser: AnalyserNode;
  let destination: MediaStreamAudioDestinationNode;
  try {
    ctx = factory();
    if (ctx.state === "suspended") {
      // ベストエフォートで resume する。reject してもパイプライン構築は続行する
      // （録音操作自体は継続可能にする）が、suspended のままだと destination に
      // 音声が流れず STT への供給が途絶えるため、切り分け用に警告を残す
      // （コードレビュー should-fix。実挙動はユーザージェスチャ起点なら
      // resume 可能なのが通常で、恒常的に失敗する場合は実機ログで検知する）。
      void ctx.resume().catch((err: unknown) => {
        console.warn(
          "[audioPipeline] AudioContext.resume() failed; audio may stay silent while suspended:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    const source = ctx.createMediaStreamSource(stream);
    gain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    destination = ctx.createMediaStreamDestination();

    // 録音経路（ミュート対象）とレベル測定（ゲイン適用前）を分岐する
    source.connect(gain);
    gain.connect(destination);
    source.connect(analyser);
  } catch (err) {
    // 構築失敗時は録音を止めない（フォールバックで従来動作を維持する）
    console.warn(
      "[audioPipeline] WebAudio pipeline construction failed; falling back to raw stream:",
      err instanceof Error ? err.message : String(err),
    );
    return createFallbackPipeline(stream);
  }

  let disposed = false;
  const timeDomainBuffer = new Uint8Array(analyser.fftSize);

  return {
    recordingStream: destination.stream,
    usingWebAudio: true,

    setMuted(muted: boolean): void {
      if (disposed) {
        return;
      }
      gain.gain.value = muted ? 0 : 1;
    },

    getLevel(): number | null {
      if (disposed) {
        return null;
      }
      analyser.getByteTimeDomainData(timeDomainBuffer);
      // 8bit 時間領域データ（128=無音中心）を -1..1 に正規化して RMS を取る
      let sumSquares = 0;
      for (let i = 0; i < timeDomainBuffer.length; i++) {
        const normalized = (timeDomainBuffer[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      return Math.min(1, Math.sqrt(sumSquares / timeDomainBuffer.length));
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      void ctx.close().catch(() => {});
    },
  };
}
