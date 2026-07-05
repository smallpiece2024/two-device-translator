/**
 * 参加者イベント（participant_joined / participant_left）と
 * join時のTTSトグル初期化（enableTts）・update_settingsによる更新の結合テスト。
 *
 * 実際の WebSocketServer を起動し（port: 0 でOS割当）、複数クライアントで
 * 以下のバグ修正後の期待仕様を検証する（修正前は失敗する = Redフェーズ）。
 *
 * 1. join成功時、他の在室参加者へ participant_joined が配信される
 * 2. 切断時、他の参加者へ participant_left が配信される
 * 3. join の enableTts が session の初期値になり、聞き手が start しなくても
 *    話者の発話確定後に audio を受信できる
 * 4. update_settings で enableTts を更新でき、false にした後は audio が届かない
 *
 * `participant_joined` / `participant_left` / join.enableTts / update_settings は
 * まだ shared/ws-protocol/schema.ts に定義されていないため、本テストでは
 * 受信メッセージを JSON.parse のみで検証し、ServerMessage 型は経由しない。
 * 送信側も生JSON（型を通さない）で送る。
 *
 * @see server/index.ts
 * @see server/room/roomManager.ts
 * @see server/room/session.ts
 * @see server/routing/messageRouter.ts
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { SpeechClient } from "@google-cloud/speech";
import type { v2 } from "@google-cloud/translate";
import type { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { startServer } from "../../server/index";
import { setSpeechClient, resetSpeechClient } from "../../server/gcp/speechStream";
import { setTranslateClient, resetTranslateClient } from "../../server/gcp/translate";
import { setTtsClient, resetTtsClient } from "../../server/gcp/textToSpeech";

// ---------------------------------------------------------------------------
// GCP モック（tests/integration/pipeline.test.ts と同じパターン）
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
      return [{ audioContent: Buffer.from("fake-mp3-bytes") }];
    }),
  } as unknown as TextToSpeechClient;
}

// ---------------------------------------------------------------------------
// WS テストヘルパー
// ---------------------------------------------------------------------------

/** join メッセージを生成する。enableTts はまだ shared 型に無いため any 経由で追加する。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeJoin(
  roomId: string,
  role: "owner" | "guest",
  overrides: Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
    type: "join",
    roomId,
    role,
    token: "dummy-token",
    language: "ja-JP",
    ...overrides,
  };
}

function makeStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

/** 生JSONメッセージ型（型を通さず受信検証するための最小定義） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawMessage = Record<string, any>;

/** 指定件数のメッセージを受信するまで待つ（timeoutMs 超過で reject） */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 2500): Promise<RawMessage[]> {
  return new Promise((resolve, reject) => {
    const received: RawMessage[] = [];
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(
        new Error(
          `collectMessages timeout: expected ${count} messages, got ${received.length}: ${JSON.stringify(received)}`,
        ),
      );
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      try {
        received.push(JSON.parse(data.toString("utf8")) as RawMessage);
        if (received.length >= count) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(received);
        }
      } catch (err) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(err as Error);
      }
    };
    ws.on("message", onMessage);
  });
}

/** 指定した猶予時間内に届いたメッセージをすべて集める（届かなくてもタイムアウトしない） */
function collectMessagesForGracePeriod(ws: WebSocket, graceMs = 400): Promise<RawMessage[]> {
  return new Promise((resolve) => {
    const received: RawMessage[] = [];
    const onMessage = (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString("utf8")) as RawMessage);
    };
    ws.on("message", onMessage);
    setTimeout(() => {
      ws.off("message", onMessage);
      resolve(received);
    }, graceMs);
  });
}

