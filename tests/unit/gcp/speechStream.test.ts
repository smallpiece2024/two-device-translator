/**
 * server/gcp/speechStream.ts の単体テスト
 *
 * Cloud Speech-to-Text Streaming クライアントはモックで差し替え、GCP への実通信は行わない。
 * createSpeechStream() / decodeAudioChunk() / getSpeechClient() / setSpeechClient() /
 * resetSpeechClient() を検証する。
 *
 * モック方式:
 *   streamingRecognize を jest.fn() として、戻り値に手動 EventEmitter 風スタブを使用する。
 *   スタブは { write, end, destroy, on } を持ち、on() は自身を返してチェーンを実現する。
 *   ハンドラは on() 呼び出し時にキャプチャし、テスト側から emit() で手動発火する。
 */

import {
  createSpeechStream,
  decodeAudioChunk,
  getSpeechClient,
  setSpeechClient,
  resetSpeechClient,
  SpeechStreamOptions,
} from "../../../server/gcp/speechStream";
import { SpeechClient } from "@google-cloud/speech";

// ---------------------------------------------------------------------------
// テストヘルパー: streamingRecognize のモックストリームスタブ
// ---------------------------------------------------------------------------

function createMockRecognizeStream() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  const stream = {
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event].push(handler);
      return stream; // チェーンのため this 相当を返す
    }),
    emit(event: string, ...args: unknown[]) {
      const eventHandlers = handlers[event] ?? [];
      eventHandlers.forEach((h) => h(...args));
    },
  };

  return stream;
}

type MockRecognizeStream = ReturnType<typeof createMockRecognizeStream>;

function createMockSpeechClient(mockStream: MockRecognizeStream) {
  return {
    streamingRecognize: jest.fn().mockReturnValue(mockStream),
  } as unknown as SpeechClient;
}

afterEach(() => {
  resetSpeechClient();
});

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
// 1. streamingRecognize の設定検証
// ---------------------------------------------------------------------------
describe("createSpeechStream() — streamingRecognize の設定", () => {
  test("languageCode='ja-JP' で createSpeechStream を呼ぶと encoding=WEBM_OPUS / sampleRateHertz=48000 / enableAutomaticPunctuation=true / interimResults=true で streamingRecognize が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const options = makeOptions({ languageCode: "ja-JP" });

    createSpeechStream(options, mockClient);

    expect(mockClient.streamingRecognize).toHaveBeenCalledTimes(1);
    const callArg = (mockClient.streamingRecognize as jest.Mock).mock.calls[0][0];
    expect(callArg.config.encoding).toBe("WEBM_OPUS");
    expect(callArg.config.sampleRateHertz).toBe(48000);
    expect(callArg.config.enableAutomaticPunctuation).toBe(true);
    expect(callArg.interimResults).toBe(true);
    expect(callArg.config.languageCode).toBe("ja-JP");
  });

  test("languageCode がそのまま config.languageCode として渡る: en-US", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const options = makeOptions({ languageCode: "en-US" });

    createSpeechStream(options, mockClient);

    const callArg = (mockClient.streamingRecognize as jest.Mock).mock.calls[0][0];
    expect(callArg.config.languageCode).toBe("en-US");
  });
});

