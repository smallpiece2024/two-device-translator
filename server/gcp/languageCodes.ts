import { SupportedLanguage } from "./types";

/**
 * Phase1 用の最小言語コード変換テーブル（ja-JP / en-US 固定）。
 *
 * `docs/design/gcp-integration.md` は `shared/languages.ts` に多言語対応の
 * レジストリを置く設計だが、このタスク時点では未実装のため、ここに Phase1
 * 相当の最小実装を置く。`translate.ts` / `textToSpeech.ts` は解決関数を
 * オプション引数として受け取れるようにしており、レジストリ実装後は
 * その引数に `shared/languages` 由来の関数を注入するだけで差し替えられる
 * （TODO コメントではなく関数注入で吸収する）。
 */

export interface TtsVoiceConfig {
  /** Text-to-Speech の voice.languageCode */
  languageCode: string;
  /** Text-to-Speech の voice.name（未定義の場合は name フィールドを送らない） */
  voiceName?: string;
  /** Text-to-Speech の voice.ssmlGender */
  gender: "NEUTRAL" | "MALE" | "FEMALE";
}

interface LanguageCodeEntry {
  /** Cloud Speech-to-Text の recognition languageCode */
  sttCode: string;
  /** Cloud Translation v2 の from/to コード */
  translationCode: string;
  /** Cloud Text-to-Speech の voice 設定 */
  tts: TtsVoiceConfig;
}

const DEFAULT_LANGUAGE_CODES: Record<SupportedLanguage, LanguageCodeEntry> = {
  "ja-JP": {
    sttCode: "ja-JP",
    translationCode: "ja",
    tts: { languageCode: "ja-JP", gender: "NEUTRAL" },
  },
  "en-US": {
    sttCode: "en-US",
    translationCode: "en",
    tts: { languageCode: "en-US", gender: "NEUTRAL" },
  },
};

/**
 * 言語コードに対応する STT languageCode を返す（デフォルト実装）。
 */
export function defaultSttCodeOf(language: SupportedLanguage): string {
  return DEFAULT_LANGUAGE_CODES[language].sttCode;
}

/**
 * 言語コードに対応する Translation v2 の from/to コードを返す（デフォルト実装）。
 * `split("-")[0]` 方式は使わない（将来 zh-CN/zh-TW 等の拡張時に簡繁を区別するため）。
 */
export function defaultTranslationCodeOf(language: SupportedLanguage): string {
  return DEFAULT_LANGUAGE_CODES[language].translationCode;
}

/**
 * 言語コードに対応する Text-to-Speech の voice 設定を返す（デフォルト実装）。
 */
export function defaultTtsVoiceConfigOf(language: SupportedLanguage): TtsVoiceConfig {
  return DEFAULT_LANGUAGE_CODES[language].tts;
}
