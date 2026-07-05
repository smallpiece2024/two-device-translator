/**
 * server/index.ts の GCP 実装差し替えロジックの結合テスト（bd-713 コードレビュー指摘: テスト追加）。
 *
 * `startServer()` は `GCP_MODE` 環境変数と `StartServerOptions`（明示オプション）に
 * 基づいて、translate / synthesize / createSpeechStream の実装を以下の優先順位で解決する:
 *   1. `options.{translate,synthesize,createSpeechStream}`（明示指定、最優先）
 *   2. `GCP_MODE=mock` → `server/gcp/mockGcp.ts` の決定的モック実装
 *   3. それ以外（未設定・他の値）→ 実 GCP 実装（`server/gcp/translate.ts` 等）
 *
 * 実 GCP API は一切呼ばない。実 GCP 経路の検証には `setSpeechClient` /
 * `setTranslateClient` / `setTtsClient`（シングルトン差し替え）を用いる
 * （`tests/integration/pipeline.test.ts` と同じ方式）。
 *
 * フロー: join(owner, guest) → owner start → owner の STT が write() 回数に応じて
 * final を発火 → owner commit → 発話区切り確定 → routeUtterance が実行され、
 * guest へ翻訳＋音声が配信される。この guest 側の受信内容（displayText / audio.data）
 * から、どの実装（モック/実GCP/明示注入）が使われたかを観測する。
 *
 * @see server/index.ts
 * @see server/gcp/mockGcp.ts
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { SpeechClient } from "@google-cloud/speech";
import type { v2 } from "@google-cloud/translate";
import type { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { startServer, type StartServerOptions } from "../../server/index";
import { setSpeechClient, resetSpeechClient } from "../../server/gcp/speechStream";
import { setTranslateClient, resetTranslateClient } from "../../server/gcp/translate";
import { setTtsClient, resetTtsClient } from "../../server/gcp/textToSpeech";
import { mockTranslateText, mockSynthesizeSpeechToBase64 } from "../../server/gcp/mockGcp";
import type { JoinMessage, ServerMessage, StartMessage } from "@shared/index";
import type { SpeechStreamHandle } from "../../server/gcp/types";

// ---------------------------------------------------------------------------
// GCP モック: SpeechClient（実GCP経路の検証用。streamingRecognize）
// ---------------------------------------------------------------------------

function createMockRecognizeStream() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stream = {
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
      return stream;
    }),
    emit(event: string, ...args: unknown[]) {
      (handlers[event] ?? []).forEach((h) => h(...args));
    },
  };
  return stream;
}

type MockRecognizeStream = ReturnType<typeof createMockRecognizeStream>;

function createMockSpeechClient(streams: MockRecognizeStream[]): SpeechClient {
  let callIndex = 0;
  return {
    streamingRecognize: jest.fn().mockImplementation(() => {
      const stream = streams[callIndex] ?? createMockRecognizeStream();
      callIndex += 1;
      return stream;
    }),
  } as unknown as SpeechClient;
}

function createMockTranslateClient(
  translateImpl: (text: string, opts: { from: string; to: string }) => string,
) {
  return {
    translate: jest.fn().mockImplementation(async (text: string, opts: { from: string; to: string }) => {
      return [translateImpl(text, opts)];
    }),
  } as unknown as v2.Translate;
}

function createMockTtsClient() {
  return {
    synthesizeSpeech: jest.fn().mockImplementation(async () => {
      return [{ audioContent: Buffer.from("real-gcp-fake-mp3-bytes") }];
    }),
  } as unknown as TextToSpeechClient;
}

// ---------------------------------------------------------------------------
// WS テストヘルパー（tests/integration/pipeline.test.ts と同じ方式）
// ---------------------------------------------------------------------------

function makeJoin(
  roomId: string,
  role: "owner" | "guest",
  overrides: Partial<JoinMessage> = {},
): JoinMessage {
  return {
    type: "join",
    roomId,
    role,
    token: "dummy-token",
    language: "ja-JP",
    ...overrides,
  };
}

function makeStart(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    type: "start",
    sourceLanguage: "ja-JP",
    enableTts: false,
    chunkMs: 250,
    silenceMs: 1000,
    maxChars: 80,
    maxSeconds: 10,
    ...overrides,
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function collectMessages(ws: WebSocket, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const received: ServerMessage[] = [];
    const onMessage = (data: WebSocket.RawData) => {
      try {
        received.push(JSON.parse(data.toString("utf8")) as ServerMessage);
        if (received.length >= count) {
          ws.off("message", onMessage);
          resolve(received);
        }
      } catch (err) {
        ws.off("message", onMessage);
        reject(err as Error);
      }
    };
    ws.on("message", onMessage);
  });
}

describe("startServer() の GCP_MODE / 明示オプションによる実装差し替え（結合テスト）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  let originalGcpMode: string | undefined;
  let originalEnableTts: string | undefined;

  function getPort(server: WebSocketServer): number {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to obtain server address");
    }
    return address.port;
  }

  function connect(port: number): WebSocket {
    const ws = new WebSocket(`ws://${HOST}:${port}`);
    clients.push(ws);
    return ws;
  }

  beforeEach(() => {
    originalGcpMode = process.env.GCP_MODE;
    originalEnableTts = process.env.ENABLE_TTS;
    delete process.env.ENABLE_TTS;
  });

  afterEach((done) => {
    if (originalGcpMode === undefined) {
      delete process.env.GCP_MODE;
    } else {
      process.env.GCP_MODE = originalGcpMode;
    }
    if (originalEnableTts === undefined) {
      delete process.env.ENABLE_TTS;
    } else {
      process.env.ENABLE_TTS = originalEnableTts;
    }

    clients.forEach((client) => client.terminate());
    clients = [];
    resetSpeechClient();
    resetTranslateClient();
    resetTtsClient();
    if (!wss) {
      done();
      return;
    }
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => setTimeout(done, 50));
  });

  /**
   * owner(ja-JP) → guest(en-US, TTS有効) の join → owner start → owner commit までを
   * 実行し、guest が受信した message/audio を返す共通フロー。
   *
   * @param startOptions startServer() に渡す StartServerOptions
   * @param sttDriver owner の（実GCP/モック いずれか）STT を駆動する関数。
   *   実GCP経路では `speechStreams[0].emit("data", ...)` で final を発火させ、
   *   mock経路・明示注入経路では `owner.send(audio×N)` で write() を駆動する。
   */
  async function runPipelineAndCollectGuestMessages(
    startOptions: StartServerOptions,
    driveOwnerToFinal: (owner: WebSocket) => Promise<void>,
  ): Promise<ServerMessage[]> {
    wss = startServer(0, HOST, startOptions);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = getPort(wss);
    const roomId = `gcp-mode-${Date.now()}-${Math.random()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    // enableTts はスキーマ既定値 true（明示不要）
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", enableTts: false })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const guestRoutedPromise = collectMessages(guest, 2); // message(translated) + audio

    await driveOwnerToFinal(owner);
    owner.send(JSON.stringify({ type: "commit" }));

    return guestRoutedPromise;
  }

  // -------------------------------------------------------------------------
  // 1. GCP_MODE=mock → server/gcp/mockGcp.ts の決定的モック実装が使われる
  // -------------------------------------------------------------------------
  it("GCP_MODE=mock かつ明示オプション未指定のとき、mockGcp の決定的モック（翻訳・TTS）が使われる", async () => {
    process.env.GCP_MODE = "mock";

    // 実GCP側の各シングルトンは決して呼ばれてはならない
    const realTranslateSpy = jest.fn();
    setTranslateClient({
      translate: realTranslateSpy,
    } as unknown as v2.Translate);
    const realTtsSpy = jest.fn();
    setTtsClient({ synthesizeSpeech: realTtsSpy } as unknown as TextToSpeechClient);

    const guestMessages = await runPipelineAndCollectGuestMessages({}, async (owner) => {
      // createMockSpeechStream は write() 回数で発火する（2回目interim, 4回目final）。
      // audio.data はスキーマ上 min(1) の文字列であればよい（decodeAudioChunkは非検証的）。
      for (let i = 0; i < 4; i += 1) {
        owner.send(JSON.stringify({ type: "audio", data: "ZHVtbXk=" }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const finalPhraseJa = "こんにちは、これはテストです"; // mockGcp.ts の ja-JP 固定フレーズ
    const expectedDisplayText = await mockTranslateText(finalPhraseJa, "ja-JP", "en-US");
    const expectedAudio = await mockSynthesizeSpeechToBase64(expectedDisplayText, "en-US");

    expect(guestMessages[0]).toMatchObject({
      type: "message",
      originalText: finalPhraseJa,
      displayText: expectedDisplayText,
      displayLanguage: "en-US",
    });
    expect(guestMessages[0]).toMatchObject({ displayText: "[en-US] こんにちは、これはテストです" });
    expect(guestMessages[1]).toMatchObject({ type: "audio", mimeType: "audio/mpeg", data: expectedAudio });

    // 実GCPの翻訳・TTSクライアントは一切呼ばれていない
    expect(realTranslateSpy).not.toHaveBeenCalled();
    expect(realTtsSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. GCP_MODE 未設定（既定） → 実GCP実装が使われる
  // -------------------------------------------------------------------------
  it("GCP_MODE が未設定（既定）のとき、実GCP実装（translateText/synthesizeSpeechToBase64）経由でシングルトンクライアントが呼ばれる", async () => {
    delete process.env.GCP_MODE;

    const speechStreams = [createMockRecognizeStream()];
    setSpeechClient(createMockSpeechClient(speechStreams));
    const translateSpy = createMockTranslateClient((text) => `[REAL]${text}`);
    setTranslateClient(translateSpy);
    const ttsClient = createMockTtsClient();
    setTtsClient(ttsClient);

    const guestMessages = await runPipelineAndCollectGuestMessages({}, async () => {
      speechStreams[0].emit("data", {
        results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(guestMessages[0]).toMatchObject({
      type: "message",
      originalText: "こんにちは",
      displayText: "[REAL]こんにちは",
      displayLanguage: "en-US",
    });
    expect(guestMessages[1]).toMatchObject({ type: "audio", mimeType: "audio/mpeg" });

    // 実GCPのシングルトンクライアントが実際に呼ばれたこと（＝実装解決が real 経路だった証拠）
    expect((translateSpy.translate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    expect((ttsClient.synthesizeSpeech as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 3. GCP_MODE が 'mock' 以外の値 → 実GCP実装が使われる（"mock"のみが特別扱い）
  // -------------------------------------------------------------------------
  it("GCP_MODE='production'（'mock'以外の値）のときも実GCP実装が使われる", async () => {
    process.env.GCP_MODE = "production";

    const speechStreams = [createMockRecognizeStream()];
    setSpeechClient(createMockSpeechClient(speechStreams));
    const translateSpy = createMockTranslateClient((text) => `[REAL]${text}`);
    setTranslateClient(translateSpy);
    setTtsClient(createMockTtsClient());

    const guestMessages = await runPipelineAndCollectGuestMessages({}, async () => {
      speechStreams[0].emit("data", {
        results: [{ alternatives: [{ transcript: "テスト" }], isFinal: true }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(guestMessages[0]).toMatchObject({
      displayText: "[REAL]テスト",
    });
    expect((translateSpy.translate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 4. 明示オプションが GCP_MODE より優先される
  // -------------------------------------------------------------------------
  it("GCP_MODE=mock でも、明示オプション（translate/synthesize/createSpeechStream）が指定されていればそちらが使われる", async () => {
    process.env.GCP_MODE = "mock";

    const customTranslate = jest.fn().mockResolvedValue("CUSTOM_TRANSLATED_TEXT");
    const customSynthesize = jest.fn().mockResolvedValue("CUSTOM_AUDIO_BASE64");
    const customCreateSpeechStream = jest.fn().mockImplementation(
      (options: { onFinal: (text: string) => void }): SpeechStreamHandle => {
        let fired = false;
        return {
          write: () => {
            if (!fired) {
              fired = true;
              options.onFinal("custom final text");
            }
          },
          end: () => {},
          destroy: () => {},
        };
      },
    );

    const guestMessages = await runPipelineAndCollectGuestMessages(
      {
        translate: customTranslate,
        synthesize: customSynthesize,
        createSpeechStream: customCreateSpeechStream,
      },
      async (owner) => {
        owner.send(JSON.stringify({ type: "audio", data: "ZHVtbXk=" }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );

    expect(guestMessages[0]).toMatchObject({
      type: "message",
      originalText: "custom final text",
      displayText: "CUSTOM_TRANSLATED_TEXT",
    });
    expect(guestMessages[1]).toMatchObject({
      type: "audio",
      data: "CUSTOM_AUDIO_BASE64",
    });

    expect(customCreateSpeechStream).toHaveBeenCalledTimes(1);
    expect(customTranslate).toHaveBeenCalledWith("custom final text", "ja-JP", "en-US");
    expect(customSynthesize).toHaveBeenCalledWith("CUSTOM_TRANSLATED_TEXT", "en-US");
  });
});
