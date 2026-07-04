/**
 * 発話バッファと発話区切り判定（純粋ロジック、I/O なし）。
 *
 * プロトタイプ（simple-translator/server/utteranceBuffer.ts）からの移植。
 * STT の final result を蓄積し、無音継続・文字数上限・発話秒数上限・
 * 手動 commit・stop のいずれかで発話の確定を判定する。
 *
 * 重要な仕様: 音声チャンク受信ではタイマーをリセットしない。
 * 無音タイマーのリセット契機は STT の interim/final 結果のみ
 * （{@link UtteranceBufferManager.notifyInterim} / {@link UtteranceBufferManager.addFinal}）。
 * MediaRecorder は無音区間でも音声チャンクを送出し続けるため、
 * 生の音声チャンク受信をトリガーにすると無音検出が機能しなくなる。
 *
 * @see docs/design/server-design.md 「発話バッファと発話区切り判定（プロトタイプ流用）」
 */
import type { UtteranceCommitReason } from "@shared/index";

/**
 * 発話が確定した理由。
 * `shared/ws-protocol/schema.ts` の `utteranceCommitReasonSchema`（延いては
 * `utterance_committed.reason` のプロトコル定義）を正本とし、ここでは
 * re-export のみ行う（reason の定義を二重管理しない）。
 */
export type { UtteranceCommitReason };

/**
 * 発話バッファの設定。すべてミリ秒/文字数の実値で保持する
 * （秒単位からの変換は呼び出し側の責務）。
 */
export interface UtteranceBufferConfig {
  /** 無音タイマー（ms）: 最後に final/interim を受けてからの経過時間で判定。バッファ非空時のみ起動 */
  silenceMs: number;
  /** 文字数上限: バッファの確定テキスト長がこれ以上で即座に確定 */
  maxChars: number;
  /** 最大発話タイマー（ms）: バッファが非空になってからの経過時間で判定 */
  maxDurationMs: number;
}

/** デフォルトの発話バッファ設定（無音1.0秒 / 確定80文字 / 同一発話10秒） */
export const DEFAULT_UTTERANCE_BUFFER_CONFIG: UtteranceBufferConfig = {
  silenceMs: 1000,
  maxChars: 80,
  maxDurationMs: 10_000,
};

/** 発話確定時のコールバック */
export type UtteranceCommitCallback = (
  text: string,
  reason: UtteranceCommitReason,
) => void;

/**
 * 発話バッファと発話区切り判定を担う純粋ロジッククラス。
 *
 * - STT final result を蓄積する
 * - 無音タイマー / 最大発話タイマー / 文字数チェック / commit / stop で確定を判定する
 * - 確定時にコールバックを呼ぶのみで、I/O・WebSocket 送信は一切行わない
 * - interim result はバッファへ入れない（タイマーのリセットのみに使い、文字数/確定判定には使わない）
 * - 生の音声チャンク受信ではタイマーを一切操作しない（呼び出し側もこのクラスへ通知しないこと）
 */
export class UtteranceBufferManager {
  private readonly config: UtteranceBufferConfig;
  private readonly onCommit: UtteranceCommitCallback;

  private finals: string[] = [];
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: UtteranceBufferConfig, onCommit: UtteranceCommitCallback) {
    this.config = config;
    this.onCommit = onCommit;
  }

  // ----------------------------------------------------------
  // 公開メソッド
  // ----------------------------------------------------------

  /**
   * STT final result をバッファへ追加する。
   *
   * - バッファが空→非空になった時点で最大発話タイマーを開始する
   * - 追加後に文字数チェックを行い、上限以上であれば即座に確定する（`maxChars`）
   * - 文字数未超過の場合は無音タイマーをリセットする
   */
  addFinal(text: string): void {
    this.assertNotDestroyed();

    const wasEmpty = this.finals.length === 0;
    this.finals.push(text);

    if (wasEmpty) {
      this.startMaxDurationTimer();
    }

    const totalChars = this.finals.join("").length;
    if (totalChars >= this.config.maxChars) {
      this.commitInternal("maxChars");
      return;
    }

    this.resetSilenceTimer();
  }

  /**
   * STT interim result（活動通知）で無音タイマーをリセットする。
   * バッファが非空の場合のみリセットする。
   *
   * バッファが空の場合に無音タイマーを起動すると、まだ発話が
   * 始まっていない状態で silence 確定を誤って起動しかねないため、
   * 何もしない。
   *
   * 注意: 生の音声チャンク受信時はこのメソッドを呼び出さないこと
   * （無音検出は STT 結果のみをトリガーとする既知仕様）。
   */
  notifyInterim(): void {
    this.assertNotDestroyed();

    if (this.finals.length > 0) {
      this.resetSilenceTimer();
    }
  }

  /**
   * 手動 commit（ユーザー操作等による即時区切り）。
   * バッファが非空なら確定する。空バッファの場合は何もしない。
   */
  commit(): void {
    this.assertNotDestroyed();
    this.commitInternal("commit");
  }

  /**
   * セッション終了（stop）による確定。
   * バッファが非空なら確定する。空バッファの場合は何もしない。
   */
  stop(): void {
    this.assertNotDestroyed();
    this.commitInternal("stop");
  }

  /** バッファが空かどうか */
  isEmpty(): boolean {
    return this.finals.length === 0;
  }

  /** バッファの現在のテキストを返す（確定はしない） */
  getText(): string {
    return this.finals.join("");
  }

  /**
   * タイマーをすべてクリアしてリソースを解放する。
   * 接続 close 時や Session の破棄処理から呼ぶこと。
   * destroy() 以降はこのインスタンスを使用してはならない。
   */
  destroy(): void {
    this.clearSilenceTimer();
    this.clearMaxDurationTimer();
    this.destroyed = true;
  }

  // ----------------------------------------------------------
  // プライベート: 確定ロジック
  // ----------------------------------------------------------

  private commitInternal(reason: UtteranceCommitReason): void {
    const text = this.finals.join("");

    // タイマーは確定要否に関わらず必ずクリアする（空文字finalのみが
    // 積まれた状態で commit/stop/タイマー発火が起きた場合に、
    // 無音タイマー・最大発話タイマーが残留してリークするのを防ぐ）。
    this.clearSilenceTimer();
    this.clearMaxDurationTimer();
    this.finals = [];

    if (text.length === 0) {
      // 空バッファは確定イベントを発火しない
      return;
    }

    this.onCommit(text, reason);
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("UtteranceBufferManager: destroy() 済みのインスタンスは使用できません");
    }
  }

  // ----------------------------------------------------------
  // プライベート: タイマー管理
  // ----------------------------------------------------------

  /**
   * 無音タイマーをリセット（クリアして再起動）する。
   */
  private resetSilenceTimer(): void {
    this.clearSilenceTimer();

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      // 空バッファへの silence 確定は commitInternal() 側で弾く
      this.commitInternal("silence");
    }, this.config.silenceMs);
  }

  /**
   * 最大発話タイマーを開始する。
   * バッファが空→非空になった時点で1度だけ呼ぶ。
   */
  private startMaxDurationTimer(): void {
    this.clearMaxDurationTimer();

    this.maxDurationTimer = setTimeout(() => {
      this.maxDurationTimer = null;
      this.commitInternal("maxSeconds");
    }, this.config.maxDurationMs);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearMaxDurationTimer(): void {
    if (this.maxDurationTimer !== null) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }
}
