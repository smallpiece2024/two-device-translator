/**
 * server/room/languageDetection.ts の単体テスト。
 *
 * 純粋関数・小さな状態ヘルパーのみで構成されるため、I/O・モック不要。
 * `utteranceBuffer.test.ts` の流儀（純粋ロジックの単体テスト）に倣う。
 *
 * @see server/room/languageDetection.ts
 */
import {
  alternativeSttCodes,
  resolveLanguageFromSttCode,
  LanguageDetector,
} from "../../server/room/languageDetection";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@shared/index";

// ---------------------------------------------------------------------------
// alternativeSttCodes()
// ---------------------------------------------------------------------------
describe("alternativeSttCodes()", () => {
  test("current='ja-JP' のとき、ja-JP以外の全対応言語のSTTコード（['en-US']）を返す", () => {
    expect(alternativeSttCodes("ja-JP")).toEqual(["en-US"]);
  });

  test("current='en-US' のとき、en-US以外の全対応言語のSTTコード（['ja-JP']）を返す", () => {
    expect(alternativeSttCodes("en-US")).toEqual(["ja-JP"]);
  });

  test("レジストリの全言語から現在言語だけが除外される（現在言語のコードを含まない）", () => {
    for (const current of SUPPORTED_LANGUAGES) {
      const result = alternativeSttCodes(current);
      expect(result.length).toBe(SUPPORTED_LANGUAGES.length - 1);
      expect(result).not.toContain(current);
    }
  });

  test("resolveSttCode を差し替えると、そのカスタム解決関数が使われる", () => {
    const resolveSttCode = jest.fn((language: SupportedLanguage) => `custom-${language}`);

    const result = alternativeSttCodes("ja-JP", resolveSttCode);

    expect(result).toEqual(["custom-en-US"]);
    // resolveSttCode は Array.prototype.map にそのまま渡されるため
    // (element, index, array) の3引数で呼ばれるが、ここでは呼び出し元が
    // 意図する第1引数（対象言語）のみを検証する（map の3引数仕様への過度な
    // 結合を避ける。実装が map 以外の手段に変わっても壊れないように）。
    expect(resolveSttCode.mock.calls[0][0]).toBe("en-US");
  });
});

// ---------------------------------------------------------------------------
// resolveLanguageFromSttCode()
// ---------------------------------------------------------------------------
describe("resolveLanguageFromSttCode()", () => {
  test("完全一致するSTTコード（'en-US'）を渡すと対応するSupportedLanguageを返す", () => {
    expect(resolveLanguageFromSttCode("en-US", "ja-JP")).toBe("en-US");
  });

  test("完全一致するSTTコード（'ja-JP'）を渡すと対応するSupportedLanguageを返す", () => {
    expect(resolveLanguageFromSttCode("ja-JP", "en-US")).toBe("ja-JP");
  });

  test("大文字小文字がゆれたSTTコード（'EN-us'）でも大文字小文字を無視して解決される", () => {
    expect(resolveLanguageFromSttCode("EN-us", "ja-JP")).toBe("en-US");
  });

  test("大文字小文字がゆれたSTTコード（'JA-JP'）でも大文字小文字を無視して解決される", () => {
    expect(resolveLanguageFromSttCode("JA-JP", "en-US")).toBe("ja-JP");
  });

  test("未対応のSTTコード（'fr-FR'）が渡された場合はfallbackをそのまま返す", () => {
    expect(resolveLanguageFromSttCode("fr-FR", "ja-JP")).toBe("ja-JP");
  });

  test("sttLanguageCodeがundefinedの場合はfallbackをそのまま返す", () => {
    expect(resolveLanguageFromSttCode(undefined, "en-US")).toBe("en-US");
  });

  test("sttLanguageCodeが空文字の場合はfallbackをそのまま返す", () => {
    expect(resolveLanguageFromSttCode("", "ja-JP")).toBe("ja-JP");
  });
});

// ---------------------------------------------------------------------------
// LanguageDetector
// ---------------------------------------------------------------------------
describe("LanguageDetector", () => {
  test("初回のhandleFinalで現在言語と異なる言語が検出された場合、その言語を返す", () => {
    const detector = new LanguageDetector("ja-JP");

    const result = detector.handleFinal("en-US");

    expect(result).toBe("en-US");
    expect(detector.isLocked).toBe(true);
  });

  test("初回のhandleFinalで現在言語と同じ言語が検出された場合はnullを返す（実質変更なし）", () => {
    const detector = new LanguageDetector("ja-JP");

    const result = detector.handleFinal("ja-JP");

    expect(result).toBeNull();
    // 「初回処理済み」としてロックはされる（以後再判定しない）
    expect(detector.isLocked).toBe(true);
  });

  test("初回のhandleFinalで解決不能（未対応コード）な場合はfallback=現在言語となりnullを返す", () => {
    const detector = new LanguageDetector("ja-JP");

    const result = detector.handleFinal("fr-FR");

    expect(result).toBeNull();
    expect(detector.isLocked).toBe(true);
  });

  test("初回のhandleFinalでlanguageCodeがundefinedの場合はfallback=現在言語となりnullを返す", () => {
    const detector = new LanguageDetector("ja-JP");

    const result = detector.handleFinal(undefined);

    expect(result).toBeNull();
    expect(detector.isLocked).toBe(true);
  });

  test("2回目以降のhandleFinalは、初回と異なる言語コードを渡しても常にnullを返す（以後固定）", () => {
    const detector = new LanguageDetector("ja-JP");

    const first = detector.handleFinal("en-US");
    expect(first).toBe("en-US");

    // 2回目: たとえ別の言語コード（誤検出やノイズ想定）が来ても再判定しない
    const second = detector.handleFinal("ja-JP");
    const third = detector.handleFinal("fr-FR");

    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(detector.isLocked).toBe(true);
  });

  test("初回で検出失敗（null）だった場合も、以後の呼び出しは再判定せず常にnullを返す", () => {
    const detector = new LanguageDetector("ja-JP");

    const first = detector.handleFinal(undefined); // fail-safe → null
    const second = detector.handleFinal("en-US"); // 本来なら検出できるはずだが再判定しない

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(detector.isLocked).toBe(true);
  });

  test("isLockedは初回handleFinal呼び出し前はfalse", () => {
    const detector = new LanguageDetector("ja-JP");

    expect(detector.isLocked).toBe(false);
  });

  test("カスタムresolve関数を注入すると、その関数の戻り値がhandleFinalの判定に使われる", () => {
    const resolve = jest.fn().mockReturnValue("en-US");
    const detector = new LanguageDetector("ja-JP", resolve);

    const result = detector.handleFinal("anything");

    expect(resolve).toHaveBeenCalledWith("anything", "ja-JP");
    expect(result).toBe("en-US");
  });
});
