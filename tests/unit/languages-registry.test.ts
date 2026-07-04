import {
  LanguageEnum,
  LANGUAGE_REGISTRY,
  SUPPORTED_LANGUAGES,
  getLanguageEntry,
} from "../../shared/languages/registry";

/**
 * shared/languages/registry.ts の単体テスト。
 *
 * MVP対象言語（ja-JP / en-US）のエントリ取得と、未対応言語コードの
 * 扱い（LanguageEnumでの拒否・getLanguageEntryでの例外）を検証する。
 */
describe("languages registry", () => {
  describe("LanguageEnum", () => {
    it("ja-JP を許可する", () => {
      expect(() => LanguageEnum.parse("ja-JP")).not.toThrow();
    });

    it("en-US を許可する", () => {
      expect(() => LanguageEnum.parse("en-US")).not.toThrow();
    });

    it("未対応の言語コード（fr-FR）を拒否する", () => {
      expect(() => LanguageEnum.parse("fr-FR")).toThrow();
    });

    it("空文字列を拒否する", () => {
      expect(() => LanguageEnum.parse("")).toThrow();
    });

    it("数値を拒否する", () => {
      expect(() => LanguageEnum.parse(123)).toThrow();
    });
  });

  describe("LANGUAGE_REGISTRY", () => {
    it("ja-JP と en-US の2言語のみを含む（MVP範囲）", () => {
      const codes = LANGUAGE_REGISTRY.map((e) => e.code);
      expect(codes).toEqual(["ja-JP", "en-US"]);
    });

    it("各エントリが必須フィールドを持つ", () => {
      for (const entry of LANGUAGE_REGISTRY) {
        expect(entry.code).toBeTruthy();
        expect(entry.label).toBeTruthy();
        expect(entry.sttCode).toBeTruthy();
        expect(entry.translationCode).toBeTruthy();
        expect(entry.ttsLanguageCode).toBeTruthy();
      }
    });

    it("ttsGender は未指定（undefined）または MALE/FEMALE のみを許容する（bd-124.4: NEUTRALは不許可）", () => {
      // 背景: Google Cloud TTS が ssmlGender: "NEUTRAL" を拒否する
      // (`INVALID_ARGUMENT: Gender neutral voices are not supported.`) ため、
      // レジストリ上で NEUTRAL を指定することを禁止する。
      for (const entry of LANGUAGE_REGISTRY) {
        expect(["MALE", "FEMALE", undefined]).toContain(entry.ttsGender);
        expect(entry.ttsGender).not.toBe("NEUTRAL");
      }
    });

    it("ja-JP と en-US の ttsGender は未指定（gender未設定）である", () => {
      const ja = LANGUAGE_REGISTRY.find((e) => e.code === "ja-JP");
      const en = LANGUAGE_REGISTRY.find((e) => e.code === "en-US");
      expect(ja?.ttsGender).toBeUndefined();
      expect(en?.ttsGender).toBeUndefined();
    });
  });

  describe("getLanguageEntry", () => {
    it("ja-JP のエントリを取得できる", () => {
      const entry = getLanguageEntry("ja-JP");
      expect(entry).toMatchObject({
        code: "ja-JP",
        label: "日本語",
        sttCode: "ja-JP",
        translationCode: "ja",
        ttsLanguageCode: "ja-JP",
      });
    });

    it("en-US のエントリを取得できる", () => {
      const entry = getLanguageEntry("en-US");
      expect(entry).toMatchObject({
        code: "en-US",
        label: "英語",
        sttCode: "en-US",
        translationCode: "en",
        ttsLanguageCode: "en-US",
      });
    });

    it("未対応の言語コードを渡すと例外を投げる", () => {
      // getLanguageEntry の型は SupportedLanguage を要求するため、
      // 未検証値が渡るケース（例: 外部入力）を想定して as で型を回避する。
      expect(() =>
        getLanguageEntry("fr-FR" as unknown as Parameters<typeof getLanguageEntry>[0]),
      ).toThrow("Unsupported language code: fr-FR");
    });
  });

  describe("SUPPORTED_LANGUAGES", () => {
    it("LANGUAGE_REGISTRY のコード一覧と一致する", () => {
      expect(SUPPORTED_LANGUAGES).toEqual(["ja-JP", "en-US"]);
    });
  });
});
