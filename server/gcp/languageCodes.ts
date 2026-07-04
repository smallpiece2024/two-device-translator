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
  /** Text-to-Speech の voice.ssmlGender */
  gender: "NEUTRAL" | "MALE" | "FEMALE";
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
 * レジストリ上は候補として定義されているが、
 * `docs/design/gcp-integration.md`「TTSボイス名の検証方針」が要求する
 * `listVoices()` による実在検証（サーバー起動時のフォールバック解決）が
 * 未実装であるため、ここではデフォルトとして voice.name を指定しない
 * （未検証の名前を渡すと本番で TTS 呼び出しが失敗しうるため）。
 * 検証済みボイス名を使いたい場合は `resolveTtsVoiceConfig` オプションへ
 * 差し替え実装を注入すること。
 */
export function defaultTtsVoiceConfigOf(language: SupportedLanguage): TtsVoiceConfig {
  const entry = getLanguageEntry(language);
  return {
    languageCode: entry.ttsLanguageCode,
    gender: entry.ttsGender,
  };
}
