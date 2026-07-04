import { SHARED_PLACEHOLDER } from "@shared/index";

describe("@shared/index エイリアス解決", () => {
  it("@shared/index パスエイリアス経由でimportでき、期待する値がexportされている", () => {
    expect(SHARED_PLACEHOLDER).toBe("shared");
  });

  it("SHARED_PLACEHOLDER はstring型のリテラルである", () => {
    expect(typeof SHARED_PLACEHOLDER).toBe("string");
  });
});
