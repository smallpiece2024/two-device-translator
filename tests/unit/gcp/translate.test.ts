/**
 * server/gcp/translate.ts の単体テスト
 *
 * Cloud Translation v2 クライアントはモックで差し替え、GCP への実通信は行わない。
 * translateText()、getTranslateClient() / setTranslateClient() / resetTranslateClient()、
 * resolveTranslationCode 注入を検証する。
 */

import {
  translateText,
  getTranslateClient,
  setTranslateClient,
  resetTranslateClient,
} from "../../../server/gcp/translate";
import { SupportedLanguage } from "../../../server/gcp/types";

// ---------------------------------------------------------------------------
// テストヘルパー: モッククライアントのファクトリ
// ---------------------------------------------------------------------------

function makeMockClient(returnValue: [string, unknown] = ["", {}]) {
  return {
    translate: jest.fn().mockResolvedValue(returnValue),
  };
}

// ---------------------------------------------------------------------------
// 各テスト後にモジュールレベルのクライアントをリセットする
// ---------------------------------------------------------------------------
afterEach(() => {
  resetTranslateClient();
});

// ---------------------------------------------------------------------------
// 1. translateText() — 翻訳結果の返却
// ---------------------------------------------------------------------------
describe("translateText() — 翻訳結果の返却", () => {
  test("モッククライアントが [訳文, metadata] を返すとき、translateText() が訳文文字列を返す", async () => {
    const mockClient = makeMockClient(["こんにちは", {}]);

    const result = await translateText("Hello", "en-US", "ja-JP", { client: mockClient as never });

    expect(result).toBe("こんにちは");
  });

  test("日本語→英語の翻訳結果が正しく返される", async () => {
    const mockClient = makeMockClient(["Good morning", {}]);

    const result = await translateText("おはようございます", "ja-JP", "en-US", {
      client: mockClient as never,
    });

    expect(result).toBe("Good morning");
  });

  test("モッククライアントが空文字列の訳文を返すとき、空文字列が返る", async () => {
    const mockClient = makeMockClient(["", {}]);

    const result = await translateText("test", "en-US", "ja-JP", { client: mockClient as never });

    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. translateText() — 空文字列・空白のみの早期リターン
// ---------------------------------------------------------------------------
describe("translateText() — 空文字列・空白のみの早期リターン", () => {
  test("空文字列 '' を渡すと、モッククライアントの translate が呼ばれず空文字列が返る", async () => {
    const mockClient = makeMockClient(["これは呼ばれない", {}]);

    const result = await translateText("", "en-US", "ja-JP", { client: mockClient as never });

    expect(result).toBe("");
    expect(mockClient.translate).not.toHaveBeenCalled();
  });

  test("空白のみ '   ' を渡すと、モッククライアントの translate が呼ばれず空文字列が返る", async () => {
    const mockClient = makeMockClient(["これは呼ばれない", {}]);

    const result = await translateText("   ", "en-US", "ja-JP", { client: mockClient as never });

    expect(result).toBe("");
    expect(mockClient.translate).not.toHaveBeenCalled();
  });

  test("タブや改行のみの文字列でも API を呼ばず空文字列が返る", async () => {
    const mockClient = makeMockClient(["これは呼ばれない", {}]);

    const result = await translateText("\t\n", "en-US", "ja-JP", { client: mockClient as never });

    expect(result).toBe("");
    expect(mockClient.translate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. translateText() — 言語コード変換（Phase1 デフォルト実装: ja-JP→ja / en-US→en）
// ---------------------------------------------------------------------------
describe("translateText() — 言語コード変換（デフォルト実装）", () => {
  test("en-US→ja-JP 指定のとき、モッククライアントに { from: 'en', to: 'ja' } で渡る", async () => {
    const mockClient = makeMockClient(["こんにちは", {}]);

    await translateText("Hello", "en-US", "ja-JP", { client: mockClient as never });

    expect(mockClient.translate).toHaveBeenCalledWith("Hello", { from: "en", to: "ja" });
  });

  test("ja-JP→en-US 指定のとき、モッククライアントに { from: 'ja', to: 'en' } で渡る", async () => {
    const mockClient = makeMockClient(["Good morning", {}]);

    await translateText("おはようございます", "ja-JP", "en-US", { client: mockClient as never });

    expect(mockClient.translate).toHaveBeenCalledWith("おはようございます", { from: "ja", to: "en" });
  });

  test("ja-JP/en-US のような長形式コードがそのまま API に渡らない（渡るのは変換後コードのみ）", async () => {
    const mockClient = makeMockClient(["translation", {}]);

    await translateText("text", "ja-JP", "en-US", { client: mockClient as never });

    const callArg = mockClient.translate.mock.calls[0][1] as { from: string; to: string };
    expect(callArg.from).not.toContain("-");
    expect(callArg.to).not.toContain("-");
  });
});

// ---------------------------------------------------------------------------
// 4. translateText() — resolveTranslationCode の関数注入
// ---------------------------------------------------------------------------
describe("translateText() — resolveTranslationCode の関数注入", () => {
  test("resolveTranslationCode を注入すると、その関数の戻り値が from/to として使用される", async () => {
    const mockClient = makeMockClient(["你好", {}]);
    const resolveTranslationCode = jest.fn((lang: SupportedLanguage) =>
      lang === "en-US" ? "en" : "zh-CN",
    );

    await translateText("Hello", "en-US", "ja-JP", {
      client: mockClient as never,
      resolveTranslationCode,
    });

    expect(resolveTranslationCode).toHaveBeenCalledWith("en-US");
    expect(resolveTranslationCode).toHaveBeenCalledWith("ja-JP");
    expect(mockClient.translate).toHaveBeenCalledWith("Hello", { from: "en", to: "zh-CN" });
  });

  test("resolveTranslationCode 未指定時は Phase1 デフォルトの変換表が使用される", async () => {
    const mockClient = makeMockClient(["Hello", {}]);

    await translateText("こんにちは", "ja-JP", "en-US", { client: mockClient as never });

    expect(mockClient.translate).toHaveBeenCalledWith("こんにちは", { from: "ja", to: "en" });
  });
});

// ---------------------------------------------------------------------------
// 5. translateText() — API 呼び出しパラメータ（text が正しく渡ること）
// ---------------------------------------------------------------------------
describe("translateText() — API 呼び出しパラメータ", () => {
  test("翻訳対象のテキストがモッククライアントの第1引数として正しく渡る", async () => {
    const mockClient = makeMockClient(["result", {}]);
    const inputText = "This is a test sentence.";

    await translateText(inputText, "en-US", "ja-JP", { client: mockClient as never });

    expect(mockClient.translate).toHaveBeenCalledWith(inputText, expect.any(Object));
  });

  test("日本語テキストもそのまま第1引数として渡る", async () => {
    const mockClient = makeMockClient(["result", {}]);
    const inputText = "これはテストの文章です。";

    await translateText(inputText, "ja-JP", "en-US", { client: mockClient as never });

    expect(mockClient.translate).toHaveBeenCalledWith(inputText, expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// 6. translateText() — エラー伝播・サニタイズ
// ---------------------------------------------------------------------------
describe("translateText() — エラー伝播・サニタイズ", () => {
  test("モッククライアントの translate が reject すると、translateText() が例外を投げる", async () => {
    const mockClient = {
      translate: jest.fn().mockRejectedValue(new Error("GCP internal error details")),
    };

    await expect(
      translateText("Hello", "en-US", "ja-JP", { client: mockClient as never }),
    ).rejects.toThrow();
  });

  test("GCP の内部詳細メッセージがそのまま外部に漏れず、汎用メッセージで包まれる", async () => {
    const gcpInternalError = new Error(
      "PERMISSION_DENIED: Cloud Translation API has not been used in project xyz before",
    );
    const mockClient = {
      translate: jest.fn().mockRejectedValue(gcpInternalError),
    };

    let thrownError: Error | undefined;
    try {
      await translateText("Hello", "en-US", "ja-JP", { client: mockClient as never });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toBe(
      "PERMISSION_DENIED: Cloud Translation API has not been used in project xyz before",
    );
    expect(thrownError!.message).toBe("Translation failed. Please try again.");
  });

  test("モッククライアントが文字列エラーで reject しても汎用メッセージの例外が投げられる", async () => {
    const mockClient = {
      translate: jest.fn().mockRejectedValue("some string error"),
    };

    await expect(
      translateText("Hello", "en-US", "ja-JP", { client: mockClient as never }),
    ).rejects.toThrow("Translation failed. Please try again.");
  });
});

// ---------------------------------------------------------------------------
// 7. setTranslateClient() / getTranslateClient() / resetTranslateClient() — シングルトン制御
// ---------------------------------------------------------------------------
describe("setTranslateClient() / getTranslateClient() / resetTranslateClient() — シングルトン制御", () => {
  test("setTranslateClient() で差し替えたクライアントが getTranslateClient() で取得できる", () => {
    const mockClient = makeMockClient();

    setTranslateClient(mockClient as never);

    expect(getTranslateClient()).toBe(mockClient);
  });

  test("getTranslateClient() を2回呼んでも同一インスタンスが返る（シングルトン）", () => {
    const mockClient = makeMockClient();
    setTranslateClient(mockClient as never);

    const first = getTranslateClient();
    const second = getTranslateClient();

    expect(first).toBe(second);
  });

  test("resetTranslateClient() 後に setTranslateClient() で別のクライアントに差し替えられる", () => {
    const firstMock = makeMockClient(["first result", {}]);
    const secondMock = makeMockClient(["second result", {}]);
    setTranslateClient(firstMock as never);

    resetTranslateClient();
    setTranslateClient(secondMock as never);

    expect(getTranslateClient()).toBe(secondMock);
    expect(getTranslateClient()).not.toBe(firstMock);
  });

  test("setTranslateClient() で差し替えたモックが translateText() 呼び出し時に使用される（client 未指定時）", async () => {
    const mockClient = makeMockClient(["モジュールレベルの差し替え結果", {}]);
    setTranslateClient(mockClient as never);

    const result = await translateText("Hello", "en-US", "ja-JP");

    expect(result).toBe("モジュールレベルの差し替え結果");
    expect(mockClient.translate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. 遅延初期化: モジュール import だけでは Translate クライアントが生成されないこと
// ---------------------------------------------------------------------------
describe("遅延初期化 — モジュール読み込みだけでは Translate クライアントを生成しない", () => {
  test("jest.isolateModules でモジュールを再読込しても、getTranslateClient() を呼ぶまでは new v2.Translate() が実行されない", () => {
    jest.isolateModules(() => {
      jest.doMock("@google-cloud/translate", () => {
        const actual = jest.requireActual("@google-cloud/translate");
        return {
          ...actual,
          v2: {
            ...actual.v2,
            Translate: jest.fn().mockImplementation(() => ({
              translate: jest.fn(),
            })),
          },
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const translateModule = require("../../../server/gcp/translate");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { v2 } = require("@google-cloud/translate");

      expect(v2.Translate).not.toHaveBeenCalled();

      translateModule.getTranslateClient();
      expect(v2.Translate).toHaveBeenCalledTimes(1);

      translateModule.resetTranslateClient();
    });
  });
});
