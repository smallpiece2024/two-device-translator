/**
 * `playback_state` → `peer_playback_state` 中継の結合テスト（bd-rwi）。
 *
 * 実際の WebSocketServer を起動し（port: 0 でOS割当）、同室の2クライアントで
 * 以下を検証する:
 *
 * 1. A が `playback_state{playing:true}` を送ると、B に
 *    `peer_playback_state{participantId:A, playing:true}` が届く
 * 2. 送信者本人（A）には `peer_playback_state` が届かない
 * 3. `playing:false` も同様に中継される
 *
 * ハーネスは tests/integration/participant-events.test.ts と同じパターン
 * （AUTH_MODE=insecure、GCPクライアントはモック差し替え）。
 *
 * @see server/index.ts（"playback_state" ハンドラ）
 * @see shared/ws-protocol/schema.ts（playbackStateSchema / peerPlaybackStateSchema）
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawMessage = Record<string, any>;

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
    translate: jest.fn().mockImplementation(async (text: string) => [text]),
  } as unknown as v2.Translate;
}

function createMockTtsClient(): TextToSpeechClient {
  return {
    synthesizeSpeech: jest
      .fn()
      .mockImplementation(async () => [{ audioContent: Buffer.from("fake") }]),
  } as unknown as TextToSpeechClient;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** 条件を満たすメッセージが届くまで待つ */
function waitForMessage(
  ws: WebSocket,
  predicate: (message: RawMessage) => boolean,
  timeoutMs = 2500,
): Promise<RawMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("waitForMessage timeout"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString("utf8")) as RawMessage;
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(message);
      }
    };
    ws.on("message", onMessage);
  });
}

/** 猶予時間内に届いたメッセージをすべて集める（届かなくてもタイムアウトしない） */
function collectForGracePeriod(ws: WebSocket, graceMs = 400): Promise<RawMessage[]> {
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

describe("playback_state の中継（結合テスト・実WSサーバー、bd-rwi）", () => {
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
    process.env.AUTH_MODE = "insecure";

    setSpeechClient(createMockSpeechClient());
    setTranslateClient(createMockTranslateClient());
    setTtsClient(createMockTtsClient());

    wss = startServer(0, HOST);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
  });

  afterEach(async () => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }

    // 各クライアントの close 完了を待つ（サーバー側 close ハンドラのログが
    // テスト終了後に漏れて "Cannot log after tests are done" にならないように）。
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            client.once("close", () => resolve());
            client.terminate();
          }),
      ),
    );
    clients = [];
    // サーバー側の close ハンドラ（console.log）が走り切るまで1tick待つ。
    await new Promise((resolve) => setTimeout(resolve, 50));

    resetSpeechClient();
    resetTranslateClient();
    resetTtsClient();
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  async function joinTwoClients(roomId: string): Promise<{
    owner: WebSocket;
    guest: WebSocket;
    ownerId: string;
  }> {
    const port = getPort(wss);

    const owner = connect(port);
    await waitForOpen(owner);
    owner.send(
      JSON.stringify({
        type: "join",
        roomId,
        role: "owner",
        token: "dummy-token",
        language: "ja-JP",
      }),
    );
    const ownerJoined = await waitForMessage(owner, (m) => m.type === "joined");

    const guest = connect(port);
    await waitForOpen(guest);
    guest.send(
      JSON.stringify({
        type: "join",
        roomId,
        role: "guest",
        token: "dummy-token",
        language: "en-US",
      }),
    );
    await waitForMessage(guest, (m) => m.type === "joined");

    return { owner, guest, ownerId: ownerJoined.participantId as string };
  }

  it("playback_state(playing:true/false)が同室の他参加者へpeer_playback_stateとして中継される", async () => {
    const { owner, guest, ownerId } = await joinTwoClients("room-relay-1");

    owner.send(JSON.stringify({ type: "playback_state", playing: true }));
    const playingTrue = await waitForMessage(
      guest,
      (m) => m.type === "peer_playback_state" && m.playing === true,
    );
    expect(playingTrue.participantId).toBe(ownerId);

    owner.send(JSON.stringify({ type: "playback_state", playing: false }));
    const playingFalse = await waitForMessage(
      guest,
      (m) => m.type === "peer_playback_state" && m.playing === false,
    );
    expect(playingFalse.participantId).toBe(ownerId);
  });

  it("送信者本人にはpeer_playback_stateが返らない", async () => {
    const { owner } = await joinTwoClients("room-relay-2");

    owner.send(JSON.stringify({ type: "playback_state", playing: true }));
    const receivedByOwner = await collectForGracePeriod(owner, 400);

    expect(
      receivedByOwner.filter((m) => m.type === "peer_playback_state"),
    ).toHaveLength(0);
  });
});