describe("参加者イベント通知・TTSトグル初期化（結合テスト・実WSサーバー）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  let speechStreams: MockRecognizeStream[];
  // このテストは仮トークン("dummy-token")での join を前提にしている
  // （招待フロー未実装のため、正規のSupabase/ゲストJWTは発行できない）。
  // bd-0jy で join 検証が本実装（strict）化されたため、このテストの意図
  // （参加者イベント通知・TTSトグルの検証）を壊さない最小対応として
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
    setTranslateClient(createMockTranslateClient((text) => `[EN]${text}`));
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

  it("2人目のjoin時、在室中の1人目へ participant_joined が配信される（participantId・表示名を検証）", async () => {
    const port = getPort(wss);
    const roomId = `participant-events-joined-${Date.now()}`;

    const client1 = connect(port);
    await waitForOpen(client1);
    const joined1Promise = collectMessages(client1, 1);
    client1.send(JSON.stringify(makeJoin(roomId, "owner", { displayName: "Alice" })));
    await joined1Promise;

    // 2人目のjoinより前に、1人目の次のメッセージ待受を開始しておく
    const participantJoinedPromise = collectMessages(client1, 1);

    const client2 = connect(port);
    await waitForOpen(client2);
    const joined2Promise = collectMessages(client2, 1);
    client2.send(
      JSON.stringify(makeJoin(roomId, "guest", { displayName: "Bob", language: "en-US" })),
    );
    const [joined2] = await joined2Promise;

    const [participantJoinedEvent] = await participantJoinedPromise;

    expect(participantJoinedEvent.type).toBe("participant_joined");
    expect(participantJoinedEvent.participant).toMatchObject({
      participantId: joined2.participantId,
      displayName: "Bob",
    });
  });

  it("2人目の切断時、1人目へ participant_left が配信される", async () => {
    const port = getPort(wss);
    const roomId = `participant-events-left-${Date.now()}`;

    const client1 = connect(port);
    await waitForOpen(client1);
    const joined1Promise = collectMessages(client1, 1);
    client1.send(JSON.stringify(makeJoin(roomId, "owner")));
    await joined1Promise;

    const client2 = connect(port);
    await waitForOpen(client2);
    const joined2Promise = collectMessages(client2, 1);
    client2.send(JSON.stringify(makeJoin(roomId, "guest")));
    const [joined2] = await joined2Promise;

    const participantLeftPromise = collectMessages(client1, 1);
    const close2 = waitForClose(client2);
    client2.close();
    await close2;

    const [participantLeftEvent] = await participantLeftPromise;

    expect(participantLeftEvent.type).toBe("participant_left");
    expect(participantLeftEvent.participantId).toBe(joined2.participantId);
  });

  it("聞き手が join(enableTts:true) でjoin→話者がstart→final→commit→聞き手にaudioメッセージが届く", async () => {
    const port = getPort(wss);
    const roomId = `participant-events-tts-join-${Date.now()}`;

    // 話者（owner, ja-JP）
    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await ownerJoinedPromise;

    // 聞き手（guest, en-US）: join時点で enableTts:true を指定し、start は呼ばない
    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(
      JSON.stringify(makeJoin(roomId, "guest", { language: "en-US", enableTts: true })),
    );
    await guestJoinedPromise;

    // 話者のみ録音開始（1つ目のSTTストリームが割り当てられる）
    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", enableTts: false })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(speechStreams[0].on).toHaveBeenCalled();

    const ownerFinalPromise = collectMessages(owner, 1); // transcript_final
    speechStreams[0].emit("data", {
      results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
    });
    await ownerFinalPromise;

    // owner: utterance_committed → message(own) の2件
    const ownerRoutedPromise = collectMessages(owner, 2);
    // guest: message(translated) → audio の2件（enableTtsがjoinから伝播していれば届く）
    const guestRoutedPromise = collectMessages(guest, 2);
    owner.send(JSON.stringify({ type: "commit" }));

    const [, guestMessages] = await Promise.all([ownerRoutedPromise, guestRoutedPromise]);

    expect(guestMessages[0]).toMatchObject({
      type: "message",
      displayText: "[EN]こんにちは",
      isOwnMessage: false,
    });
    expect(guestMessages[1]).toMatchObject({
      type: "audio",
      mimeType: "audio/mpeg",
    });
    expect(typeof guestMessages[1].data).toBe("string");
  });

  it("聞き手が update_settings(enableTts:false) を送った後は audio が届かない（messageは届く）", async () => {
    const port = getPort(wss);
    const roomId = `participant-events-tts-update-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(
      JSON.stringify(makeJoin(roomId, "guest", { language: "en-US", enableTts: true })),
    );
    await guestJoinedPromise;

    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", enableTts: false })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(speechStreams[0].on).toHaveBeenCalled();

    // --- 1回目の発話: enableTts:true のままなので audio が届くはず（前提確認） ---
    const ownerFinal1Promise = collectMessages(owner, 1);
    speechStreams[0].emit("data", {
      results: [{ alternatives: [{ transcript: "こんにちは" }], isFinal: true }],
    });
    await ownerFinal1Promise;

    const ownerRouted1Promise = collectMessages(owner, 2);
    const guestRouted1Promise = collectMessages(guest, 2);
    owner.send(JSON.stringify({ type: "commit" }));
    const [, guestMessages1] = await Promise.all([ownerRouted1Promise, guestRouted1Promise]);
    expect(guestMessages1[1]).toMatchObject({ type: "audio" });

    // --- update_settings で enableTts:false に更新 ---
    guest.send(JSON.stringify({ type: "update_settings", enableTts: false }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // --- 2回目の発話: enableTts:false になっているため audio は届かず、message のみ届く ---
    const ownerFinal2Promise = collectMessages(owner, 1);
    speechStreams[0].emit("data", {
      results: [{ alternatives: [{ transcript: "さようなら" }], isFinal: true }],
    });
    await ownerFinal2Promise;

    const ownerRouted2Promise = collectMessages(owner, 2);
    owner.send(JSON.stringify({ type: "commit" }));
    await ownerRouted2Promise;

    const guestMessages2 = await collectMessagesForGracePeriod(guest, 400);

    expect(guestMessages2).toHaveLength(1);
    expect(guestMessages2[0]).toMatchObject({
      type: "message",
      displayText: "[EN]さようなら",
      isOwnMessage: false,
    });
    expect(guestMessages2).not.toContainEqual(expect.objectContaining({ type: "audio" }));
  });
});
