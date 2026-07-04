import { v2 } from "@google-cloud/translate";
import { SupportedLanguage } from "./types";
import { defaultTranslationCodeOf } from "./languageCodes";

// ============================================================
// Cloud Translation v2 Basic ラッパー
// ============================================================

/**
 * モジュールレベルのシングルトン Translate クライアント。
 * サーバープロセス起動時に1度だけ生成して使い回す。
 *
 * モジュール import だけでは生成しない（テスト容易性のため）。
 * テスト時は setTranslateClient() でモックに差し替え可能。
 */
let _translateClient: v2.Translate | null = null;

/**
 * Translate クライアントを返す（遅延初期化）。
 *
 * @returns v2.Translate インスタンス
 */
export function getTranslateClient(): v2.Translate {
  if (_translateClient === null) {
    _translateClient = new v2.Translate({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  }
  return _translateClient;
}

/**
 * テスト用: Translate クライアントを差し替える。
 * テスト終了後に resetTranslateClient() で元に戻すこと。
 *
 * @param client モック Translate インスタンス
 */
export function setTranslateClient(client: v2.Translate): void {
  _translateClient = client;
}

/**
 * テスト用: Translate クライアントをリセットする（null に戻す）。
 */
export function resetTranslateClient(): void {
  _translateClient = null;
}

// ============================================================
// 翻訳関数
// ============================================================

export interface TranslateOptions {
  /** テスト用クライアント注入（省略時はシングルトンを使用） */
  client?: v2.Translate;
  /**
   * 言語コード（SupportedLanguage）を Translation v2 の from/to コードへ解決する関数。
   * 省略時は `server/gcp/languageCodes.ts` の Phase1 用デフォルト実装を使う。
   * `shared/languages` のレジストリ実装後は、この引数にレジストリ由来の関数を
   * 注入することで差し替えられる（TODO コメントではなく関数注入で吸収する）。
   */
  resolveTranslationCode?: (language: SupportedLanguage) => string;
}

/**
 * テキストを翻訳する。
 *
 * - 空文字列（または空白のみ）を渡した場合は API を呼ばずに空文字列を返す。
 * - 言語コードは SupportedLanguage 型で受け取り、`resolveTranslationCode`
 *   （既定は Phase1 用の変換表）を通して Translation API の from/to へ変換する
 *   （`split("-")[0]` 方式は使わない。将来の多言語拡張時の簡繁区別のため）。
 *
 * @param text 翻訳対象のテキスト
 * @param sourceLanguage 翻訳元言語
 * @param targetLanguage 翻訳先言語
 * @param options client / resolveTranslationCode の注入用オプション
 * @returns 翻訳結果テキスト
 */
export async function translateText(
  text: string,
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
  options: TranslateOptions = {},
): Promise<string> {
  // 空文字列・空白のみの場合は早期リターン（API呼び出しなし）
  if (text.trim().length === 0) {
    return "";
  }

  const { client, resolveTranslationCode = defaultTranslationCodeOf } = options;
  const translateClient = client ?? getTranslateClient();

  const from = resolveTranslationCode(sourceLanguage);
  const to = resolveTranslationCode(targetLanguage);

  try {
    const [translated] = await translateClient.translate(text, {
      from,
      to,
    });
    return translated;
  } catch (err) {
    // GCP の内部詳細やスタックトレースをそのまま流さない
    const message = err instanceof Error ? err.message : String(err);
    console.error("[translate] Translation API error:", message);
    throw new Error("Translation failed. Please try again.");
  }
}
