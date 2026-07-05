/**
 * WS接続ごとのセッション状態（1接続 = ルーム内の1参加者）。
 *
 * `join` 受理後に生成され、接続が close するまで生存する。
 * 言語設定・TTSトグル・在室状態（present）を保持し、この接続への
 * メッセージ送信を担う。
 *
 * `start`/`audio`/`commit`/`stop` の録音セッション処理（STTストリーム・
 * 発話バッファ）もこのクラスが保持する。GCP呼び出しは `server/gcp/*` の
 * ラッパー経由で行い、`startRecording` の引数でクライアント差し替え可能な
 * 生成関数を注入できるようにする（テスト容易性のため）。
 *
 * @see docs/design/server-design.md 「モジュール構成」「状態モデル（インメモリ）」「セッションライフサイクル」
 */
import type { WebSocket } from "ws";
import type {
  ParticipantSummary,
  ServerMessage,
  StartMessage,
  UtteranceCommitReason,
} from "@shared/index";
import type { SupportedLanguage } from "@shared/index";
import {
  UtteranceBufferManager,
  type UtteranceBufferConfig,
} from "../utterance/utteranceBuffer";
import {
  createSpeechStream,
  decodeAudioChunk,
  type SpeechStreamOptions,
} from "../gcp/speechStream";
import { defaultSttCodeOf } from "../gcp/languageCodes";
import type { SpeechStreamHandle } from "../gcp/types";

/** 参加者ロール（owner=ルーム作成者、guest=招待された相手） */
export type ParticipantRole = "owner" | "guest";

/** `verifyJoin` が返す、検証済み参加者の識別情報 */
export interface ParticipantIdentity {
  participantId: string;
  role: ParticipantRole;
  displayName?: string;
  language: SupportedLanguage;
}

/** `Session` 生成時の追加オプション */
export interface SessionOptions {
  /** 聞き手として TTS を受け取るか（既定 true。通常は join 由来で明示的に渡される） */
  enableTts?: boolean;
}

/**
 * `startRecording` が STT ストリームを生成する際に使う関数のシグネチャ
 * （既定は `server/gcp/speechStream.ts` の `createSpeechStream`。テスト用に差し替え可能）。
 */
export type CreateSpeechStreamFn = (options: SpeechStreamOptions) => SpeechStreamHandle;

/** `startRecording` に渡すフック・依存注入 */
export interface StartRecordingHooks {
  /** 発話区切りが確定した際に呼ばれる（配信ルーティングは呼び出し側の責務） */
  onUtteranceCommitted: (text: string, reason: UtteranceCommitReason) => void;
  /** STT ストリーム生成関数（省略時は `createSpeechStream` を使用。テスト用差し替え） */
  createSpeechStream?: CreateSpeechStreamFn;
  /** 言語コード（SupportedLanguage）→ STT languageCode の解決関数（省略時はレジストリ既定実装） */
  resolveSttCode?: (language: SupportedLanguage) => string;
}

/**
 * 1接続 = 1参加者のセッション。
 *
 * ルーム内での可変状態（言語・TTSトグル・在室状態）と、この接続への
 * メッセージ送信手段、および録音セッション（STTストリーム・発話バッファ）を
 * 1つにまとめる。
 */
export class Session {
  readonly participantId: string;
  readonly role: ParticipantRole;
  displayName?: string;
  language: SupportedLanguage;
  enableTts: boolean;
  present: boolean;

  private readonly ws: WebSocket;
  private utteranceBuffer: UtteranceBufferManager | null = null;
  private sttHandle: SpeechStreamHandle | null = null;

  constructor(identity: ParticipantIdentity, ws: WebSocket, options: SessionOptions = {}) {
    this.participantId = identity.participantId;
    this.role = identity.role;
    this.displayName = identity.displayName;
    this.language = identity.language;
    this.enableTts = options.enableTts ?? true;
    this.present = true;
    this.ws = ws;
  }