// ---------------------------------------------------------------------------
// 1b. alternativeLanguageCodes（言語検出モード、bd-ecb）
// ---------------------------------------------------------------------------
describe("createSpeechStream() — alternativeLanguageCodes（言語検出モード）", () => {
  test("alternativeLanguageCodes を指定すると config.alternativeLanguageCodes として渡る", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const options = makeOptions({
      languageCode: "ja-JP",
      alternativeLanguageCodes: ["en-US"],
    });

    createSpeechStream(options, mockClient);

    const callArg = (mockClient.streamingRecognize as jest.Mock).mock.calls[0][0];
    expect(callArg.config.alternativeLanguageCodes).toEqual(["en-US"]);
  });

  test("alternativeLanguageCodes を指定しない場合、config に alternativeLanguageCodes キー自体が含まれない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const options = makeOptions({ languageCode: "ja-JP" });

    createSpeechStream(options, mockClient);

    const callArg = (mockClient.streamingRecognize as jest.Mock).mock.calls[0][0];
    expect(callArg.config.alternativeLanguageCodes).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(callArg.config, "alternativeLanguageCodes")).toBe(
      false,
    );
  });

  test("alternativeLanguageCodes が空配列の場合、config に alternativeLanguageCodes キーは付与されない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const options = makeOptions({ languageCode: "ja-JP", alternativeLanguageCodes: [] });

    createSpeechStream(options, mockClient);

    const callArg = (mockClient.streamingRecognize as jest.Mock).mock.calls[0][0];
    expect(
      Object.prototype.hasOwnProperty.call(callArg.config, "alternativeLanguageCodes"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. handle.write() — Buffer がストリームへ渡る
// ---------------------------------------------------------------------------
describe("createSpeechStream() — handle.write() の動作", () => {
  test("handle.write(Buffer) を呼ぶとモックストリームの write が同じ Buffer で呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);
    const chunk = Buffer.from([0x01, 0x02, 0x03]);

    handle.write(chunk);

    expect(mockStream.write).toHaveBeenCalledTimes(1);
    expect(mockStream.write).toHaveBeenCalledWith(chunk);
  });

  test("複数回 write しても呼び出し回数分だけストリームの write が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);
    const buf1 = Buffer.from("chunk1");
    const buf2 = Buffer.from("chunk2");

    handle.write(buf1);
    handle.write(buf2);

    expect(mockStream.write).toHaveBeenCalledTimes(2);
    expect(mockStream.write).toHaveBeenNthCalledWith(1, buf1);
    expect(mockStream.write).toHaveBeenNthCalledWith(2, buf2);
  });

  test("write が例外を投げても onError(fatal:false) が呼ばれ、例外は外へ伝播しない", () => {
    const mockStream = createMockRecognizeStream();
    mockStream.write.mockImplementation(() => {
      throw new Error("write failed: stream destroyed");
    });
    const mockClient = createMockSpeechClient(mockStream);
    const onError = jest.fn();
    const handle = createSpeechStream(makeOptions({ onError }), mockClient);

    expect(() => handle.write(Buffer.from("x"))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, fatal] = onError.mock.calls[0];
    expect(fatal).toBe(false);
    expect(message).not.toContain("stream destroyed");
  });

  describe("終了済みストリームへのwriteガード（bd-c3z）", () => {
    test("errorイベント後のwriteはストリームへ書き込まれず、onErrorも追加で呼ばれない", () => {
      const mockStream = createMockRecognizeStream();
      const mockClient = createMockSpeechClient(mockStream);
      const onError = jest.fn();
      const handle = createSpeechStream(makeOptions({ onError }), mockClient);

      mockStream.emit("error", new Error("some stream error"));
      const onErrorCallsAfterEvent = onError.mock.calls.length;

      handle.write(Buffer.from("a"));
      handle.write(Buffer.from("b"));

      expect(mockStream.write).not.toHaveBeenCalled();
      expect(onError.mock.calls.length).toBe(onErrorCallsAfterEvent);
    });

    test("destroy()後のwriteは破棄され、警告は初回の1回のみ出力される", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const mockStream = createMockRecognizeStream();
      const mockClient = createMockSpeechClient(mockStream);
      const handle = createSpeechStream(makeOptions(), mockClient);

      handle.destroy();
      handle.write(Buffer.from("a"));
      handle.write(Buffer.from("b"));
      handle.write(Buffer.from("c"));

      expect(mockStream.write).not.toHaveBeenCalled();
      const dropWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("dropping audio chunks"),
      );
      expect(dropWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });

    test("end()後のwriteは破棄される", () => {
      const mockStream = createMockRecognizeStream();
      const mockClient = createMockSpeechClient(mockStream);
      const handle = createSpeechStream(makeOptions(), mockClient);

      handle.end();
      handle.write(Buffer.from("a"));

      expect(mockStream.write).not.toHaveBeenCalled();
    });

    test("write例外の発生後、以降のwriteは破棄されonErrorの連鎖が起きない", () => {
      const mockStream = createMockRecognizeStream();
      mockStream.write.mockImplementation(() => {
        throw new Error("write failed");
      });
      const mockClient = createMockSpeechClient(mockStream);
      const onError = jest.fn();
      const handle = createSpeechStream(makeOptions({ onError }), mockClient);

      handle.write(Buffer.from("a")); // 例外→onError(1回)+terminated
      handle.write(Buffer.from("b")); // 破棄
      handle.write(Buffer.from("c")); // 破棄

      expect(mockStream.write).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. data イベント — isFinal=true → onFinal が呼ばれ onInterim は呼ばれない
// ---------------------------------------------------------------------------
describe("createSpeechStream() — data イベント / isFinal=true", () => {
  test("isFinal=true の data イベントで onFinal(transcript) が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
    });

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("こんにちは");
    expect(onInterim).not.toHaveBeenCalled();
  });

  test("isFinal=true で複数回 data を emit すると onFinal が複数回呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "first" }], isFinal: true }],
    });
    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "second" }], isFinal: true }],
    });

    expect(onFinal).toHaveBeenCalledTimes(2);
    expect(onFinal).toHaveBeenNthCalledWith(1, "first");
    expect(onFinal).toHaveBeenNthCalledWith(2, "second");
  });
});

