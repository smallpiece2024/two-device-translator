import { SpeechClient } from "@google-cloud/speech";
import { SpeechStreamHandle } from "./types";

// ============================================================
// Cloud Speech-to-Text Streaming ラッパー
// ============================================================

/**
 * モジュールレベルのシングルトン SpeechClient。
 * サーバープロセス起動時に1度だけ生成して使い回す（遅延初期化）。
 *
 * モジュール import だけでは生成しない（テスト容易性のため）。
 * テスト時は setSpeechClient() でモックに差し替え可能。
 */
let _speechClient: SpeechClient | null = null;

/**
 * SpeechClient を返す（遅延初期化）。
 *
 * テスト容易性のために関数として切り出している。
 * テスト側でこの関数をモックする、または setSpeechClient() で
 * 差し替えることで GCP クライアントを差し替えられる。
 *
 * @returns SpeechClient インスタンス
 */
export function getSpeechClient(): SpeechClient {
  if (_speechClient === null) {
    // 引数なしで ADC（Application Default Credentials）を自動使用
    _speechClient = new SpeechClient();
  }
  return _speechClient;
}

/**
 * テスト用: SpeechClient を差し替える。
 * テスト終了後に resetSpeechClient() で元に戻すこと。
 *
 * @param client モック SpeechClient インスタンス
 */
export function setSpeechClient(client: SpeechClient): void {
  _speechClient = client;
}

/**
 * テスト用: SpeechClient をリセットする（null に戻す）。
 */
export function resetSpeechClient(): void {
  _speechClient = null;
}

// ============================================================
// createSpeechStream のオプション型
// ============================================================

export interface SpeechStreamOptions {
  /**
   * 認識言語コード（Cloud Speech-to-Text の recognition languageCode）。
   * 呼び出し側で解決済みの STT コードを渡す
   * （Phase1 は `server/gcp/languageCodes.ts` の `defaultSttCodeOf()`、
   *  レジストリ実装後は `shared/languages` 由来の解決関数を使う）。
   */
  languageCode: string;
  /**
   * 言語検出モード（FR-4.3・D-9）用の候補言語コード一覧。
   * 指定時のみ `streamingRecognize` の `config.alternativeLanguageCodes` に付与する
   * （`docs/design/gcp-integration.md`「言語検出モード」参照）。
   * 通常モード（既定）では省略し、`languageCode` 固定で認識する。
   */
  alternativeLanguageCodes?: string[];
  /** interim 認識結果のコールバック（表示のみ・翻訳/TTSには使わない） */
  onInterim: (text: string) => void;
  /**
   * final 認識結果のコールバック。
   * `languageCode` は `results[0].languageCode`（言語検出モード時に STT が
   * 判定した実際の言語）。通常モードでは値が入らないことがあるため、
   * 呼び出し側は未指定を「検出情報なし」として扱うこと（既存呼び出し互換のため
   * 第2引数は optional）。
   */
  onFinal: (text: string, languageCode?: string) => void;
  /**
   * エラー・時間上限到達時のコールバック。
   * @param message エラーメッセージ（ユーザー表示用。内部詳細は含めない）
   * @param fatal true の場合は致命的エラー（接続終了が必要）。false は継続可能。
   */
  onError: (message: string, fatal: boolean) => void;
}

// ============================================================
// createSpeechStream
// ============================================================

/**
 * Cloud Speech-to-Text Streaming ストリームを生成し、ハンドルを返す。
 *
 * - `streamingRecognize` に WEBM_OPUS / 48000Hz / interimResults:true を設定する
 *   （`docs/design/gcp-integration.md` の音声形式節に準拠）。
 * - languageCode は呼び出し側で解決済みの STT コードをそのまま渡す（Phase1 は言語検出モード非対応）。
 * - ストリームはセッション中切り直さない（WebM/Opus コンテナヘッダは最初のチャンクのみに含まれるため）。
 * - STT 時間上限到達時は onError(..., false) で通知する（自動再ストリーミングは作り込まない）。
 *
 * テスト時は client 引数にモック SpeechClient を渡すことで GCP API なしで動作させられる。
 *
 * @param options コールバック群と言語コード
 * @param client テスト用クライアント注入（省略時はシングルトンを使用）
 * @returns SpeechStreamHandle（write / end / destroy）
 */
