/**
 * server/gcp/mockGcp.ts の単体テスト（bd-713 コードレビュー指摘: テスト追加）。
 *
 * E2E テスト専用の決定的モック GCP 実装（createMockSpeechStream /
 * mockTranslateText / mockSynthesizeSpeechToBase64）の仕様を検証する。
 * 実 GCP API は一切呼ばない（このモジュール自体が実 API を呼ばない実装）。
 */
import {
  createMockSpeechStream,
  mockTranslateText,
  mockSynthesizeSpeechToBase64,
} from "../../../server/gcp/mockGcp";
import type { SpeechStreamOptions } from "../../../server/gcp/speechStream";

// ---------------------------------------------------------------------------
// テストヘルパー
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<SpeechStreamOptions> = {}): SpeechStreamOptions {
  return {
    languageCode: "ja-JP",
    onInterim: jest.fn(),
    onFinal: jest.fn(),
    onError: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. createMockSpeechStream() — write() 呼び出し回数に基づく発火
// ---------------------------------------------------------------------------
describe("createMockSpeechStream() — write() 回数に基づく onInterim / onFinal 発火", () => {
  test("1回目の write() では onInterim / onFinal のいずれも発火しない", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.write(Buffer.from("chunk1"));

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("2回目の write() で onInterim が1回だけ発火する（onFinal は発火しない）", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.write(Buffer.from("chunk1"));
    handle.write(Buffer.from("chunk2"));

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("3回目の write() では追加の発火が起きない（onInterimは2回目の1回のみ、onFinalはまだ0回）", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.write(Buffer.from("chunk1"));
    handle.write(Buffer.from("chunk2"));
    handle.write(Buffer.from("chunk3"));

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("4回目の write() で onFinal が1回だけ発火する", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.write(Buffer.from("chunk1"));
    handle.write(Buffer.from("chunk2"));
    handle.write(Buffer.from("chunk3"));
    handle.write(Buffer.from("chunk4"));

    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  test("5回目以降の write() では onFinal が再発火しない（1回のみ）", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    for (let i = 0; i < 8; i += 1) {
      handle.write(Buffer.from(`chunk${i}`));
    }

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onInterim).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. createMockSpeechStream() — 言語コードごとの固定フレーズ
// ---------------------------------------------------------------------------
describe("createMockSpeechStream() — 言語コードごとの固定 final フレーズ", () => {
  test("languageCode='ja-JP' の final フレーズは「こんにちは、これはテストです」", () => {
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ languageCode: "ja-JP", onFinal }));

    for (let i = 0; i < 4; i += 1) {
      handle.write(Buffer.from("x"));
    }

    expect(onFinal).toHaveBeenCalledWith("こんにちは、これはテストです");
  });

  test("languageCode='en-US' の final フレーズは「Hello, this is a test」", () => {
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ languageCode: "en-US", onFinal }));

    for (let i = 0; i < 4; i += 1) {
      handle.write(Buffer.from("x"));
    }

    expect(onFinal).toHaveBeenCalledWith("Hello, this is a test");
  });

  test("未登録の languageCode の場合は `Mock utterance (${languageCode})` になる", () => {
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ languageCode: "fr-FR", onFinal }));

    for (let i = 0; i < 4; i += 1) {
      handle.write(Buffer.from("x"));
    }

    expect(onFinal).toHaveBeenCalledWith("Mock utterance (fr-FR)");
  });

  test("onInterim のフレーズは onFinal のフレーズと異なる文字列になる（final全文と区別できる）", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ languageCode: "ja-JP", onInterim, onFinal }));

    handle.write(Buffer.from("x"));
    handle.write(Buffer.from("x"));
    handle.write(Buffer.from("x"));
    handle.write(Buffer.from("x"));

    const interimText = onInterim.mock.calls[0][0] as string;
    const finalText = onFinal.mock.calls[0][0] as string;
    expect(interimText).not.toBe(finalText);
    expect(interimText.length).toBeGreaterThan(0);
    expect(interimText.length).toBeLessThan(finalText.length);
  });
});

