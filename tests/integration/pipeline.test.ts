/**
 * 実WSサーバー（startServer）を使った、翻訳・配信ルーティングの結合テスト。
 *
 * GCP API への実接続は行わず、SpeechClient / Translate / TextToSpeechClient の
 * シングルトンを `set*Client()` でモックへ差し替える。
 *
 * フロー: join(owner, guest) → owner start → guest start(enableTts:true) →
 * owner の（モック）STTがfinalを発火 → owner commit → 発話区切り確定 →
 * routeUtterance が実行され、owner へ原文、guest へ翻訳＋音声が配信される。
 *
 * @see server/index.ts
 * @see server/room/session.ts
 * @see server/routing/messageRouter.ts
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { SpeechClient } from "@google-cloud/speech";
import type { v2 } from "@google-cloud/translate";
import type { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { startServer } from "../../server/index";
import {
  setSpeechClient,
  resetSpeechClient,
} from "../../server/gcp/speechStream";
import { setTranslateClient, resetTranslateClient } from "../../server/gcp/translate";
import { setTtsClient, resetTtsClient } from "../../server/gcp/textToSpeech";
import type { JoinMessage, ServerMessage, StartMessage } from "@shared/index";

// ---------------------------------------------------------------------------
// GCP モック: SpeechClient（streamingRecognize）
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

// ---------------------------------------------------------------------------
// GCP モック: Translate v2 client
// ---------------------------------------------------------------------------

function createMockTranslateClient(translateImpl: (text: string, opts: { from: string; to: string }) => string) {
  return {
    translate: jest.fn().mockImplementation(async (text: string, opts: { from: string; to: string }) => {
      return [translateImpl(text, opts)];
    }),
  } as unknown as v2.Translate;
}

// ---------------------------------------------------------------------------
// GCP モック: TextToSpeechClient
// ---------------------------------------------------------------------------

function createMockTtsClient() {
  return {
    synthesizeSpeech: jest.fn().mockImplementation(async () => {
      return [{ audioContent: Buffer.from("fake-mp3-bytes") }];
    }),
  } as unknown as TextToSpeechClient;
}

// ---------------------------------------------------------------------------
// WS テストヘルパー
// ---------------------------------------------------------------------------

function makeJoin(roomId: string, role: "owner" | "guest", overrides: Partial<JoinMessage> = {}): JoinMessage {
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

/** 指定件数のメッセージを受信するまで待ち、受信順に配列で返す */
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

