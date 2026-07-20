/**
 * 言語検出モード（FR-4.3・D-9）の純粋ロジック。
 *
 * `session.ts` から呼ばれる、I/O を持たない純粋関数・小さな状態ヘルパー群。
 * `utteranceBuffer.ts` の流儀（単体テスト容易性優先の純粋ロジック分離）に倣う。
 *
 * @see docs/design/gcp-integration.md 「言語検出モード（FR-4.3 の実装差分・Phase2）」
 * @see docs/design/server-design.md 「言語検出モード（FR-4.3・Phase2）」
 */
import { SUPPORTED_LANGUAGES, LANGUAGE_REGISTRY, type SupportedLanguage } from "@shared/index";
import { defaultSttCodeOf } from "../gcp/languageCodes";

/**
 * 指定した言語以外の対応言語の STT languageCode 一覧を返す。
 * `start.detectLanguage=true` 時に `SpeechStreamOptions.alternativeLanguageCodes`
 * として渡す値を生成する。
 *
 * @param current 現在の話者言語（除外対象）
 * @param resolveSttCode 言語→STT languageCode の解決関数（省略時はレジストリ既定実装）
 */
export function alternativeSttCodes(
  current: SupportedLanguage,
  resolveSttCode: (language: SupportedLanguage) => string = defaultSttCodeOf,
): string[] {
  return SUPPORTED_LANGUAGES.filter((language) => language !== current).map(resolveSttCode);
}

/**
 * STT が返す languageCode（BCP-47。大文字小文字のゆれがあり得る）を
 * `SupportedLanguage` へ正規化・解決する。
 *
 * レジストリの `sttCode` と大文字小文字を無視して比較する。一致するエントリが
 * ない場合（未対応言語の誤検出・値なし等）は `fallback`（通常は現在の話者言語）
 * をそのまま返す（fail-safe。検出失敗時は言語を変更しない）。
 */
export function resolveLanguageFromSttCode(
  sttLanguageCode: string | undefined,
  fallback: SupportedLanguage,
): SupportedLanguage {
  if (!sttLanguageCode) {
    return fallback;
  }
  const normalized = sttLanguageCode.toLowerCase();
  const entry = LANGUAGE_REGISTRY.find((e) => e.sttCode.toLowerCase() === normalized);
  return entry ? entry.code : fallback;
}

/**
 * 「最初の final で確定・以後固定」という言語検出モードの状態を管理する
 * 小さなステートヘルパー。I/O を持たない（`session.ts` が STT ラッパーの
 * `onFinal` コールバックから `handleFinal()` を呼び出す）。
 *
 * - 最初に `handleFinal()` が呼ばれた時点（＝最初の STT final 結果）でのみ
 *   判定を行い、以降の呼び出しは常に `null`（変更なし）を返す
 *   （会話中の常時再判定はしない、要件§11②）。
 * - 判定結果が現在言語と同じ場合（検出失敗のフォールバック含む）も `null` を
 *   返す（実質的な変更がなく、クライアントへの通知も不要なため）。
 */
export class LanguageDetector {
  private locked = false;

  constructor(
    private readonly currentLanguage: SupportedLanguage,
    private readonly resolve: (
      sttLanguageCode: string | undefined,
      fallback: SupportedLanguage,
    ) => SupportedLanguage = resolveLanguageFromSttCode,
  ) {}

  /** 判定確定済みかどうか（最初の final を処理済みか） */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * STT final 結果の languageCode を渡す。
   * 最初の呼び出しでのみ判定し、検出言語が現在言語と異なる場合のみその言語を
   * 返す（それ以外は null）。2回目以降の呼び出しは常に null を返す（以後固定）。
   */
  handleFinal(sttLanguageCode: string | undefined): SupportedLanguage | null {
    if (this.locked) {
      return null;
    }
    this.locked = true;

    const detected = this.resolve(sttLanguageCode, this.currentLanguage);
    if (detected === this.currentLanguage) {
      return null;
    }
    return detected;
  }
}
