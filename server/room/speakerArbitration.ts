/**
 * 話者調停（話者交代制、bd-6h1: 生声クロストーク対策）。
 *
 * 対面利用では2台の端末が近接するため、相手の**生声**を自分のマイクも拾い、
 * 「相手の声 → 自端末のSTT（相手と違う言語設定）で誤認識 → 翻訳 → TTS → …」
 * の混線が発生する（本番実機 2026-07-12。TTS再生中のみをミュートする既存の
 * 半二重ゲートでは防げない）。プッシュ・トゥ・トークは不採用
 * （タクシー運転手が乗客と話す想定で、端末を操作しないため）。
 *
 * 対策として「一度に話者は1人」をサーバーが調停する:
 *
 * - **主判定 = 音量差**: 各クライアントが録音中に送る `audio_level`
 *   （ゲイン適用前のRMS）を参加者ごとに保持する。話者は自分の端末を手元に
 *   持っているため、本人の端末に明確に大きな音が入る（音圧は距離の2乗に反比例）。
 * - **従判定 = STT結果の到着**: STT interim/final の到着（=発話活動）を契機に
 *   調停する。話者不在なら、直近レベルの比較で「他参加者が明確に大きい」場合のみ
 *   拒否し、それ以外は当人を話者に確定する。
 * - 話者確定中、**他参加者のSTT結果は破棄**する（クライアントへ送らず、
 *   発話バッファにも積まない。呼び出し側 `Session` が本モジュールの判定に従う）。
 * - 解放: 発話区切りの確定（utterance_committed）／無活動タイムアウト／
 *   stop・切断・退室。確定/解放のたびに `onActiveSpeakerChange` で通知し、
 *   呼び出し側（server/index.ts）が `active_speaker` を全参加者へ配信する。
 *
 * レベル未受信の参加者（WebAudio不可のクライアント等）は「比較不能」として
 * 拒否条件にかけない（STT到着順のみのフォールバック）。
 *
 * @see docs/design/server-design.md「話者調停（話者交代制）」
 * @see docs/design/websocket-protocol.md「audio_level」「active_speaker」
 */

/** 話者の無活動タイムアウト（ms）。この間 STT 結果が来なければ話者を解放する */
export const DEFAULT_HOLD_TIMEOUT_MS = 1500;

/** レベルの鮮度（ms）。これより古い `audio_level` は判定に使わない */
export const DEFAULT_LEVEL_FRESHNESS_MS = 1000;

/**
 * 優勢比。話者候補のレベルに対し、他参加者のレベルがこの倍率を超えて
 * 大きい場合のみ「他人の声を拾った」とみなして拒否する。
 */
export const DEFAULT_DOMINANCE_RATIO = 1.5;

/**
 * 有意レベルの下限。他参加者のレベルがこの値未満の場合は拒否判定に使わない
 * （両者がほぼ無音のとき、ノイズ床の比率で誤って拒否しないため）。
 */
export const DEFAULT_MIN_SIGNIFICANT_LEVEL = 0.05;

export interface SpeakerArbitratorOptions {
  /** 話者確定（participantId）/解放（null）時に呼ばれる通知 */
  onActiveSpeakerChange: (participantId: string | null) => void;
  /** 無活動タイムアウト（既定 {@link DEFAULT_HOLD_TIMEOUT_MS}） */
  holdTimeoutMs?: number;
  /** レベル鮮度（既定 {@link DEFAULT_LEVEL_FRESHNESS_MS}） */
  levelFreshnessMs?: number;
  /** 優勢比（既定 {@link DEFAULT_DOMINANCE_RATIO}） */
  dominanceRatio?: number;
  /** 有意レベル下限（既定 {@link DEFAULT_MIN_SIGNIFICANT_LEVEL}） */
  minSignificantLevel?: number;
  /** 現在時刻の取得（テスト用注入。既定 Date.now） */
  now?: () => number;
}

interface LevelSample {
  level: number;
  at: number;
}

/**
 * 1ルーム分の話者調停器。ルームの生存期間と同じライフサイクルで保持し、
 * ルーム終了・全員退室時に {@link dispose} すること（呼び出し側の責務）。
 */
export class SpeakerArbitrator {
  private readonly onActiveSpeakerChange: (participantId: string | null) => void;
  private readonly holdTimeoutMs: number;
  private readonly levelFreshnessMs: number;
  private readonly dominanceRatio: number;
  private readonly minSignificantLevel: number;
  private readonly now: () => number;

