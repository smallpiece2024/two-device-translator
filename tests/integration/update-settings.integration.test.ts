/**
 * update_settings（bd-fki: language/displayName拡張）の結合テスト。
 *
 * 実際の WebSocketServer を起動し（port: 0 でOS割当）、`update_settings` で
 * language/displayName を変更した際に、本人を含む全参加者へ
 * `participant_updated` が配信されること、および変更がない場合には配信
 * されないことを検証する（`server/index.ts` `update_settings` ハンドラ、
 * `docs/design/websocket-protocol.md` `update_settings`/`participant_updated`
 * 節参照）。
 *
 * `tests/integration/participant-events.test.ts` の WS テストヘルパー
 * （実サーバー起動・AUTH_MODE=insecure・makeJoin）の流儀を踏襲する。
 *
 * @see server/index.ts
 * @see shared/ws-protocol/schema.ts
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

function createMockSpeechClient(): SpeechClient {
  return {
    streamingRecognize: jest.fn().mockImplementation(() => ({
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn().mockReturnThis(),
    })),
  } as unknown as SpeechClient;
}

function createMockTranslateClient(): v2.Translate {
  return {
    translate: jest.fn().mockResolvedValue(["[EN]dummy"]),
  } as unknown as v2.Translate;
}

function createMockTtsClient(): TextToSpeechClient {
  return {
    synthesizeSpeech: jest.fn().mockResolvedValue([{ audioContent: Buffer.from("fake") }]),
  } as unknown as TextToSpeechClient;
}

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

describe("update_settings（language/displayName変更）の participant_updated 配信（結合テスト・実WSサーバー）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
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
    // 招待フロー未実装のため、tests/integration/participant-events.test.ts と
    // 同じ方針で AUTH_MODE=insecure を明示する（server/auth/verifyParticipant.ts 参照）。
    process.env.AUTH_MODE = "insecure";

    setSpeechClient(createMockSpeechClient());
    setTranslateClient(createMockTranslateClient());
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

  it("update_settings(language)変更で本人・相手の両方に participant_updated が届く", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-language-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    const [ownerJoined] = await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    // owner が言語を en-US に変更する
    const ownerParticipantUpdatedPromise = collectMessages(owner, 1);
    const guestParticipantUpdatedPromise = collectMessages(guest, 1);
    owner.send(JSON.stringify({ type: "update_settings", enableTts: true, language: "en-US" }));

    const [ownerEvent, guestEvent] = await Promise.all([
      ownerParticipantUpdatedPromise,
      guestParticipantUpdatedPromise,
    ]);

    expect(ownerEvent[0]).toMatchObject({
      type: "participant_updated",
      participantId: ownerJoined.participantId,
      language: "en-US",
    });
    expect(guestEvent[0]).toMatchObject({
      type: "participant_updated",
      participantId: ownerJoined.participantId,
      language: "en-US",
    });
  });

  it("update_settings(displayName)変更で本人・相手の両方に participant_updated が届く", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-displayname-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(
      JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP", displayName: "たろう" })),
    );
    const [ownerJoined] = await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    const ownerParticipantUpdatedPromise = collectMessages(owner, 1);
    const guestParticipantUpdatedPromise = collectMessages(guest, 1);
    owner.send(
      JSON.stringify({ type: "update_settings", enableTts: true, displayName: "じろう" }),
    );

    const [ownerEvent, guestEvent] = await Promise.all([
      ownerParticipantUpdatedPromise,
      guestParticipantUpdatedPromise,
    ]);

    expect(ownerEvent[0]).toMatchObject({
      type: "participant_updated",
      participantId: ownerJoined.participantId,
      displayName: "じろう",
    });
    expect(guestEvent[0]).toMatchObject({
      type: "participant_updated",
      participantId: ownerJoined.participantId,
      displayName: "じろう",
    });
  });

  it("update_settings(enableTtsのみ・language/displayName未変更)では participant_updated が配信されない", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-no-change-${Date.now()}`;

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

    // enableTts のみ変更（language/displayName は未指定 = 変更なし）
    owner.send(JSON.stringify({ type: "update_settings", enableTts: false }));

    const ownerMessages = await collectMessagesForGracePeriod(owner, 300);
    const guestMessages = await collectMessagesForGracePeriod(guest, 300);

    expect(ownerMessages).toHaveLength(0);
    expect(guestMessages).toHaveLength(0);
  });

  it("update_settings(language を現在値と同じ値に指定)では participant_updated が配信されない", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-same-value-${Date.now()}`;

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

    // 現在値と同じ language を指定 = 実質変更なし
    owner.send(JSON.stringify({ type: "update_settings", enableTts: true, language: "ja-JP" }));

    const ownerMessages = await collectMessagesForGracePeriod(owner, 300);
    const guestMessages = await collectMessagesForGracePeriod(guest, 300);

    expect(ownerMessages).toHaveLength(0);
    expect(guestMessages).toHaveLength(0);
  });

  /**
   * レビュー対応（should-fix）: 録音中（`session.isRecording`）に届いた
   * `update_settings.language` はサーバー側で黙って無視する（session.language
   * を変更しない・`participant_updated` を配信しない）。STT は旧言語のまま
   * 認識を継続しているため、録音中に language だけ切り替わると直後に確定
   * する発話が誤った sourceLanguage として翻訳される事故になり得るため
   * （`server/index.ts` update_settings ハンドラのコメント参照）。
   * 録音停止後の同一変更は反映される、という対比も検証する。
   */
  it("録音中のupdate_settings(language)は無視され、録音停止後の同じ変更は反映される", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-recording-guard-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    const [ownerJoined] = await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    // 録音開始（session.isRecording = true になる）
    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP" })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // --- 録音中の language 変更: 無視される（participant_updated は配信されない） ---
    owner.send(JSON.stringify({ type: "update_settings", enableTts: true, language: "en-US" }));

    const ownerMessagesDuringRecording = await collectMessagesForGracePeriod(owner, 300);
    const guestMessagesDuringRecording = await collectMessagesForGracePeriod(guest, 300);

    expect(ownerMessagesDuringRecording).toHaveLength(0);
    expect(guestMessagesDuringRecording).toHaveLength(0);

    // --- 録音停止後、同じ変更を送ると反映される（対比） ---
    owner.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ownerParticipantUpdatedPromise = collectMessages(owner, 1);
    const guestParticipantUpdatedPromise = collectMessages(guest, 1);
    owner.send(JSON.stringify({ type: "update_settings", enableTts: true, language: "en-US" }));

    const [ownerEvent, guestEvent] = await Promise.all([
      ownerParticipantUpdatedPromise,
      guestParticipantUpdatedPromise,
    ]);

    expect(ownerEvent[0]).toMatchObject({
      type: "participant_updated",
      participantId: ownerJoined.participantId,
      language: "en-US",
    });
    expect(guestEvent[0]).toMatchObject({
      type: "participant_updated",
      language: "en-US",
    });
  });

  /**
   * レビュー対応（should-fix）: trim後に空文字となる `displayName`
   * （例: 半角スペースのみ）は「変更なし」として無視する（`session.displayName`
   * を変更しない・`participant_updated` を配信しない）。
   */
  it("trim後空文字のdisplayNameは無視され、participant_updatedが配信されない", async () => {
    const port = getPort(wss);
    const roomId = `update-settings-blank-displayname-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = collectMessages(owner, 1);
    owner.send(
      JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP", displayName: "たろう" })),
    );
    await ownerJoinedPromise;

    const guest = connect(port);
    await waitForOpen(guest);
    const guestJoinedPromise = collectMessages(guest, 1);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await guestJoinedPromise;

    // 半角スペースのみ = trim後空文字
    owner.send(JSON.stringify({ type: "update_settings", enableTts: true, displayName: "   " }));

    const ownerMessages = await collectMessagesForGracePeriod(owner, 300);
    const guestMessages = await collectMessagesForGracePeriod(guest, 300);

    expect(ownerMessages).toHaveLength(0);
    expect(guestMessages).toHaveLength(0);
  });
});
