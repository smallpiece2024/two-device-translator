import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { SupportedLanguage, LANGUAGE_REGISTRY } from "@shared/index";
import { defaultTtsVoiceConfigOf, TtsVoiceConfig } from "./languageCodes";

// ============================================================
// Cloud Text-to-Speech ラッパー
// ============================================================

/**
 * モジュールレベルのシングルトン TextToSpeechClient。
 * サーバープロセス起動時に1度だけ生成して使い回す。
 *
 * モジュール import だけでは生成しない（テスト容易性のため）。
 * テスト時は setTtsClient() でモックに差し替え可能。
 */
let _ttsClient: TextToSpeechClient | null = null;

/**
 * TextToSpeechClient を返す（遅延初期化）。
 *
 * @returns TextToSpeechClient インスタンス
 */
export function getTtsClient(): TextToSpeechClient {
  if (_ttsClient === null) {
    // 引数なしで ADC（Application Default Credentials）を自動使用
    _ttsClient = new TextToSpeechClient();
  }
  return _ttsClient;
}

/**
 * テスト用: TextToSpeechClient を差し替える。
 * テスト終了後に resetTtsClient() で元に戻すこと。
 *
 * @param client モック TextToSpeechClient インスタンス
 */
export function setTtsClient(client: TextToSpeechClient): void {
  _ttsClient = client;
}

/**
 * テスト用: TextToSpeechClient をリセットする（null に戻す）。
 */
export function resetTtsClient(): void {
  _ttsClient = null;
}

// ============================================================
// TTS 有効判定
// ============================================================

/**
 * 環境変数 ENABLE_TTS を都度読み取り、TTS が有効かどうかを返す。
 *
 * - 値が "false"（文字列。大文字小文字を区別する）の場合のみ false とみなす。
 * - 未設定（undefined）の場合は true（有効）とみなす。
 *
 * @returns TTS が有効なら true、無効なら false
 */
export function isTtsEnabled(): boolean {
  const val = process.env.ENABLE_TTS;
  if (val === undefined) {
    return true;
  }
  return val !== "false";
}

// ============================================================
// TTS ボイス名の listVoices 検証
// ============================================================

/**
 * `verifyTtsVoices()` の検証結果キャッシュ（言語コード -> 検証済み voice.name）。
 * モジュールレベルで保持し、以後の合成呼び出しでは再検証しない。
 */
let _verifiedVoiceNames: Map<SupportedLanguage, string> | null = null;
let _verifyPromise: Promise<Map<SupportedLanguage, string>> | null = null;

/**
 * テスト用: 検証結果キャッシュをリセットする（null に戻す）。
 */
export function resetVerifiedTtsVoices(): void {
  _verifiedVoiceNames = null;
  _verifyPromise = null;
}

/**
 * 言語レジストリ（`shared/languages/registry.ts`）の `ttsVoiceName` が
 * Text-to-Speech API 上に実在するか `listVoices()` で検証する。
 *
 * - 検証結果はモジュールレベルでキャッシュし、以後は再検証しない
 * - `ttsVoiceName` 未定義の言語は検証をスキップする（対象外）
 * - ボイスが見つからない場合、および `listVoices()` 自体が失敗した場合は、
 *   その言語をキャッシュに含めず（未検証扱い）、警告ログを出して処理を継続する。
 *   **検証失敗が音声合成そのものを止めることはない**（呼び出し側は
 *   キャッシュに存在しない言語について languageCode+gender のみで
 *   フォールバック合成する）。
 *
 * @param client テスト用クライアント注入（省略時はシングルトンを使用）
 * @returns 言語コード -> 検証済み voice.name の Map
 */