describe("翻訳・配信ルーティング パイプライン結合テスト（実WSサーバー・GCPモック）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  let speechStreams: MockRecognizeStream[];
  // このテストは仮トークン("dummy-token")での join を前提にしている
  // （招待フロー未実装のため、正規のSupabase/ゲストJWTは発行できない）。
  // bd-0jy で join 検証が本実装（strict）化されたため、このテストの意図
  // （翻訳・配信ルーティングの検証）を壊さない最小対応として
  // AUTH_MODE=insecure を明示する（server/auth/verifyParticipant.ts 参照）。
  let originalAuthMode: string | undefined;

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

  beforeEach(async () => {
    originalAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "insecure";

    speechStreams = [createMockRecognizeStream(), createMockRecognizeStream()];
    setSpeechClient(createMockSpeechClient(speechStreams));
    setTranslateClient(
      createMockTranslateClient((text) => `[EN]${text}`),
    );
    setTtsClient(createMockTtsClient());

    wss = startServer(0, HOST);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
  });

  afterEach((done) => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
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

  it("owner(ja-JP)の確定発話が、owner自身へ原文、guest(en-US, TTS有効)へ翻訳とTTS音声として配信される", async () => {
    const port = getPort(wss);
    const roomId = `pipeline-${Date.now()}`;

    // --- 1. join: owner, guest ---
    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    // --- 2. start: owner が発話者として録音開始（1つ目のSTTストリームが割り当てられる） ---
    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", enableTts: false })));
    // --- guest はTTSを有効にして聞き手として振る舞う（2つ目のSTTストリームが割り当てられる） ---
    guest.send(JSON.stringify(makeStart({ sourceLanguage: "en-US", enableTts: true })));

    // start メッセージはソケット経由で非同期に到達するため、処理完了まで待つ
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(speechStreams[0].on).toHaveBeenCalled();
    expect(speechStreams[1].on).toHaveBeenCalled();

    // --- 3. owner の STT が final を発火（発話バッファへ蓄積） ---
    const ownerFinalPromise = collectMessages(owner, 1); // transcript_final
    speechStreams[0].emit("data", {
      results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
    });
    const [transcriptFinal] = await ownerFinalPromise;
    expect(transcriptFinal).toEqual({ type: "transcript_final", text: "こんにちは" });

    // --- 4. owner が commit → 発話確定 → 翻訳・配信ルーティング実行 ---
    // owner: utterance_committed → message(own) の2件
    const ownerRoutedPromise = collectMessages(owner, 2);
    // guest: message(translated) → audio の2件
    const guestRoutedPromise = collectMessages(guest, 2);
    owner.send(JSON.stringify({ type: "commit" }));

    const [ownerMessages, guestMessages] = await Promise.all([
      ownerRoutedPromise,
      guestRoutedPromise,
    ]);

    expect(ownerMessages[0]).toMatchObject({
      type: "utterance_committed",
      text: "こんにちは",
      reason: "commit",
    });
    expect(ownerMessages[1]).toMatchObject({
      type: "message",
      sourceLanguage: "ja-JP",
      originalText: "こんにちは",
      displayText: "こんにちは",
      displayLanguage: "ja-JP",
      isOwnMessage: true,
    });

    expect(guestMessages[0]).toMatchObject({
      type: "message",
      sourceLanguage: "ja-JP",
      originalText: "こんにちは",
      displayText: "[EN]こんにちは",
      displayLanguage: "en-US",
      isOwnMessage: false,
    });
    expect(guestMessages[1]).toMatchObject({
      type: "audio",
      mimeType: "audio/mpeg",
    });
    expect(typeof (guestMessages[1] as Extract<ServerMessage, { type: "audio" }>).data).toBe(
      "string",
    );
  });

  it("空文字final（transcript未定義相当）はtranscript_finalも送信されず、commitしても発話は配信されない", async () => {
    const port = getPort(wss);
    const roomId = `pipeline-empty-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", enableTts: false })));
    guest.send(JSON.stringify(makeStart({ sourceLanguage: "en-US", enableTts: false })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // owner/guest 双方のメッセージを最初から監視する
    // （新仕様では transcript_final すら送信されないため、特定メッセージを待つ
    //   collectMessages() を使うとタイムアウト（20秒）までハングしてしまう。
    //   代わりに、短い猶予時間内に「何も届かないこと」を確認する構造にする）。
    const ownerMessages: ServerMessage[] = [];
    const onOwnerMessage = (data: WebSocket.RawData) => {
      ownerMessages.push(JSON.parse(data.toString("utf8")) as ServerMessage);
    };
    owner.on("message", onOwnerMessage);

    const guestMessages: ServerMessage[] = [];
    const onGuestMessage = (data: WebSocket.RawData) => {
      guestMessages.push(JSON.parse(data.toString("utf8")) as ServerMessage);
    };
    guest.on("message", onGuestMessage);

    // alternatives[0] に transcript を含めない → speechStream.ts が "" として onFinal を呼ぶ
    speechStreams[0].emit("data", {
      results: [{ alternatives: [{}], isFinal: true }],
    });

    // STT final 発火直後の非同期処理が発生しないことを確認するための猶予
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 新仕様: 空文字finalは Session 側でスキップされるため transcript_final すら送られない
    expect(ownerMessages).not.toContainEqual(
      expect.objectContaining({ type: "transcript_final" }),
    );
    expect(ownerMessages).toHaveLength(0);

    owner.send(JSON.stringify({ type: "commit" }));

    // commit直後の非同期処理が発生しないことを確認するための猶予（イベントループ数サイクル分）
    await new Promise((resolve) => setTimeout(resolve, 150));

    owner.off("message", onOwnerMessage);
    guest.off("message", onGuestMessage);

    expect(ownerMessages).toHaveLength(0);
    expect(guestMessages).toHaveLength(0);
  });
});
