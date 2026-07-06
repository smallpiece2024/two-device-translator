/**
 * 言語検出モード（FR-4.3・D-9・bd-ecb）の結合テスト。
 *
 * 実 WS サーバー（startServer）を使い、SpeechClient のみモックへ差し替える
 * （GCP への実接続は行わない）。`start.detectLanguage=true` で録音開始した
 * 話者の STT が languageCode 付きの final を返した際、話者言語が確定し、
 * ルーム内の全参加者（本人含む）へ `participant_updated` が配信されることを検証する。
 *
 * @see server/index.ts（broadcastLanguageDetected）
 * @see server/room/session.ts（startRecording の detectLanguage 配線）
 * @see server/room/languageDetection.ts
 * @see tests/integration/pipeline.test.ts（モック方式・WSテストヘルパーの流儀）
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { SpeechClient } from "@google-cloud/speech";
import { startServer } from "../../server/index";
import { setSpeechClient, resetSpeechClient } from "../../server/gcp/speechStream";
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
// WS テストヘルパー（pipeline.test.ts と同様の流儀）
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
    detectLanguage: false,
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

/**
 * 接続直後から全メッセージを蓄積し続けるリスナーを登録する。
 * 「先に届いてしまった参加通知を後からの collectMessages() が取りこぼす」
 * レース（joinの非同期処理により他参加者への通知タイミングが読みづらい）を
 * 避けるため、このテストでは各接続に対してテスト冒頭から常時蓄積し、
 * 期待メッセージが現れるまでポーリングする方式を採る。
 */
function trackMessages(ws: WebSocket): ServerMessage[] {
  const received: ServerMessage[] = [];
  ws.on("message", (data: WebSocket.RawData) => {
    received.push(JSON.parse(data.toString("utf8")) as ServerMessage);
  });
  return received;
}

/** `predicate` を満たすメッセージが現れるまでポーリングして待つ（タイムアウト付き） */
async function waitForMessageMatching(
  received: ServerMessage[],
  predicate: (m: ServerMessage) => boolean,
  timeoutMs = 3000,
): Promise<ServerMessage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = received.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `waitForMessageMatching: timed out after ${timeoutMs}ms. received=${JSON.stringify(received)}`,
  );
}

describe("言語検出モード（FR-4.3・D-9）結合テスト（実WSサーバー・GCPモック）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  let speechStreams: MockRecognizeStream[];
  // pipeline.test.ts と同様、招待フロー未実装のためダミートークンでの join を
  // 前提にする（AUTH_MODE=insecure で join 検証をバイパスする）。
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
    if (!wss) {
      done();
      return;
    }
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => setTimeout(done, 50));
  });

  it("detectLanguage:trueで開始したownerのSTTがlanguageCode付きfinalを返すと、owner/guest両方にparticipant_updated（検出言語）が届く", async () => {
    const port = getPort(wss);
    const roomId = `lang-detect-${Date.now()}`;

    // --- 1. join: owner(ja-JP), guest(en-US) ---
    // 接続直後から全メッセージを蓄積する（他参加者への通知タイミングの
    // レースを避けるため、pipeline.test.ts の collectMessages 方式ではなく
    // 常時蓄積＋ポーリング方式を使う）。
    const owner = connect(port);
    await waitForOpen(owner);
    const ownerReceived = trackMessages(owner);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await waitForMessageMatching(ownerReceived, (m) => m.type === "joined");

    const guest = connect(port);
    await waitForOpen(guest);
    const guestReceived = trackMessages(guest);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await waitForMessageMatching(guestReceived, (m) => m.type === "joined");

    // --- 2. owner が detectLanguage:true で録音開始（1つ目のSTTストリームが割り当てられる） ---
    owner.send(
      JSON.stringify(makeStart({ sourceLanguage: "ja-JP", detectLanguage: true, enableTts: false })),
    );
    guest.send(JSON.stringify(makeStart({ sourceLanguage: "en-US", enableTts: false })));

    // start メッセージはソケット経由で非同期に到達するため、処理完了まで待つ
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(speechStreams[0].on).toHaveBeenCalled();

    // --- 3. owner の STT が languageCode="en-US" 付きの final を発火（言語誤判定・実際は英語で話した想定） ---
    speechStreams[0].emit("data", {
      results: [
        { alternatives: [{ transcript: "Hello" }], isFinal: true, languageCode: "en-US" },
      ],
    });

    // owner自身にも participant_updated が配信される（本人含む全員配信）
    const ownerUpdated = await waitForMessageMatching(
      ownerReceived,
      (m) => m.type === "participant_updated",
    );
    expect(ownerUpdated).toMatchObject({ type: "participant_updated", language: "en-US" });

    // guest にも同内容の participant_updated が配信される
    const guestUpdated = await waitForMessageMatching(
      guestReceived,
      (m) => m.type === "participant_updated",
    );
    expect(guestUpdated).toMatchObject({ type: "participant_updated", language: "en-US" });

    // 両方とも同一の話者（owner）の participantId を指す
    expect(
      (guestUpdated as Extract<ServerMessage, { type: "participant_updated" }>).participantId,
    ).toBe((ownerUpdated as Extract<ServerMessage, { type: "participant_updated" }>).participantId);
  });

  it("detectLanguage:falseで開始した場合、STTがlanguageCode付きfinalを返してもparticipant_updatedは配信されない", async () => {
    const port = getPort(wss);
    const roomId = `lang-detect-off-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerReceived = trackMessages(owner);
    owner.send(JSON.stringify(makeJoin(roomId, "owner", { language: "ja-JP" })));
    await waitForMessageMatching(ownerReceived, (m) => m.type === "joined");

    const guest = connect(port);
    await waitForOpen(guest);
    const guestReceived = trackMessages(guest);
    guest.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    await waitForMessageMatching(guestReceived, (m) => m.type === "joined");

    owner.send(JSON.stringify(makeStart({ sourceLanguage: "ja-JP", detectLanguage: false })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    speechStreams[0].emit("data", {
      results: [
        { alternatives: [{ transcript: "Hello" }], isFinal: true, languageCode: "en-US" },
      ],
    });

    // transcript_final（detectLanguage:falseでも通常配信されるメッセージ）が
    // 届くのを待つことで、final処理の非同期完了を確認してから
    // participant_updated が届いていないことを検証する。
    await waitForMessageMatching(ownerReceived, (m) => m.type === "transcript_final");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(guestReceived).not.toContainEqual(
      expect.objectContaining({ type: "participant_updated" }),
    );
    expect(ownerReceived).not.toContainEqual(
      expect.objectContaining({ type: "participant_updated" }),
    );
  });
});
