/**
 * 言語レジストリ（多言語対応の基盤）
 *
 * 1エントリ＝1言語で各APIの言語コードを一元管理する。
 * `code` が WSプロトコル上の正本（`LanguageEnum` の集合と一致させる）。
 * STT / Translation / TTS 用のコードは `code` から導出せず、必ずこのレジストリの
 * 該当フィールドを引くこと（docs/design/gcp-integration.md 参照）。
 *
 * 依存は zod のみ（shared/ の制約）。
 */
import { z } from "zod";

/** WSプロトコル上でサポートする言語コード（MVP = 日本語・英語）。追加時はここに拡張する。 */
export const LanguageEnum = z.enum(["ja-JP", "en-US"]);

export type SupportedLanguage = z.infer<typeof LanguageEnum>;

export interface LanguageEntry {
  /** protocolコード（BCP-47, 例 "ja-JP"）。WSメッセージの正本 */
  code: SupportedLanguage;
  /** UI表示名（例 "日本語"） */
  label: string;
  /** Speech-to-Text recognition languageCode */
  sttCode: string;
  /** Translation v2 の from/to コード */
  translationCode: string;
  /** Text-to-Speech voice.languageCode */
  ttsLanguageCode: string;
  /** Text-to-Speech voice.name（候補。存在しなければフォールバック） */
  ttsVoiceName?: string;
  ttsGender: "NEUTRAL" | "MALE" | "FEMALE";
}

export const LANGUAGE_REGISTRY: readonly LanguageEntry[] = [
  {
    code: "ja-JP",
    label: "日本語",
    sttCode: "ja-JP",
    translationCode: "ja",
    ttsLanguageCode: "ja-JP",
    ttsVoiceName: "ja-JP-Neural2-B",
    ttsGender: "NEUTRAL",
  },
  {
    code: "en-US",
    label: "英語",
    sttCode: "en-US",
    translationCode: "en",
    ttsLanguageCode: "en-US",
    ttsVoiceName: "en-US-Neural2-C",
    ttsGender: "NEUTRAL",
  },
] as const;

/**
 * 指定した言語コードのレジストリエントリを取得する。
 * 未対応の言語コードが渡された場合は例外を投げる（呼び出し側は事前に
 * `LanguageEnum` でバリデーション済みであることを前提とする）。
 */
export function getLanguageEntry(code: SupportedLanguage): LanguageEntry {
  const entry = LANGUAGE_REGISTRY.find((e) => e.code === code);
  if (!entry) {
    throw new Error(`Unsupported language code: ${code}`);
  }
  return entry;
}

/** レジストリに登録済みの全言語コード一覧 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] =
  LANGUAGE_REGISTRY.map((e) => e.code);
