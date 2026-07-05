/**
 * server/gcp/textToSpeech.ts の単体テスト
 *
 * Cloud Text-to-Speech クライアントはモックで差し替え、GCP への実通信は行わない。
 * synthesizeSpeechToBase64()、isTtsEnabled()、getTtsClient() / setTtsClient() /
 * resetTtsClient()、resolveTtsVoiceConfig 注入を検証する。
 */

import {
  synthesizeSpeechToBase64,
  isTtsEnabled,
  getTtsClient,
  setTtsClient,
  resetTtsClient,
  verifyTtsVoices,
  resetVerifiedTtsVoices,
} from "../../../server/gcp/textToSpeech";
import { SupportedLanguage } from "../../../server/gcp/types";
import { TtsVoiceConfig } from "../../../server/gcp/languageCodes";

// ---------------------------------------------------------------------------
// テストヘルパー: モッククライアントのファクトリ
// ---------------------------------------------------------------------------

function makeMockClient(
  audioContent: Uint8Array | Buffer | string | null = new Uint8Array([1, 2, 3]),
) {
  return {
    synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent }]),
  };
}

// ---------------------------------------------------------------------------
// 各テスト後にモジュールレベルのクライアントと env をリセットする
// ---------------------------------------------------------------------------
let originalEnableTts: string | undefined;

beforeEach(() => {
  originalEnableTts = process.env.ENABLE_TTS;
});

afterEach(() => {
  resetTtsClient();
  resetVerifiedTtsVoices();
  if (originalEnableTts === undefined) {
    delete process.env.ENABLE_TTS;
  } else {
    process.env.ENABLE_TTS = originalEnableTts;
  }
});

// ---------------------------------------------------------------------------
// 1. synthesizeSpeechToBase64() — 合成結果の返却
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — 合成結果の返却", () => {
  test("Uint8Array の audioContent が返ったとき、対応する base64 文字列を返す", async () => {
    delete process.env.ENABLE_TTS;
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello" のバイト列
    const mockClient = makeMockClient(bytes);

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).not.toBeNull();
    const decoded = Buffer.from(result!, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  test("Buffer の audioContent が返ったとき、対応する base64 文字列を返す", async () => {
    delete process.env.ENABLE_TTS;
    const buf = Buffer.from([10, 20, 30, 40, 50]);
    const mockClient = makeMockClient(buf);

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).not.toBeNull();
    const decoded = Buffer.from(result!, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(buf));
  });

  test("base64 デコード後のバイト列が元のバイト列と完全に一致する", async () => {
    delete process.env.ENABLE_TTS;
    const original = new Uint8Array([0xff, 0x00, 0x80, 0x40, 0x20]);
    const mockClient = makeMockClient(original);

    const base64Result = await synthesizeSpeechToBase64("test", "ja-JP", {
      client: mockClient as never,
    });

    expect(base64Result).not.toBeNull();
    const restored = Buffer.from(base64Result!, "base64");
    expect(Array.from(restored)).toEqual(Array.from(original));
  });
});

