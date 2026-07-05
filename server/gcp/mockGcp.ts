/**
 * E2E テスト専用の決定的モック GCP 実装。
 *
 * **本番では絶対に使用しない。** 実 GCP パッケージ（@google-cloud/*）は
 * このファイルから一切 import しない（誤って本番ビルドに実 API 呼び出しの
 * 依存を混入させないため）。
 *
 * `GCP_MODE=mock` のときのみ `server/index.ts` から差し込まれる想定
 * （`docs/design/gcp-integration.md` の E2E モック方針を参照）。
 */
import type { SpeechStreamHandle } from "./types";
import type { SpeechStreamOptions } from "./speechStream";
import type { SupportedLanguage } from "@shared/index";

// ============================================================
// モック STT（createSpeechStream 相当）
// ============================================================

/**
 * 言語コードごとの固定 final フレーズ。
 * E2E テストはこの文字列で表示・翻訳結果を検証する。
 */
const MOCK_FINAL_PHRASES: Record<string, string> = {
  "ja-JP": "こんにちは、これはテストです",
  "en-US": "Hello, this is a test",
};

/**
 * languageCode に対応する固定 final フレーズを返す。
 * 未登録の言語コードは `Mock utterance (${languageCode})` を返す。
 */
function mockFinalPhraseOf(languageCode: string): string {
  return MOCK_FINAL_PHRASES[languageCode] ?? `Mock utterance (${languageCode})`;
}

/**
 * E2E テスト専用の決定的な STT ストリームモック。
 *
 * 実際の音声認識は行わず、`write()` の呼び出し回数のみに基づいて
 * コールバックを発火する（本番では使用しない）。
 *
 * - 2回目の `write()` で `onInterim` を1回発火する
 *   （interim テキストは final と区別できる短い文字列）
 * - 4回目の `write()` で `onFinal` を1回だけ発火する
 *   （以降の `write()` は無視する。発話区切りはセッション側の
 *   無音タイマー（1秒）によって確定される）
 * - final テキストは languageCode ごとの固定フレーズ:
 *   - `ja-JP` → `こんにちは、これはテストです`
 *   - `en-US` → `Hello, this is a test`
 *   - その他 → `Mock utterance (${languageCode})`
 * - `end()` / `destroy()` は以降のコールバック発火を止めるフラグを立てるのみ
 *
 * @param options コールバック群と言語コード（`SpeechStreamOptions` と同一）
 * @returns SpeechStreamHandle（write / end / destroy）
 */
export function createMockSpeechStream(options: SpeechStreamOptions): SpeechStreamHandle {
  const { languageCode, onInterim, onFinal } = options;

  let writeCount = 0;
  let finalized = false;
  let stopped = false;

  const finalPhrase = mockFinalPhraseOf(languageCode);
  const interimPhrase = finalPhrase.slice(0, Math.max(1, Math.floor(finalPhrase.length / 3)));

  return {
    write(chunk: Buffer): void {
      void chunk;
      if (stopped) {
        return;
      }
      writeCount += 1;

      if (writeCount === 2) {
        onInterim(interimPhrase);
      } else if (writeCount === 4 && !finalized) {
        finalized = true;
        onFinal(finalPhrase);
      }
    },

    end(): void {
      stopped = true;
    },

    destroy(): void {
      stopped = true;
    },
  };
}

// ============================================================
// モック翻訳（translateText 相当）
// ============================================================

/**
 * E2E テスト専用の決定的な翻訳モック。
 *
 * 実 API を呼ばず、`[${targetLanguage}] ${text}` 形式の固定フォーマットで
 * 即座に返す（本番では使用しない）。E2E テストはこのフォーマットで
 * 翻訳結果の表示を検証する。
 *
 * `translateText`（`server/gcp/translate.ts`）と同一シグネチャ。
 * `sourceLanguage` は未使用（フォーマットに含めない）。
 *
 * @param text 翻訳対象のテキスト
 * @param _sourceLanguage 翻訳元言語（モックでは未使用）
 * @param targetLanguage 翻訳先言語
 * @returns `[${targetLanguage}] ${text}` 形式の固定文字列（空文字列時は空文字列）
 */
export async function mockTranslateText(
  text: string,
  _sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<string> {
  if (text.trim().length === 0) {
    return "";
  }
  return `[${targetLanguage}] ${text}`;
}

// ============================================================
// モック音声合成（synthesizeSpeechToBase64 相当）
// ============================================================

/**
 * 極小の無音 MP3（0.1秒、24kHz mono、libmp3lame）を base64 エンコードした定数。
 * ブラウザの `Audio` 要素で再生してもエラーにならない正当な MP3 データ。
 */
const MOCK_SILENT_MP3_BASE64 =
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjkuMTA3AAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAAAHAAADYABVVVVVVVVVVVVVVVVVVXFxcXFxcXFxcXFxcXFxjo6Ojo6Ojo6Ojo6Ojo6qqqqqqqqqqqqqqqqqqqrHx8fHx8fHx8fHx8fHx+Pj4+Pj4+Pj4+Pj4+Pj//////////////////8AAAAATGF2YzYxLjMzAAAAAAAAAAAAAAAAJAQgAAAAAAAAA2A1FIyBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/80TEAAAAA0gAAAAATEFNRTMuMTAxIChiZXRhIDMpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEUwAAA0gAAAAAMTAxIChiZXRhIDMpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEpgAAA0gAAAAAMTAxIChiZXRhIDMpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TErAAAA0gAAAAAMTAxIChiZXRhIDMpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TErAAAA0gAAAAAMTAxIChiZXRhIDMpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

/**
 * E2E テスト専用の決定的な音声合成モック。
 *
 * 実 API を呼ばず、テキスト・言語に関わらず常に固定の無音 MP3（base64）を
 * 返す（本番では使用しない）。`ENABLE_TTS=false` の場合と空文字列の場合は
 * `synthesizeSpeechToBase64` と同様に `null` を返す。
 *
 * `synthesizeSpeechToBase64`（`server/gcp/textToSpeech.ts`）と同一シグネチャ。
 *
 * @param text 合成対象のテキスト
 * @param targetLanguage ターゲット言語（モックでは未使用）
 * @returns 固定の無音 MP3 の base64 文字列（TTS 無効時・空テキスト時は null）
 */
export async function mockSynthesizeSpeechToBase64(
  text: string,
  targetLanguage: SupportedLanguage,
): Promise<string | null> {
  void targetLanguage;
  if (process.env.ENABLE_TTS === "false") {
    return null;
  }
  if (text.trim().length === 0) {
    return null;
  }
  return MOCK_SILENT_MP3_BASE64;
}
