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
import { alternativeSttCodes, LanguageDetector } from "./languageDetection";

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
  /**
   * 言語検出モード（FR-4.3・D-9）で最初の final から話者言語が確定した際に呼ばれる。
   * 呼び出し側（`server/index.ts`）は `participant_updated` を配信する責務を持つ
   * （docs/design/server-design.md「言語検出モード（FR-4.3・Phase2）」参照）。
   * 通常モード（`config.detectLanguage=false`）では呼ばれない。
   */
  onLanguageDetected?: (language: SupportedLanguage) => void;
  /**
   * STT結果（interim/final）到着時の話者調停フック（話者交代制、bd-6h1）。
   * false を返した場合、その結果は**破棄**する（クライアントへの
   * transcript_interim/final 送信・発話バッファへの追加・言語検出のいずれにも
   * 使わない）。対面利用で相手の生声を拾った誤認識を配信しないための仕組み。
   * 省略時はすべて採用（調停なし）。
   * @see server/room/speakerArbitration.ts
   */
  onSpeechActivity?: () => boolean;
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

  private ws: WebSocket;
  private utteranceBuffer: UtteranceBufferManager | null = null;
  private sttHandle: SpeechStreamHandle | null = null;
  private languageDetector: LanguageDetector | null = null;

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

  /**
   * 再接続時、このセッションが表す接続を新しいソケットへ差し替える
   * （bd-e3p: 同一 participantId での再接続復帰）。`present` を `true` に戻し、
   * 差し替え前のソケットを返す（呼び出し側はまだ開いていれば閉じる判断に使う。
   * 「二重接続時は新しい接続を正とする」設計判断、docs/design/server-design.md
   * 「再接続・不在・終了判定」参照）。
   *
   * 差し替え前に録音セッション（STTストリーム・発話バッファ）があれば
   * 破棄する（コードレビュー指摘 should-fix2）。旧ソケットに紐づく録音は
   * 新しい接続からは制御できず、放置すると孤立した STT ストリームとして
   * 課金・リソースリークの原因になる。再接続後に録音を続けたい場合、
   * クライアントは改めて `start` を送る想定（プロトタイプ通り、録音は
   * 接続ではなくセッション単位の明示操作）。
   */
  attachSocket(ws: WebSocket): WebSocket {
    if (this.isRecording) {
      this.destroyRecording();
    }

    const previous = this.ws;
    this.ws = ws;
    this.present = true;
    return previous;
  }

  /**
   * 渡された `ws` が現在このセッションの現役ソケットかどうかを返す。
   * 再接続で差し替えられた「古い」物理接続の close イベントが後から発火した際、
   * 誤って新しい接続の状態（present・録音セッション）を壊さないためのガードに使う
   * （`server/index.ts` の close ハンドラ参照）。
   */
  isCurrentSocket(ws: WebSocket): boolean {
    return this.ws === ws;
  }

  /**
   * このセッションの現在のソケットを閉じる（開いている場合のみ）。
   * ルーム終了時（`request_end` / 自動終了）に全参加者の接続を終了するために使う。
   */
  closeSocket(code?: number, reason?: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.close(code, reason);
    }
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
   * - `config.detectLanguage=true` の場合、STT を複数言語候補（`alternativeLanguageCodes`）で
   *   開始し、最初の final の判定言語で `language` を確定・以後固定する
   *   （FR-4.3・D-9、docs/design/server-design.md「言語検出モード」参照）
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

    this.languageDetector = config.detectLanguage
      ? new LanguageDetector(config.sourceLanguage)
      : null;

    this.sttHandle = createStream({
      languageCode: resolveSttCode(config.sourceLanguage),
      alternativeLanguageCodes: config.detectLanguage
        ? alternativeSttCodes(config.sourceLanguage, resolveSttCode)
        : undefined,
      onInterim: (text) => {
        // 話者調停（bd-6h1）: 空でない interim のみ発話活動として扱い
        // （空 interim で話者を確保・延長しない）、破棄対象なら送信しない
        // （他参加者が話者の間＝相手の声を拾った誤認識の可能性が高い）。
        if (
          text.trim().length > 0 &&
          hooks.onSpeechActivity &&
          !hooks.onSpeechActivity()
        ) {
          return;
        }
        this.send({ type: "transcript_interim", text });
        this.utteranceBuffer?.notifyInterim();
      },
      onFinal: (text, sttLanguageCode) => {
        const isEmpty = text.trim().length === 0;

        // 話者調停（bd-6h1）: 空でない final のみ発話活動として扱う
        // （空 final で話者を確保・延長しない）。破棄対象の final は言語検出にも
        // 使わない（相手の声を拾った誤認識で言語を確定させないため、検出より
        // 先に判定する）。
        if (!isEmpty && hooks.onSpeechActivity && !hooks.onSpeechActivity()) {
          return;
        }

        // 言語検出モード: 最初の final でのみ判定・確定する（以後固定）。
        // 検出失敗（未対応言語・値なし）時は fail-safe で現在言語を維持する。
        if (this.languageDetector) {
          const detected = this.languageDetector.handleFinal(sttLanguageCode);
          if (detected) {
            this.language = detected;
            hooks.onLanguageDetected?.(detected);
          }
        }

        // 空文字（またはtrim後空）の final はバッファに積む意味がなく、
        // クライアントへ送信しても表示上意味を持たないためスキップする。
        if (isEmpty) {
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
    this.languageDetector = null;
  }
}