  private activeSpeakerId: string | null = null;
  private readonly levels = new Map<string, LevelSample>();
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: SpeakerArbitratorOptions) {
    this.onActiveSpeakerChange = options.onActiveSpeakerChange;
    this.holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
    this.levelFreshnessMs = options.levelFreshnessMs ?? DEFAULT_LEVEL_FRESHNESS_MS;
    this.dominanceRatio = options.dominanceRatio ?? DEFAULT_DOMINANCE_RATIO;
    this.minSignificantLevel =
      options.minSignificantLevel ?? DEFAULT_MIN_SIGNIFICANT_LEVEL;
    this.now = options.now ?? Date.now;
  }

  /** 現在の話者（テスト・デバッグ用の読み取り専用アクセサ） */
  getActiveSpeakerId(): string | null {
    return this.activeSpeakerId;
  }

  /** `audio_level` 受信: 参加者の直近レベルを記録する */
  onLevel(participantId: string, level: number): void {
    if (this.disposed) {
      return;
    }
    this.levels.set(participantId, { level, at: this.now() });
  }

  /**
   * STT interim/final の到着（=発話活動）時に呼ぶ。
   *
   * @returns この結果を採用してよいか。false の場合、呼び出し側はその STT 結果を
   *   破棄する（クライアント送信・発話バッファ追加・言語検出のいずれにも使わない）。
   */
  onSpeechActivity(participantId: string): boolean {
    if (this.disposed) {
      return true;
    }

    if (this.activeSpeakerId === participantId) {
      // 発話継続: 保持を延長する
      this.scheduleHoldTimeout();
      return true;
    }

    if (this.activeSpeakerId !== null) {
      // 他者が話者の間は破棄（相手の声を拾った誤認識の可能性が高い）
      return false;
    }

    // 話者不在: 音量差で判定する（主判定）。比較不能なら到着順（従判定）で確定。
    if (this.isDominatedByOther(participantId)) {
      return false;
    }

    this.activeSpeakerId = participantId;
    this.scheduleHoldTimeout();
    this.onActiveSpeakerChange(participantId);
    return true;
  }

  /** 発話区切りの確定時に呼ぶ（当人が話者なら解放する） */
  onUtteranceCommitted(participantId: string): void {
    this.releaseIfActive(participantId);
  }

  /** `stop`（録音終了）時に呼ぶ（当人が話者なら解放する） */
  onStop(participantId: string): void {
    this.releaseIfActive(participantId);
  }

  /** 切断・退室時に呼ぶ（話者なら解放し、レベル記録も破棄する） */
  onLeave(participantId: string): void {
    this.levels.delete(participantId);
    this.releaseIfActive(participantId);
  }

  /** タイマー・記録を破棄する（ルーム終了・全員退室時）。通知は行わない */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearHoldTimer();
    this.levels.clear();
    this.activeSpeakerId = null;
  }

  // ─────────────────────────────────────────────
  // 内部処理
  // ─────────────────────────────────────────────

  /**
   * 「他参加者のレベルが明確に大きい」= 相手の声を拾った可能性が高いか。
   *
   * - 当人のレベルが不明/古い場合は比較不能 → 拒否しない（フォールバック）
   * - 他参加者の最大レベルが有意（{@link minSignificantLevel} 以上）かつ
   *   当人の {@link dominanceRatio} 倍を超える場合のみ拒否する
   */
  private isDominatedByOther(participantId: string): boolean {
    const ownLevel = this.freshLevelOf(participantId);
    if (ownLevel === null) {
      return false;
    }

    let maxOther: number | null = null;
    for (const [id, sample] of this.levels) {
      if (id === participantId) {
        continue;
      }
      if (!this.isFresh(sample)) {
        continue;
      }
      if (maxOther === null || sample.level > maxOther) {
        maxOther = sample.level;
      }
    }

    if (maxOther === null || maxOther < this.minSignificantLevel) {
      return false;
    }
    return maxOther > ownLevel * this.dominanceRatio;
  }

  private freshLevelOf(participantId: string): number | null {
    const sample = this.levels.get(participantId);
    if (!sample || !this.isFresh(sample)) {
      return null;
    }
    return sample.level;
  }

  private isFresh(sample: LevelSample): boolean {
    return this.now() - sample.at <= this.levelFreshnessMs;
  }

  private releaseIfActive(participantId: string): void {
    if (this.disposed || this.activeSpeakerId !== participantId) {
      return;
    }
    this.release();
  }

  private release(): void {
    this.clearHoldTimer();
    this.activeSpeakerId = null;
    this.onActiveSpeakerChange(null);
  }

  private scheduleHoldTimeout(): void {
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.activeSpeakerId !== null) {
        this.release();
      }
    }, this.holdTimeoutMs);
    // タイマーがプロセス終了（テストのjest workerや通常のシャットダウン）を
    // ブロックしないようにする（roomManager.ts の autoEndTimer と同じ流儀）。
    this.holdTimer.unref?.();
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