// ---------------------------------------------------------------------------
// 2. synthesizeSpeechToBase64() — MP3 / audioConfig の検証
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — MP3 / audioConfig の検証", () => {
  test("synthesizeSpeech が audioConfig.audioEncoding === 'MP3' で呼ばれる", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(mockClient.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        audioConfig: expect.objectContaining({
          audioEncoding: "MP3",
        }),
      }),
    );
  });

  test("synthesizeSpeech の呼び出し引数に input.text が正しく含まれる", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();
    const inputText = "こんにちは";

    await synthesizeSpeechToBase64(inputText, "ja-JP", { client: mockClient as never });

    expect(mockClient.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { text: inputText },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. synthesizeSpeechToBase64() — 言語→voice設定（Phase1 デフォルト実装）
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — 言語→voice設定（デフォルト実装）", () => {
  test("'en-US' を渡すと voice.languageCode が 'en-US'、name / ssmlGender フィールドは存在しない", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { languageCode: string; ssmlGender?: string; name?: string };
    };
    expect(callArg.voice.languageCode).toBe("en-US");
    // bd-124.4: レジストリの ttsGender が未指定（gender未設定）の言語では、
    // voice に ssmlGender フィールド自体を含めない（GCP TTS は
    // ssmlGender: "NEUTRAL" を拒否するため）。
    expect(Object.hasOwn(callArg.voice, "ssmlGender")).toBe(false);
    expect(Object.hasOwn(callArg.voice, "name")).toBe(false);
  });

  test("'ja-JP' を渡すと voice.languageCode が 'ja-JP'、name / ssmlGender フィールドは存在しない", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("こんにちは", "ja-JP", { client: mockClient as never });

    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { languageCode: string; ssmlGender?: string; name?: string };
    };
    expect(callArg.voice.languageCode).toBe("ja-JP");
    // bd-124.4: レジストリの ttsGender が未指定（gender未設定）の言語では、
    // voice に ssmlGender フィールド自体を含めない（GCP TTS は
    // ssmlGender: "NEUTRAL" を拒否するため）。
    expect(Object.hasOwn(callArg.voice, "ssmlGender")).toBe(false);
    expect(Object.hasOwn(callArg.voice, "name")).toBe(false);
  });

  test("bd-124.4 回帰テスト: デフォルト設定での synthesize リクエストには ssmlGender が含まれず、languageCode のみが正しく渡る", async () => {
    // 背景: 実機で Google Cloud TTS が ssmlGender: "NEUTRAL" を拒否する
    // (`INVALID_ARGUMENT: Gender neutral voices are not supported.`) バグが
    // 発見された。registry の ttsGender: "NEUTRAL" がデフォルト経路
    // (defaultTtsVoiceConfigOf → synthesize) を通じて常にAPIエラーを
    // 引き起こしていたため、gender未指定時は ssmlGender フィールド自体を
    // 送らない仕様に修正した。この回帰を検知する。
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello world", "en-US", { client: mockClient as never });

    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: Record<string, unknown>;
    };
    expect(callArg.voice).toEqual({ languageCode: "en-US" });
    expect(JSON.stringify(callArg.voice)).not.toContain("NEUTRAL");
  });
});

// ---------------------------------------------------------------------------
// 4. synthesizeSpeechToBase64() — resolveTtsVoiceConfig の関数注入
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — resolveTtsVoiceConfig の関数注入", () => {
  test("resolveTtsVoiceConfig を注入すると、voiceName を含む voice 設定が API に渡る", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();
    const resolveTtsVoiceConfig = jest.fn(
      (): TtsVoiceConfig => ({
        languageCode: "cmn-CN",
        voiceName: "cmn-CN-Wavenet-A",
        gender: "FEMALE",
      }),
    );

    await synthesizeSpeechToBase64("你好", "en-US" as SupportedLanguage, {
      client: mockClient as never,
      resolveTtsVoiceConfig,
    });

    expect(resolveTtsVoiceConfig).toHaveBeenCalledWith("en-US");
    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { languageCode: string; ssmlGender: string; name?: string };
    };
    expect(callArg.voice).toEqual({
      languageCode: "cmn-CN",
      ssmlGender: "FEMALE",
      name: "cmn-CN-Wavenet-A",
    });
  });

  test("resolveTtsVoiceConfig 未指定時は Phase1 デフォルトの変換表が使用される", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { languageCode: string };
    };
    expect(callArg.voice.languageCode).toBe("en-US");
  });
});