export function createSpeechStream(
  options: SpeechStreamOptions,
  client?: SpeechClient,
): SpeechStreamHandle {
  const { languageCode, alternativeLanguageCodes, onInterim, onFinal, onError } = options;

  const speechClient = client ?? getSpeechClient();

  /**
   * ストリームが書き込み不能になったか（エラー発生・end()・destroy() 後）。
   * bd-c3z: 終了済みストリームへの write は Node 側で 'error' イベント
   * （"Cannot call write after a stream was destroyed"）を発火させ、
   * チャンクごとにエラーログとクライアント通知が連鎖するため、ガードして
   * 静かに破棄する（初回のみ警告ログ1行）。
   */
  let terminated = false;
  let droppedAfterTerminationWarned = false;

  const speechConfig: {
    encoding: "WEBM_OPUS";
    sampleRateHertz: number;
    languageCode: string;
    enableAutomaticPunctuation: boolean;
    alternativeLanguageCodes?: string[];
  } = {
    encoding: "WEBM_OPUS",
    sampleRateHertz: 48000,
    languageCode,
    enableAutomaticPunctuation: true,
  };
  // 言語検出モード（FR-4.3）時のみ付与する（gcp-integration.md「言語検出モード」参照）
  if (alternativeLanguageCodes && alternativeLanguageCodes.length > 0) {
    speechConfig.alternativeLanguageCodes = alternativeLanguageCodes;
  }

  const recognizeStream = speechClient
    .streamingRecognize({
      config: speechConfig,
      interimResults: true,
    })
    .on("data", (data: StreamingRecognizeResponse) => {
      if (!data.results || data.results.length === 0) {
        return;
      }

      const result = data.results[0];

      if (!result.alternatives || result.alternatives.length === 0) {
        return;
      }

      const text = result.alternatives[0].transcript ?? "";

      if (result.isFinal) {
        // final: 発話バッファへ追加する確定テキスト
        // languageCode は言語検出モード時に STT が判定した実際の言語。
        // 未指定時は第2引数自体を渡さない（既存呼び出し・テストとの互換のため、
        // 明示的な undefined 引数付き呼び出しにはしない）。
        if (result.languageCode !== undefined) {
          onFinal(text, result.languageCode);
        } else {
          onFinal(text);
        }
      } else {
        // interim: 表示専用・翻訳・TTS は行わない
        onInterim(text);
      }
    })
    .on("error", (err: Error) => {
      // エラー後のストリームは書き込み不能（bd-c3z: 以降の write は破棄する）。
      terminated = true;
      const message = err.message ?? String(err);
      console.error("[speechStream] STT stream error:", message);

      // Google Cloud STT は時間上限に達すると
      // "Audio Timeout Error" / "DEADLINE_EXCEEDED" 等を返す
      const isTimeout =
        message.includes("Audio Timeout") ||
        message.includes("DEADLINE_EXCEEDED") ||
        message.includes("audio timeout");

      if (isTimeout) {
        // 時間上限到達: fatal:false でクライアントへ再接続を促す（gcp-integration.md 方針）
        onError(
          "Speech recognition stream timed out. Please stop and restart recording.",
          false,
        );
      } else {
        // その他の STT エラー: fatal:false で継続（server-design.md エラー処理方針）
        onError("Speech recognition error. Please try again.", false);
      }
    })
    .on("end", () => {
      terminated = true;
      console.log("[speechStream] STT stream ended.");
    })
    .on("close", () => {
      // error/end を経ずに close のみ発火するケースの取りこぼし防止（レビュー指摘）。
      terminated = true;
    });

  const handle: SpeechStreamHandle = {
    /**
     * Buffer を STT ストリームへ書き込む。
     * 呼び出し元で base64 → Buffer 変換を行い、Buffer を渡すこと。
     */
    write(chunk: Buffer): void {
      // 終了済み（エラー・end・destroy 後）のストリームへは書き込まない
      // （bd-c3z: チャンクごとの 'error' イベント連鎖を防ぐ）。クライアントが
      // 停止前に送り続けた残チャンクは静かに破棄する（初回のみ警告1行）。
      if (terminated) {
        if (!droppedAfterTerminationWarned) {
          droppedAfterTerminationWarned = true;
          console.warn(
            "[speechStream] dropping audio chunks written after stream termination (further drops are silent)",
          );
        }
        return;
      }
      try {
        recognizeStream.write(chunk);
      } catch (err) {
        terminated = true;
        const message = err instanceof Error ? err.message : String(err);
        console.error("[speechStream] Error writing to STT stream:", message);
        onError("Failed to send audio to speech recognition.", false);
      }
    },

    /**
     * STT ストリームへの書き込みを正常終了する（stop メッセージ受信時に呼ぶ）。
     */
    end(): void {
      terminated = true;
      try {
        recognizeStream.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[speechStream] Error ending STT stream:", message);
      }
    },

    /**
     * STT ストリームを強制破棄する（接続 close・再 start 時のクリーンアップ用）。
     */
    destroy(): void {
      terminated = true;
      try {
        recognizeStream.destroy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[speechStream] Error destroying STT stream:", message);
      }
    },
  };

  return handle;
}

/**
 * base64 文字列を STT ストリームへ書き込める Buffer に変換する。
 * WebSocket の audio メッセージ（`data: string`）から呼び出し側で使用する想定。
 *
 * @param base64Chunk base64 エンコードされた音声チャンク
 * @returns デコード済み Buffer
 */
export function decodeAudioChunk(base64Chunk: string): Buffer {
  return Buffer.from(base64Chunk, "base64");
}

// ============================================================
// 型補助（@google-cloud/speech の内部型）
// ============================================================

/**
 * streamingRecognize の data イベントで受け取るレスポンス型。
 * @google-cloud/speech の型定義から必要な部分のみを抜き出す。
 */
interface StreamingRecognizeResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
    }>;
    isFinal?: boolean;
    /** 言語検出モード（alternativeLanguageCodes 指定時）に STT が判定した実際の言語コード */
    languageCode?: string;
  }>;
}
