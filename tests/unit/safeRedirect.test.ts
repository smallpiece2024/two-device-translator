import { resolveSafeRedirect } from "@/lib/safeRedirect";

/**
 * resolveSafeRedirect（オープンリダイレクト対策）の単体テスト。
 *
 * @see src/lib/safeRedirect.ts
 */
describe("resolveSafeRedirect", () => {
  it("`/` で始まる単一の相対パスはそのまま返す", () => {
    expect(resolveSafeRedirect("/rooms")).toBe("/rooms");
  });

  it("クエリパラメータ付きの相対パスもそのまま返す", () => {
    expect(resolveSafeRedirect("/rooms?x=1")).toBe("/rooms?x=1");
  });

  it("undefined の場合は fallback を返す", () => {
    expect(resolveSafeRedirect(undefined)).toBe("/rooms");
  });

  it("null の場合は fallback を返す", () => {
    expect(resolveSafeRedirect(null)).toBe("/rooms");
  });

  it("空文字の場合は fallback を返す", () => {
    expect(resolveSafeRedirect("")).toBe("/rooms");
  });

  it("外部URL（絶対URL）の場合は fallback を返す", () => {
    expect(resolveSafeRedirect("https://evil.com")).toBe("/rooms");
  });

  it("プロトコル相対URL（`//`始まり）の場合は fallback を返す", () => {
    expect(resolveSafeRedirect("//evil.com")).toBe("/rooms");
  });

  it("バックスラッシュを使った擬似プロトコル相対URL（`/\\`始まり）の場合は fallback を返す", () => {
    expect(resolveSafeRedirect("/\\evil.com")).toBe("/rooms");
  });

  it("`/` で始まらないパス（相対パス扱いされない文字列）の場合は fallback を返す", () => {
    expect(resolveSafeRedirect("rooms")).toBe("/rooms");
  });

  it("カスタム fallback を指定した場合、条件を満たさない値に対してそのカスタム値を返す", () => {
    expect(resolveSafeRedirect("https://evil.com", "/history")).toBe("/history");
  });

  it("カスタム fallback を指定していても、安全なパスはそのまま返す", () => {
    expect(resolveSafeRedirect("/history/abc", "/history")).toBe("/history/abc");
  });

  describe("制御文字混入によるバイパス回帰テスト", () => {
    // コードレビューで発見された既知のバイパス手法（回帰防止）:
    // WHATWGのURLパーサはタブ・CR・LF等の制御文字を位置に関わらず除去してから
    // 解釈するため、旧実装（`startsWith("//")` 等のブラックリスト方式）では
    // `"/\t/evil.com"` のような文字列が `startsWith("//")` チェックをすり抜けた
    // 後、`new URL()` に渡された時点で `//evil.com`（プロトコル相対URL）へ
    // 正規化され外部ドメインへのオープンリダイレクトを許してしまっていた
    // （実証: `new URL("/\t/evil.com", "https://example.com")` → `https://evil.com/`）。
    // 現在の実装はホワイトリスト正規表現で制御文字・空白・バックスラッシュを
    // 許可文字集合に含めないため構造的にこの種のバイパスが発生しない。
    // このテストはその修正が再退行しないことを保証する。

    it("タブ文字を含む `\"/\\t/evil.com\"` の場合は fallback を返す", () => {
      expect(resolveSafeRedirect("/\t/evil.com")).toBe("/rooms");
    });

    it("改行(LF)を含む `\"/\\n/evil.com\"` の場合は fallback を返す", () => {
      expect(resolveSafeRedirect("/\n/evil.com")).toBe("/rooms");
    });

    it("復帰(CR)を含む `\"/\\r/evil.com\"` の場合は fallback を返す", () => {
      expect(resolveSafeRedirect("/\r/evil.com")).toBe("/rooms");
    });

    it("CRLFを含む `\"/\\r\\n/evil.com\"` の場合は fallback を返す", () => {
      expect(resolveSafeRedirect("/\r\n/evil.com")).toBe("/rooms");
    });

    it("通常の半角スペースを含むパスの場合は fallback を返す", () => {
      expect(resolveSafeRedirect("/rooms /evil.com")).toBe("/rooms");
    });

    it("パス途中に制御文字(タブ)が混入する場合も fallback を返す", () => {
      expect(resolveSafeRedirect("/rooms/\tabc")).toBe("/rooms");
    });

    it("バイパス文字列を `new URL()` に通すとプロトコル相対URLへ正規化される（脅威の実証）", () => {
      // このテスト自体はresolveSafeRedirectを呼ばず、`new URL()` の
      // 制御文字除去の挙動そのものを確認する（バイパス手法の妥当性の記録）。
      expect(new URL("/\t/evil.com", "https://example.com").href).toBe("https://evil.com/");
    });
  });
});
