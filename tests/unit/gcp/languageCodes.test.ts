/**
 * server/gcp/languageCodes.ts の単体テスト
 *
 * Phase1 用の最小言語コード変換テーブル（ja-JP / en-US 固定）を検証する。
 */

import {
  defaultSttCodeOf,
  defaultTranslationCodeOf,
  defaultTtsVoiceConfigOf,
} from "../../../server/gcp/languageCodes";

describe("defaultSttCodeOf()", () => {
  test("ja-JP は STT コード 'ja-JP' を返す", () => {
    expect(defaultSttCodeOf("ja-JP")).toBe("ja-JP");
  });

  test("en-US は STT コード 'en-US' を返す", () => {
    expect(defaultSttCodeOf("en-US")).toBe("en-US");
  });
});

describe("defaultTranslationCodeOf()", () => {
  test("ja-JP は Translation コード 'ja' を返す（2文字化される）", () => {
    expect(defaultTranslationCodeOf("ja-JP")).toBe("ja");
  });

  test("en-US は Translation コード 'en' を返す（2文字化される）", () => {
    expect(defaultTranslationCodeOf("en-US")).toBe("en");
  });
});

describe("defaultTtsVoiceConfigOf()", () => {
  test("ja-JP の voice 設定は { languageCode: 'ja-JP', gender: 'NEUTRAL' } で voiceName が未定義", () => {
    const config = defaultTtsVoiceConfigOf("ja-JP");
    expect(config.languageCode).toBe("ja-JP");
    expect(config.gender).toBe("NEUTRAL");
    expect(config.voiceName).toBeUndefined();
  });

  test("en-US の voice 設定は { languageCode: 'en-US', gender: 'NEUTRAL' } で voiceName が未定義", () => {
    const config = defaultTtsVoiceConfigOf("en-US");
    expect(config.languageCode).toBe("en-US");
    expect(config.gender).toBe("NEUTRAL");
    expect(config.voiceName).toBeUndefined();
  });

  test("ja-JP と en-US で languageCode が異なる", () => {
    const ja = defaultTtsVoiceConfigOf("ja-JP");
    const en = defaultTtsVoiceConfigOf("en-US");
    expect(ja.languageCode).not.toBe(en.languageCode);
  });
});