// ---------------------------------------------------------------------------
// 3. createMockSpeechStream() — end() / destroy() 後の発火停止
// ---------------------------------------------------------------------------
describe("createMockSpeechStream() — end() / destroy() 後は以降のコールバックが発火しない", () => {
  test("end() 呼び出し後に write() してもコールバックが発火しない", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.end();
    for (let i = 0; i < 5; i += 1) {
      handle.write(Buffer.from("x"));
    }

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("destroy() 呼び出し後に write() してもコールバックが発火しない", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.destroy();
    for (let i = 0; i < 5; i += 1) {
      handle.write(Buffer.from("x"));
    }

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("2回目のwrite（onInterim発火直前）でend()すると、以降のwriteでonInterimが発火しない", () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const handle = createMockSpeechStream(makeOptions({ onInterim, onFinal }));

    handle.write(Buffer.from("x")); // 1回目
    handle.end();
    handle.write(Buffer.from("x")); // 本来2回目相当だが end() 済みのため発火しない
    handle.write(Buffer.from("x"));
    handle.write(Buffer.from("x"));

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("end() / destroy() を呼んでも例外を投げない", () => {
    const handle = createMockSpeechStream(makeOptions());

    expect(() => {
      handle.end();
      handle.destroy();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. mockTranslateText()
// ---------------------------------------------------------------------------
describe("mockTranslateText() — 決定的な固定フォーマット翻訳", () => {
  test("`[${targetLanguage}] ${text}` 形式の文字列を返す", async () => {
    const result = await mockTranslateText("こんにちは", "ja-JP", "en-US");

    expect(result).toBe("[en-US] こんにちは");
  });

  test("targetLanguage が変わればプレフィックスも変わる", async () => {
    const result = await mockTranslateText("hello", "en-US", "ja-JP");

    expect(result).toBe("[ja-JP] hello");
  });

  test("sourceLanguage はフォーマットに影響しない（同一text/targetで同じ結果）", async () => {
    const resultFromJa = await mockTranslateText("hello", "ja-JP", "en-US");
    const resultFromEn = await mockTranslateText("hello", "en-US", "en-US");

    expect(resultFromJa).toBe("[en-US] hello");
    expect(resultFromEn).toBe("[en-US] hello");
  });

  test("同一入力に対して常に同一の結果を返す（決定性）", async () => {
    const first = await mockTranslateText("テスト", "ja-JP", "en-US");
    const second = await mockTranslateText("テスト", "ja-JP", "en-US");

    expect(first).toBe(second);
  });

  test("空文字列を渡すと空文字列を返す（[target] プレフィックスを付けない）", async () => {
    const result = await mockTranslateText("", "ja-JP", "en-US");

    expect(result).toBe("");
  });

  test("空白のみの文字列を渡すと空文字列を返す（trim後空文字列扱い）", async () => {
    const result = await mockTranslateText("   ", "ja-JP", "en-US");

    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. mockSynthesizeSpeechToBase64()
// ---------------------------------------------------------------------------
describe("mockSynthesizeSpeechToBase64() — 決定的な固定音声合成", () => {
  let originalEnableTts: string | undefined;

  beforeEach(() => {
    originalEnableTts = process.env.ENABLE_TTS;
  });

  afterEach(() => {
    if (originalEnableTts === undefined) {
      delete process.env.ENABLE_TTS;
    } else {
      process.env.ENABLE_TTS = originalEnableTts;
    }
  });

  test("有効な base64 文字列を返す", async () => {
    delete process.env.ENABLE_TTS;

    const result = await mockSynthesizeSpeechToBase64("hello", "en-US");

    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    // 有効な base64 であること（デコードして例外が出ない・長さが0でない）
    const decoded = Buffer.from(result as string, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    // base64 として re-encode すると同じ文字列に戻ることで妥当な base64 であることを確認する
    expect(decoded.toString("base64")).toBe(result);
  });

  test("同一入力に対して常に同一の base64 文字列を返す（決定性）", async () => {
    delete process.env.ENABLE_TTS;

    const first = await mockSynthesizeSpeechToBase64("hello", "en-US");
    const second = await mockSynthesizeSpeechToBase64("hello", "en-US");

    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  test("テキスト・言語が異なっても常に同一の固定 base64 文字列を返す（内容に依存しない）", async () => {
    delete process.env.ENABLE_TTS;

    const resultA = await mockSynthesizeSpeechToBase64("こんにちは", "ja-JP");
    const resultB = await mockSynthesizeSpeechToBase64("something else entirely", "en-US");

    expect(resultA).toBe(resultB);
  });

  test("ENABLE_TTS='false' のとき null を返す", async () => {
    process.env.ENABLE_TTS = "false";

    const result = await mockSynthesizeSpeechToBase64("hello", "en-US");

    expect(result).toBeNull();
  });

  test("ENABLE_TTS が未設定のとき null 以外（合成される）", async () => {
    delete process.env.ENABLE_TTS;

    const result = await mockSynthesizeSpeechToBase64("hello", "en-US");

    expect(result).not.toBeNull();
  });

  test("空文字列を渡すと null を返す（ENABLE_TTSに関わらず）", async () => {
    delete process.env.ENABLE_TTS;

    const result = await mockSynthesizeSpeechToBase64("", "en-US");

    expect(result).toBeNull();
  });

  test("空白のみの文字列を渡すと null を返す", async () => {
    delete process.env.ENABLE_TTS;

    const result = await mockSynthesizeSpeechToBase64("   ", "ja-JP");

    expect(result).toBeNull();
  });
});