export async function verifyTtsVoices(
  client?: TextToSpeechClient,
): Promise<Map<SupportedLanguage, string>> {
  if (_verifiedVoiceNames !== null) {
    return _verifiedVoiceNames;
  }
  if (_verifyPromise !== null) {
    return _verifyPromise;
  }

  const ttsClient = client ?? getTtsClient();

  _verifyPromise = (async () => {
    const result = new Map<SupportedLanguage, string>();

    for (const entry of LANGUAGE_REGISTRY) {
      if (entry.ttsVoiceName === undefined) {
        continue;
      }
      try {
        const [response] = await ttsClient.listVoices({
          languageCode: entry.ttsLanguageCode,
        });
        const available = response.voices ?? [];
        const found = available.some((v) => v.name === entry.ttsVoiceName);
        if (found) {
          result.set(entry.code, entry.ttsVoiceName);
        } else {
          console.warn(
            `[verifyTtsVoices] voice not found for ${entry.code}: "${entry.ttsVoiceName}" ` +
              "(falling back to languageCode+gender only)",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[verifyTtsVoices] listVoices() failed for ${entry.code}: ${message} ` +
            "(falling back to languageCode+gender only)",
        );
      }
    }

    _verifiedVoiceNames = result;
    return result;
  })();

  try {
    return await _verifyPromise;
  } catch (err) {
    // 上記 IIFE 内で例外を全て捕捉しているため通常到達しないが、
    // 万一の想定外エラーでも合成を止めないよう防御的にフォールバックする。
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[verifyTtsVoices] unexpected failure: ${message} (falling back)`);
    _verifiedVoiceNames = new Map();
    return _verifiedVoiceNames;
  } finally {
    _verifyPromise = null;
  }
}

// ============================================================
// 音声合成関数
// ============================================================

export interface SynthesizeOptions {
  /** テスト用クライアント注入（省略時はシングルトンを使用） */
  client?: TextToSpeechClient;
  /**
   * 言語コード（SupportedLanguage）を Text-to-Speech の voice 設定へ解決する関数。
   * 省略時は `server/gcp/languageCodes.ts` の Phase1 用デフォルト実装を使う。
   * `shared/languages` のレジストリ実装後は、この引数にレジストリ由来の関数を
   * 注入することで差し替えられる（TODO コメントではなく関数注入で吸収する）。
   */
  resolveTtsVoiceConfig?: (language: SupportedLanguage) => TtsVoiceConfig;
  /**
   * テスト用: `verifyTtsVoices()` の差し替え。
   * 省略時はモジュール本体の `verifyTtsVoices` を使う。
   */
  verifyVoicesFn?: (client?: TextToSpeechClient) => Promise<Map<SupportedLanguage, string>>;
}

/**
 * テキストを Cloud Text-to-Speech API で MP3 音声に同期合成し、
 * base64 文字列として返す。
 *
 * - ENABLE_TTS=false の場合は API を呼ばずに null を返す。
 * - 空文字列・空白のみのテキストは API を呼ばずに null を返す。
 * - 合成結果は base64 文字列として返す（WebSocket の `audio` メッセージの `data` フィールドに直接使用可能）。
 * - voice 設定は `resolveTtsVoiceConfig`（既定は Phase1 用の変換表）で解決する。
 *   `voiceName` が定義されている場合のみ voice.name フィールドを含める。
 *
 * @param text 合成対象のテキスト
 * @param targetLanguage ターゲット言語
 * @param options client / resolveTtsVoiceConfig の注入用オプション
 * @returns 合成音声の base64 文字列（TTS 無効時・空テキスト時は null）
 */
export async function synthesizeSpeechToBase64(
  text: string,
  targetLanguage: SupportedLanguage,
  options: SynthesizeOptions = {},
): Promise<string | null> {
  // ENABLE_TTS=false の場合は API を呼ばずに null を返す
  if (!isTtsEnabled()) {
    return null;
  }

  // 空文字列・空白のみの場合は API を呼ばずに null を返す
  if (text.trim().length === 0) {
    return null;
  }

  const {
    client,
    resolveTtsVoiceConfig = defaultTtsVoiceConfigOf,
    verifyVoicesFn = verifyTtsVoices,
  } = options;
  const ttsClient = client ?? getTtsClient();

  const voiceConfig = resolveTtsVoiceConfig(targetLanguage);

  // resolveTtsVoiceConfig が既に voiceName を返している場合（明示的な注入等）は
  // それをそのまま使用する（従来どおりの挙動）。
  // 未定義の場合（レジストリ既定の defaultTtsVoiceConfigOf 等）は、
  // listVoices() で検証済みのボイス名があればそれを使用し、
  // 未検証・検証失敗時は languageCode+gender のみでフォールバックする
  // （検証処理自体の失敗で合成を止めない）。
  let voiceName = voiceConfig.voiceName;
  if (voiceName === undefined) {
    try {
      const verified = await verifyVoicesFn(ttsClient);
      voiceName = verified.get(targetLanguage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[synthesize] voice verification failed for ${targetLanguage}: ${message} ` +
          "(falling back to languageCode+gender only)",
      );
    }
  }

  const voice: {
    languageCode: string;
    ssmlGender?: "MALE" | "FEMALE";
    name?: string;
  } = {
    languageCode: voiceConfig.languageCode,
  };
  if (voiceConfig.gender !== undefined) {
    voice.ssmlGender = voiceConfig.gender;
  }
  if (voiceName !== undefined) {
    voice.name = voiceName;
  }

  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice,
      audioConfig: {
        audioEncoding: "MP3",
      },
    });

    if (!response.audioContent) {
      console.error("[synthesize] TTS response has no audioContent");
      return null;
    }

    // audioContent は Uint8Array | string のどちらも想定する
    const audioBuffer =
      response.audioContent instanceof Uint8Array
        ? Buffer.from(response.audioContent)
        : Buffer.from(response.audioContent as string, "binary");

    return audioBuffer.toString("base64");
  } catch (err) {
    // GCP の内部詳細やスタックトレースをそのまま流さない
    const message = err instanceof Error ? err.message : String(err);
    console.error("[synthesize] Text-to-Speech API error:", message);
    throw new Error("Text-to-Speech failed. Please try again.");
  }
}
