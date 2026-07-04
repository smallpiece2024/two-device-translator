import { SupportedLanguage } from "./types";
import { getLanguageEntry } from "@shared/index";

/**
 * `shared/languages/registry.ts`（言語レジストリ）を正本として、
 * STT / Translation / TTS 用の言語コードを解決するアダプタ層。
 *
 * `translate.ts` / `textToSpeech.ts` / `speechStream.ts` はここの関数を
 * デフォルト実装として使いつつ、`resolveTranslationCode` / `resolveTtsVoiceConfig`
 * 等のオプション引数で差し替え可能にしている（テスト・将来の多言語拡張向け）。
 */

export interface TtsVoiceConfig {
  /** Text-to-Speech の voice.languageCode */
  languageCode: string;
  /** Text-to-Speech の voice.name（未定義の場合は name フィールドを送らない） */
  voiceName?: string;
  /** Text-to-Speech の voice.ssmlGender（未定義の場合は ssmlGender フィールドを送らない） */
  gender?: "MALE" | "FEMALE";
}

/**
 * 言語コードに対応する STT languageCode を返す（デフォルト実装）。
 * レジストリの `sttCode` を引く。
 */
export function defaultSttCodeOf(language: SupportedLanguage): string {
  return getLanguageEntry(language).sttCode;
}

/**
 * 言語コードに対応する Translation v2 の from/to コードを返す（デフォルト実装）。
 * レジストリの `translationCode` を引く（`split("-")[0]` 方式は使わない。
 * 将来 zh-CN/zh-TW 等の拡張時に簡繁を区別するため）。
 */
export function defaultTranslationCodeOf(language: SupportedLanguage): string {
  return getLanguageEntry(language).translationCode;
}

/**
 * 言語コードに対応する Text-to-Speech の voice 設定を返す（デフォルト実装）。
 *
 * レジストリの `ttsLanguageCode` / `ttsGender` を引く。`ttsVoiceName` は
 * レジストリ上は候補として定義されているが、ここでは意図的に voice.name を
 * 含めない（未検証の名前を渡すと本番で TTS 呼び出しが失敗しうるため）。
 *
 * `docs/design/gcp-integration.md`「TTSボイス名の検証方針」が要求する
 * `listVoices()` による実在検証は `server/gcp/textToSpeech.ts` の
 * `verifyTtsVoices()` が担い、`synthesizeSpeechToBase64()` 側で検証済み
 * ボイス名をこの関数の戻り値へマージしてから使用する
 * （検証失敗時はここでの languageCode+gender のみへフォールバックする）。
 */
export function defaultTtsVoiceConfigOf(language: SupportedLanguage): TtsVoiceConfig {
  const entry = getLanguageEntry(language);
  if (entry.ttsGender === undefined) {
    return {
      languageCode: entry.ttsLanguageCode,
    };
  }
  return {
    languageCode: entry.ttsLanguageCode,
    gender: entry.ttsGender,
  };
}