// ---------------------------------------------------------------------------
// 4. data イベント — isFinal=false → onInterim が呼ばれ onFinal は呼ばれない
// ---------------------------------------------------------------------------
describe("createSpeechStream() — data イベント / isFinal=false", () => {
  test("isFinal=false の data イベントで onInterim(transcript) が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "hello" }], isFinal: false }],
    });

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onInterim).toHaveBeenCalledWith("hello");
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("isFinal=false → isFinal=true の順で data を emit すると onInterim → onFinal の順に呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "interim text" }], isFinal: false }],
    });
    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "final text" }], isFinal: true }],
    });

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onInterim).toHaveBeenCalledWith("interim text");
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("final text");
  });

  test("transcript が未定義の場合は空文字列としてコールバックされる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{}], isFinal: true }],
    });

    expect(onFinal).toHaveBeenCalledWith("");
  });
});

// ---------------------------------------------------------------------------
// 3b. data イベント — languageCode（言語検出モード、bd-ecb）
// ---------------------------------------------------------------------------
describe("createSpeechStream() — data イベント / final結果のlanguageCode", () => {
  test("result.languageCode がある final は onFinal(text, languageCode) として第2引数付きで呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onFinal }), mockClient);

    mockStream.emit("data", {
      results: [
        { alternatives: [{ transcript: "Hello" }], isFinal: true, languageCode: "en-US" },
      ],
    });

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("Hello", "en-US");
  });

  test("result.languageCode がない final は onFinal(text) として第2引数なし（undefined引数を明示しない）で呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
    });

    expect(onFinal).toHaveBeenCalledTimes(1);
    // 第2引数を渡さない呼び出しであることを、引数の個数まで含めて検証する
    expect(onFinal.mock.calls[0]).toEqual(["こんにちは"]);
    expect(onFinal.mock.calls[0].length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. 空 results / 空 alternatives のガード
// ---------------------------------------------------------------------------
describe("createSpeechStream() — 空 results / 空 alternatives のガード", () => {
  test("results が空配列 [] の data イベントで onInterim / onFinal が呼ばれない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", { results: [] });

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("results が undefined の data イベントで onInterim / onFinal が呼ばれない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {});

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("alternatives が空配列 [] の data イベントで onInterim / onFinal が呼ばれない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ alternatives: [], isFinal: true }],
    });

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  test("alternatives が undefined の data イベントで onInterim / onFinal が呼ばれない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    createSpeechStream(makeOptions({ onInterim, onFinal }), mockClient);

    mockStream.emit("data", {
      results: [{ isFinal: true }],
    });

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. error イベント — タイムアウトエラー
// ---------------------------------------------------------------------------
describe("createSpeechStream() — error イベント / タイムアウト", () => {
  test("error イベントで 'DEADLINE_EXCEEDED' を含むメッセージが来ると onError が fatal=false で呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onError = jest.fn();
    createSpeechStream(makeOptions({ onError }), mockClient);

    mockStream.emit("error", new Error("4 DEADLINE_EXCEEDED: context deadline exceeded"));

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, fatal] = onError.mock.calls[0];
    expect(fatal).toBe(false);
    expect(message).toContain("timed out");
  });

  test("error イベントで 'Audio Timeout' を含むメッセージが来ると onError が fatal=false で呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onError = jest.fn();
    createSpeechStream(makeOptions({ onError }), mockClient);

    mockStream.emit("error", new Error("Audio Timeout Error: audio data not received"));

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, fatal] = onError.mock.calls[0];
    expect(fatal).toBe(false);
    expect(message).toContain("timed out");
  });

  test("error イベントで 'audio timeout'（小文字）を含むメッセージが来ると onError が fatal=false で呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onError = jest.fn();
    createSpeechStream(makeOptions({ onError }), mockClient);

    mockStream.emit("error", new Error("audio timeout reached"));

    expect(onError).toHaveBeenCalledTimes(1);
    const [, fatal] = onError.mock.calls[0];
    expect(fatal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. error イベント — その他のエラー
// ---------------------------------------------------------------------------
describe("createSpeechStream() — error イベント / その他のエラー", () => {
  test("タイムアウト以外のエラーで onError が fatal=false で呼ばれ、GCP 内部詳細が漏れない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const onError = jest.fn();
    createSpeechStream(makeOptions({ onError }), mockClient);

    mockStream.emit("error", new Error("PERMISSION_DENIED: service account has no permission"));

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, fatal] = onError.mock.calls[0];
    expect(fatal).toBe(false);
    expect(message).not.toContain("PERMISSION_DENIED");
    expect(message).not.toContain("service account");
  });

  test("タイムアウトエラーはタイムアウト専用メッセージ、その他エラーは別のメッセージになる", () => {
    const mockStream1 = createMockRecognizeStream();
    const mockClient1 = createMockSpeechClient(mockStream1);
    const onError1 = jest.fn();
    createSpeechStream(makeOptions({ onError: onError1 }), mockClient1);

    const mockStream2 = createMockRecognizeStream();
    const mockClient2 = createMockSpeechClient(mockStream2);
    const onError2 = jest.fn();
    createSpeechStream(makeOptions({ onError: onError2 }), mockClient2);

    mockStream1.emit("error", new Error("DEADLINE_EXCEEDED: timeout"));
    mockStream2.emit("error", new Error("INTERNAL: unexpected error"));

    const [timeoutMessage] = onError1.mock.calls[0];
    const [otherMessage] = onError2.mock.calls[0];
    expect(timeoutMessage).not.toBe(otherMessage);
  });
});

// ---------------------------------------------------------------------------
// 8. handle.end() / handle.destroy()
// ---------------------------------------------------------------------------
describe("createSpeechStream() — handle.end() / handle.destroy()", () => {
  test("handle.end() を呼ぶとモックストリームの end() が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);

    handle.end();

    expect(mockStream.end).toHaveBeenCalledTimes(1);
  });

  test("handle.destroy() を呼ぶとモックストリームの destroy() が呼ばれる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);

    handle.destroy();

    expect(mockStream.destroy).toHaveBeenCalledTimes(1);
  });

  test("handle.end() を複数回呼んでもエラーが起きない", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);

    expect(() => {
      handle.end();
      handle.end();
    }).not.toThrow();
  });

  test("end() が例外を投げてもハンドル呼び出し側に伝播しない", () => {
    const mockStream = createMockRecognizeStream();
    mockStream.end.mockImplementation(() => {
      throw new Error("end failed");
    });
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);

    expect(() => handle.end()).not.toThrow();
  });

  test("destroy() が例外を投げてもハンドル呼び出し側に伝播しない", () => {
    const mockStream = createMockRecognizeStream();
    mockStream.destroy.mockImplementation(() => {
      throw new Error("destroy failed");
    });
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);

    expect(() => handle.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. シングルトン: getSpeechClient / setSpeechClient / resetSpeechClient
// ---------------------------------------------------------------------------
describe("getSpeechClient() / setSpeechClient() / resetSpeechClient() — シングルトン制御", () => {
  test("setSpeechClient() で差し替えたクライアントが getSpeechClient() で取得できる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);

    setSpeechClient(mockClient);

    expect(getSpeechClient()).toBe(mockClient);
  });

  test("getSpeechClient() を2回呼んでも同一インスタンスが返る（シングルトン）", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    setSpeechClient(mockClient);

    const first = getSpeechClient();
    const second = getSpeechClient();

    expect(first).toBe(second);
  });

  test("resetSpeechClient() 後に setSpeechClient() で別のクライアントに差し替えられる", () => {
    const firstStream = createMockRecognizeStream();
    const firstClient = createMockSpeechClient(firstStream);
    const secondStream = createMockRecognizeStream();
    const secondClient = createMockSpeechClient(secondStream);
    setSpeechClient(firstClient);

    resetSpeechClient();
    setSpeechClient(secondClient);

    expect(getSpeechClient()).toBe(secondClient);
    expect(getSpeechClient()).not.toBe(firstClient);
  });

  test("setSpeechClient() で差し替えたモックが createSpeechStream() で使用される（client引数省略時）", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    setSpeechClient(mockClient);

    createSpeechStream(makeOptions());

    expect(mockClient.streamingRecognize).toHaveBeenCalledTimes(1);
  });

  test("resetSpeechClient() 後でも client 引数を明示的に渡せば createSpeechStream が動作する", () => {
    resetSpeechClient();
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);

    expect(() => {
      createSpeechStream(makeOptions(), mockClient);
    }).not.toThrow();
    expect(mockClient.streamingRecognize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 10. 遅延初期化: モジュール import だけでは SpeechClient が生成されないこと
// ---------------------------------------------------------------------------
describe("遅延初期化 — モジュール読み込みだけでは SpeechClient を生成しない", () => {
  test("jest.isolateModules でモジュールを再読込しても、getSpeechClient() を呼ぶまでは new SpeechClient() が実行されない", () => {
    jest.isolateModules(() => {
      jest.doMock("@google-cloud/speech", () => {
        const actual = jest.requireActual("@google-cloud/speech");
        return {
          ...actual,
          SpeechClient: jest.fn().mockImplementation(() => ({
            streamingRecognize: jest.fn(),
          })),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const speechModule = require("../../../server/gcp/speechStream");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SpeechClient: MockedSpeechClient } = require("@google-cloud/speech");

      // import だけではコンストラクタが呼ばれていないこと
      expect(MockedSpeechClient).not.toHaveBeenCalled();

      // getSpeechClient() を呼んで初めて生成される
      speechModule.getSpeechClient();
      expect(MockedSpeechClient).toHaveBeenCalledTimes(1);

      speechModule.resetSpeechClient();
    });
  });
});

// ---------------------------------------------------------------------------
// 11. decodeAudioChunk()
// ---------------------------------------------------------------------------
describe("decodeAudioChunk()", () => {
  test("base64 文字列を Buffer にデコードする", () => {
    const original = Buffer.from([0x01, 0x02, 0xff, 0x00, 0x7f]);
    const base64 = original.toString("base64");

    const result = decodeAudioChunk(base64);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(Array.from(result)).toEqual(Array.from(original));
  });

  test("空文字列をデコードすると空の Buffer になる", () => {
    const result = decodeAudioChunk("");

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("デコードした Buffer を handle.write() へそのまま渡せる", () => {
    const mockStream = createMockRecognizeStream();
    const mockClient = createMockSpeechClient(mockStream);
    const handle = createSpeechStream(makeOptions(), mockClient);
    const original = Buffer.from("audio-chunk-data");
    const base64 = original.toString("base64");

    const decoded = decodeAudioChunk(base64);
    handle.write(decoded);

    expect(mockStream.write).toHaveBeenCalledWith(decoded);
    expect(Array.from((mockStream.write.mock.calls[0][0] as Buffer))).toEqual(
      Array.from(original),
    );
  });
});