// ---------------------------------------------------------------------------
// 5. synthesizeSpeechToBase64() — ENABLE_TTS=false でスキップ
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — ENABLE_TTS=false でスキップ", () => {
  test("ENABLE_TTS='false' のとき null を返す", async () => {
    process.env.ENABLE_TTS = "false";
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).toBeNull();
  });

  test("ENABLE_TTS='false' のとき synthesizeSpeech が呼ばれない", async () => {
    process.env.ENABLE_TTS = "false";
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(mockClient.synthesizeSpeech).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. synthesizeSpeechToBase64() — ENABLE_TTS デフォルト（未設定）
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — ENABLE_TTS 未設定（デフォルト有効）", () => {
  test("ENABLE_TTS が未設定のとき null でない値を返す（合成が実行される）", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).not.toBeNull();
  });

  test("ENABLE_TTS が未設定のとき synthesizeSpeech が1回呼ばれる", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(mockClient.synthesizeSpeech).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. isTtsEnabled() / ENABLE_TTS その他の値
// ---------------------------------------------------------------------------
describe("isTtsEnabled() — 単体検証", () => {
  test("ENABLE_TTS が未設定のとき isTtsEnabled() は true を返す", () => {
    delete process.env.ENABLE_TTS;
    expect(isTtsEnabled()).toBe(true);
  });

  test("ENABLE_TTS='false' のとき isTtsEnabled() は false を返す", () => {
    process.env.ENABLE_TTS = "false";
    expect(isTtsEnabled()).toBe(false);
  });

  test("ENABLE_TTS='0' のとき isTtsEnabled() は true を返す（'false' 以外は有効）", () => {
    process.env.ENABLE_TTS = "0";
    expect(isTtsEnabled()).toBe(true);
  });

  test("ENABLE_TTS='true' のとき isTtsEnabled() は true を返す", () => {
    process.env.ENABLE_TTS = "true";
    expect(isTtsEnabled()).toBe(true);
  });

  test("ENABLE_TTS='' (空文字列) のとき isTtsEnabled() は true を返す（'false' 以外は有効）", () => {
    process.env.ENABLE_TTS = "";
    expect(isTtsEnabled()).toBe(true);
  });

  test("ENABLE_TTS='False'（大文字混じり）のとき isTtsEnabled() は true を返す（厳密一致）", () => {
    process.env.ENABLE_TTS = "False";
    expect(isTtsEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. synthesizeSpeechToBase64() — 空テキストのスキップ
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — 空テキストのスキップ", () => {
  test("空文字列 '' を渡すと synthesizeSpeech が呼ばれず null を返す", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("", "en-US", { client: mockClient as never });

    expect(result).toBeNull();
    expect(mockClient.synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("空白のみ '   ' を渡すと synthesizeSpeech が呼ばれず null を返す", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("   ", "en-US", { client: mockClient as never });

    expect(result).toBeNull();
    expect(mockClient.synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("タブや改行のみの文字列でも API を呼ばず null を返す", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("\t\n", "ja-JP", { client: mockClient as never });

    expect(result).toBeNull();
    expect(mockClient.synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("ENABLE_TTS=false の判定が空テキスト判定より先に行われても、いずれにせよ API は呼ばれない", async () => {
    process.env.ENABLE_TTS = "false";
    const mockClient = makeMockClient();

    const result = await synthesizeSpeechToBase64("", "ja-JP", { client: mockClient as never });

    expect(result).toBeNull();
    expect(mockClient.synthesizeSpeech).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. synthesizeSpeechToBase64() — エラー伝播・サニタイズ
// ---------------------------------------------------------------------------
describe("synthesizeSpeechToBase64() — エラー伝播・サニタイズ", () => {
  test("synthesizeSpeech が reject すると例外を投げる", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = {
      synthesizeSpeech: jest.fn().mockRejectedValue(new Error("GCP internal error details")),
    };

    await expect(
      synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never }),
    ).rejects.toThrow();
  });

  test("GCP の内部詳細メッセージがそのまま外部に漏れず、汎用メッセージで包まれる", async () => {
    delete process.env.ENABLE_TTS;
    const gcpInternalError = new Error(
      "PERMISSION_DENIED: Cloud Text-to-Speech API has not been used in project xyz before",
    );
    const mockClient = {
      synthesizeSpeech: jest.fn().mockRejectedValue(gcpInternalError),
    };

    let thrownError: Error | undefined;
    try {
      await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toBe(
      "PERMISSION_DENIED: Cloud Text-to-Speech API has not been used in project xyz before",
    );
    expect(thrownError!.message).toBe("Text-to-Speech failed. Please try again.");
  });

  test("synthesizeSpeech が文字列エラーで reject しても汎用メッセージの例外が投げられる", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = {
      synthesizeSpeech: jest.fn().mockRejectedValue("some string error"),
    };

    await expect(
      synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never }),
    ).rejects.toThrow("Text-to-Speech failed. Please try again.");
  });

  test("audioContent が null の場合 null を返す（例外を投げない）", async () => {
    delete process.env.ENABLE_TTS;
    const mockClient = makeMockClient(null);

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).toBeNull();
  });

  test("audioContent が undefined の場合 null を返す（例外を投げない）", async () => {
    delete process.env.ENABLE_TTS;
    // makeMockClient のデフォルト引数は明示的な undefined でも発動してしまうため、
    // ここでは直接 audioContent: undefined を含むレスポンスを組み立てる。
    const mockClient = {
      synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent: undefined }]),
    };

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. getTtsClient() / setTtsClient() / resetTtsClient() — シングルトン制御
// ---------------------------------------------------------------------------
describe("setTtsClient() / getTtsClient() / resetTtsClient() — シングルトン制御", () => {
  test("setTtsClient() で差し替えたクライアントが getTtsClient() で取得できる", () => {
    const mockClient = makeMockClient();

    setTtsClient(mockClient as never);

    expect(getTtsClient()).toBe(mockClient);
  });

  test("getTtsClient() を2回呼んでも同一インスタンスが返る（シングルトン）", () => {
    const mockClient = makeMockClient();
    setTtsClient(mockClient as never);

    const first = getTtsClient();
    const second = getTtsClient();

    expect(first).toBe(second);
  });

  test("resetTtsClient() 後に setTtsClient() で別のクライアントに差し替えられる", () => {
    const firstMock = makeMockClient(new Uint8Array([1]));
    const secondMock = makeMockClient(new Uint8Array([2]));
    setTtsClient(firstMock as never);

    resetTtsClient();
    setTtsClient(secondMock as never);

    expect(getTtsClient()).toBe(secondMock);
    expect(getTtsClient()).not.toBe(firstMock);
  });

  test("setTtsClient() で差し替えたモックが synthesizeSpeechToBase64() 呼び出し時に使用される（client 未指定時）", async () => {
    delete process.env.ENABLE_TTS;
    const bytes = new Uint8Array([99, 98, 97]);
    const mockClient = makeMockClient(bytes);
    setTtsClient(mockClient as never);

    const result = await synthesizeSpeechToBase64("hello", "en-US");

    expect(result).not.toBeNull();
    expect(mockClient.synthesizeSpeech).toHaveBeenCalledTimes(1);
    const decoded = Buffer.from(result!, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});

// ---------------------------------------------------------------------------
// 12. verifyTtsVoices() — listVoices() によるボイス名の実在検証（bd-124.1）
// ---------------------------------------------------------------------------
describe("verifyTtsVoices() — listVoices() によるボイス名の実在検証", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeMockClientWithListVoices(
    listVoicesImpl: (args: { languageCode: string }) => Promise<[{ voices: { name: string }[] }]>,
  ) {
    return {
      synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent: new Uint8Array([1, 2, 3]) }]),
      listVoices: jest.fn().mockImplementation(listVoicesImpl),
    };
  }

  test("(a) listVoices成功＋ボイス一致: verifyTtsVoices()の戻り値マップに voice.name（レジストリのttsVoiceName）が含まれる", async () => {
    const mockClient = makeMockClientWithListVoices(async ({ languageCode }) => [
      {
        voices:
          languageCode === "ja-JP"
            ? [{ name: "ja-JP-Neural2-B" }]
            : [{ name: "en-US-Neural2-C" }],
      },
    ]);

    const result = await verifyTtsVoices(mockClient as never);

    expect(result.get("ja-JP")).toBe("ja-JP-Neural2-B");
    expect(result.get("en-US")).toBe("en-US-Neural2-C");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("(a) 検証済みボイス名は synthesizeSpeechToBase64() の voice.name としてそのまま使用される", async () => {
    const mockClient = makeMockClientWithListVoices(async ({ languageCode }) => [
      {
        voices:
          languageCode === "en-US" ? [{ name: "en-US-Neural2-C" }] : [{ name: "unrelated" }],
      },
    ]);

    await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { name?: string };
    };
    expect(callArg.voice.name).toBe("en-US-Neural2-C");
  });

  test("(b) listVoicesが返すボイス一覧にレジストリのttsVoiceNameが含まれない場合、警告を出しvoice.nameなしへフォールバックする", async () => {
    const mockClient = makeMockClientWithListVoices(async () => [
      { voices: [{ name: "some-other-voice" }] },
    ]);

    const result = await verifyTtsVoices(mockClient as never);

    expect(result.has("ja-JP")).toBe(false);
    expect(result.has("en-US")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("voice not found"))).toBe(true);
  });

  test("(b) ボイス不一致時は synthesizeSpeechToBase64() が voice.name を含めずに合成を継続する", async () => {
    const mockClient = makeMockClientWithListVoices(async () => [
      { voices: [{ name: "some-other-voice" }] },
    ]);

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).not.toBeNull();
    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { name?: string };
    };
    expect(Object.hasOwn(callArg.voice, "name")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("(c) listVoices()がrejectしても例外を投げず、警告を出してフォールバック（未検証扱い）する", async () => {
    const mockClient = {
      synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent: new Uint8Array([1, 2, 3]) }]),
      listVoices: jest.fn().mockRejectedValue(new Error("listVoices unavailable")),
    };

    const result = await verifyTtsVoices(mockClient as never);

    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("listVoices() failed")),
    ).toBe(true);
  });

  test("(c) listVoices()がrejectしても synthesizeSpeechToBase64() は例外を投げず合成を継続する（フォールバック）", async () => {
    const mockClient = {
      synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent: new Uint8Array([1, 2, 3]) }]),
      listVoices: jest.fn().mockRejectedValue(new Error("listVoices unavailable")),
    };

    const result = await synthesizeSpeechToBase64("hello", "en-US", { client: mockClient as never });

    expect(result).not.toBeNull();
    expect(mockClient.synthesizeSpeech).toHaveBeenCalledTimes(1);
    const callArg = mockClient.synthesizeSpeech.mock.calls[0][0] as {
      voice: { name?: string };
    };
    expect(Object.hasOwn(callArg.voice, "name")).toBe(false);
  });

  test("(d) 検証結果はキャッシュされ、2回目の verifyTtsVoices() 呼び出しでは listVoices() が再度呼ばれない", async () => {
    const mockClient = makeMockClientWithListVoices(async ({ languageCode }) => [
      {
        voices:
          languageCode === "ja-JP"
            ? [{ name: "ja-JP-Neural2-B" }]
            : [{ name: "en-US-Neural2-C" }],
      },
    ]);

    const first = await verifyTtsVoices(mockClient as never);
    const callCountAfterFirst = mockClient.listVoices.mock.calls.length;
    expect(callCountAfterFirst).toBeGreaterThan(0);

    const second = await verifyTtsVoices(mockClient as never);

    expect(mockClient.listVoices.mock.calls.length).toBe(callCountAfterFirst);
    expect(second).toBe(first);
  });

  test("(d) resetVerifiedTtsVoices() 呼び出し後は再度 listVoices() が呼ばれる", async () => {
    const mockClient = makeMockClientWithListVoices(async ({ languageCode }) => [
      {
        voices:
          languageCode === "ja-JP"
            ? [{ name: "ja-JP-Neural2-B" }]
            : [{ name: "en-US-Neural2-C" }],
      },
    ]);

    await verifyTtsVoices(mockClient as never);
    const callCountAfterFirst = mockClient.listVoices.mock.calls.length;

    resetVerifiedTtsVoices();
    await verifyTtsVoices(mockClient as never);

    expect(mockClient.listVoices.mock.calls.length).toBe(callCountAfterFirst * 2);
  });
});

// ---------------------------------------------------------------------------
// 11. 遅延初期化: モジュール import だけでは TextToSpeechClient が生成されないこと
// ---------------------------------------------------------------------------
describe("遅延初期化 — モジュール読み込みだけでは TextToSpeechClient を生成しない", () => {
  test("jest.isolateModules でモジュールを再読込しても、getTtsClient() を呼ぶまでは new TextToSpeechClient() が実行されない", () => {
    jest.isolateModules(() => {
      jest.doMock("@google-cloud/text-to-speech", () => {
        const actual = jest.requireActual("@google-cloud/text-to-speech");
        return {
          ...actual,
          TextToSpeechClient: jest.fn().mockImplementation(() => ({
            synthesizeSpeech: jest.fn(),
          })),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ttsModule = require("../../../server/gcp/textToSpeech");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TextToSpeechClient } = require("@google-cloud/text-to-speech");

      expect(TextToSpeechClient).not.toHaveBeenCalled();

      ttsModule.getTtsClient();
      expect(TextToSpeechClient).toHaveBeenCalledTimes(1);

      ttsModule.resetTtsClient();
    });
  });
});