  /**
   * この接続へサーバー→クライアントメッセージを送信する。
   * 接続が既に開いていない場合は何もしない（close処理中の二重送信防止）。
   */
  send(message: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /** `joined.participants` 等に載せるための要約情報へ変換する */
  toSummary(): ParticipantSummary {
    return {
      participantId: this.participantId,
      role: this.role,
      displayName: this.displayName,
      language: this.language,
      present: this.present,
    };
  }

  /** 録音セッション中（`start` 済み・`stop` 未受信）かどうか */
  get isRecording(): boolean {
    return this.sttHandle !== null;
  }

  /**
   * `start` メッセージを受けて録音セッションを開始する。
   *
   * - `language` を `sourceLanguage` に更新する（「現在の話す言語」、server-design.md 状態モデル参照）
   * - `enableTts` を `start.enableTts`（聞き手としてTTSを受け取るか）で更新する
   * - 発話バッファ（`UtteranceBufferManager`）を初期化する
   * - STT ストリームを生成し、interim/final/error を発話バッファ・クライアント送信へ結線する
   *
   * 既に録音中の場合は、既存のストリーム・バッファを破棄してから再生成する
   * （未確定分は破棄。通常フローでは `stop` を経ずに再度 `start` することは想定しないが、
   * 防御的に対応する）。
   */
  startRecording(config: StartMessage, hooks: StartRecordingHooks): void {
    if (this.isRecording) {
      this.destroyRecording();
    }

    this.language = config.sourceLanguage;
    this.enableTts = config.enableTts;

    const bufferConfig: UtteranceBufferConfig = {
      silenceMs: config.silenceMs,
      maxChars: config.maxChars,
      maxDurationMs: config.maxSeconds * 1000,
    };

    this.utteranceBuffer = new UtteranceBufferManager(bufferConfig, (text, reason) => {
      this.send({ type: "utterance_committed", text, reason });
      hooks.onUtteranceCommitted(text, reason);
    });

    const resolveSttCode = hooks.resolveSttCode ?? defaultSttCodeOf;
    const createStream = hooks.createSpeechStream ?? createSpeechStream;

    this.sttHandle = createStream({
      languageCode: resolveSttCode(config.sourceLanguage),
      onInterim: (text) => {
        this.send({ type: "transcript_interim", text });
        this.utteranceBuffer?.notifyInterim();
      },
      onFinal: (text) => {
        // 空文字（またはtrim後空）の final はバッファに積む意味がなく、
        // クライアントへ送信しても表示上意味を持たないためスキップする。
        if (text.trim().length === 0) {
          return;
        }
        this.utteranceBuffer?.addFinal(text);
        this.send({ type: "transcript_final", text });
      },
      onError: (message, fatal) => {
        this.send({ type: "error", message, fatal });
      },
    });
  }

  /**
   * `audio` メッセージ（base64 化された音声チャンク）を STT ストリームへ書き込む。
   * 録音中でない場合は何もしない（呼び出し側で `start` 前判定を行うこと）。
   */
  writeAudioChunk(base64Data: string): void {
    if (!this.sttHandle) {
      return;
    }
    this.sttHandle.write(decodeAudioChunk(base64Data));
  }

  /**
   * `commit` メッセージ: 現在の発話バッファを即時確定する（空なら何もしない）。
   */
  commitUtterance(): void {
    this.utteranceBuffer?.commit();
  }

  /**
   * `stop` メッセージ: 残バッファを確定し、STTストリームを終了する（接続は維持）。
   * 確定コールバック（`onUtteranceCommitted`）は `stop()` 呼び出し中に同期的に発火する。
   */
  stopRecording(): void {
    this.utteranceBuffer?.stop();
    this.sttHandle?.end();
    // stop() 呼び出し後の残タイマーを確実に解放してから破棄する
    this.utteranceBuffer?.destroy();
    this.clearRecordingState();
  }

  /**
   * 接続 close 等でセッションを破棄する際に呼ぶ。
   * 未確定分の確定は行わず、そのまま破棄する
   * （server-design.md「ルーム状態は…プロセス再起動で失われる」と同様、
   * 進行中の未確定発話のみ失われる仕様）。
   */
  destroyRecording(): void {
    this.sttHandle?.destroy();
    this.utteranceBuffer?.destroy();
    this.clearRecordingState();
  }

  private clearRecordingState(): void {
    this.utteranceBuffer = null;
    this.sttHandle = null;
  }
}
