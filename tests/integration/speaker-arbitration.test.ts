/**
 * 話者調停（audio_level / active_speaker、bd-6h1: 話者交代制）の結合テスト。
 *
 * 実際の WebSocketServer を起動し（port: 0 でOS割当）、同室の2クライアントで
 * 以下を検証する:
 *
 * 1. 発話活動（STT interim）で話者が確定し、`active_speaker` が**全参加者**へ
 *    配信される。非話者の STT 結果（transcript_interim）は配信されない（破棄）
 * 2. `audio_level` の音量差により、レベルの小さい側の発話活動は話者不在でも
 *    拒否される（相手の声を拾った誤認識の破棄）
 * 3. 発話区切りの確定（commit）で話者が解放され、`active_speaker: null` が
 *    配信される
 *
 * ハーネスは tests/integration/playback-state-relay.test.ts と同じパターン
 * （AUTH_MODE=insecure、GCPクライアントはモック差し替え）。STT ストリームは
 * data イベントのハンドラを記録する制御可能モックとし、テストから
 * interim/final を発火させる。
 *
 * @see server/index.ts（"audio_level" ハンドラ・話者調停の結線）
 * @see server/room/speakerArbitration.ts
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

/** テストから interim/final を発火できる、制御可能な STT ストリームモック */
interface ControllableStream {
  handlers: Map<string, (arg: unknown) => void>;
  emitInterim(text: string): void;
  emitFinal(text: string): void;
}

function createControllableSpeechClient(): {
  client: SpeechClient;
  streams: ControllableStream[];
} {
  const streams: ControllableStream[] = [];
  const client = {
    streamingRecognize: jest.fn().mockImplementation(() => {
      const handlers = new Map<string, (arg: unknown) => void>();
      const stream: ControllableStream = {
        handlers,
        emitInterim(text: string) {
          handlers.get("data")?.({
            results: [{ alternatives: [{ transcript: text }], isFinal: false }],
          });
        },
        emitFinal(text: string) {
          handlers.get("data")?.({
            results: [{ alternatives: [{ transcript: text }], isFinal: true }],
          });
        },
      };
      streams.push(stream);
      const nodeStream = {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn().mockImplementation((event: string, cb: (arg: unknown) => void) => {
          handlers.set(event, cb);
          return nodeStream;
        }),
      };
      return nodeStream;
    }),
  } as unknown as SpeechClient;
  return { client, streams };
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

describe("話者調停（結合テスト・実WSサーバー、bd-6h1）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  let originalAuthMode: string | undefined;
  let sttStreams: ControllableStream[];

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

    const controllable = createControllableSpeechClient();
    sttStreams = controllable.streams;
    setSpeechClient(controllable.client);
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    resetSpeechClient();
    resetTranslateClient();
    resetTtsClient();
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  function sendStart(ws: WebSocket, sourceLanguage: string): void {
    ws.send(
      JSON.stringify({
        type: "start",
        sourceLanguage,
        enableTts: false,
        chunkMs: 250,
        silenceMs: 60000, // テスト中に無音自動確定が走らないよう長めにする
        maxChars: 1000,
        maxSeconds: 600,
      }),
    );
  }

  /**
   * オーナー・ゲストの2クライアントを join させ、両者の録音を開始する。
   * STT ストリームは start 順に生成されるため、sttStreams[0]=オーナー、
   * sttStreams[1]=ゲスト（start を直列に送り、ストリーム生成を待って確定させる）。
   */
  async function setupTwoRecordingClients(roomId: string): Promise<{
    owner: WebSocket;
    guest: WebSocket;
    ownerId: string;
    guestId: string;
    ownerStt: ControllableStream;
    guestStt: ControllableStream;
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
    const guestJoined = await waitForMessage(guest, (m) => m.type === "joined");

    sendStart(owner, "ja-JP");
    await waitFor(() => sttStreams.length === 1);
    sendStart(guest, "en-US");
    await waitFor(() => sttStreams.length === 2);

    return {
      owner,
      guest,
      ownerId: ownerJoined.participantId as string,
      guestId: guestJoined.participantId as string,
      ownerStt: sttStreams[0],
      guestStt: sttStreams[1],
    };
  }

  /** 条件が真になるまでポーリングで待つ（メッセージ以外の状態待ち用） */
  function waitFor(condition: () => boolean, timeoutMs = 2500): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (condition()) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("waitFor timeout"));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it("発話活動で話者が確定してactive_speakerが全参加者へ配信され、非話者のSTT結果は破棄される", async () => {
    const { owner, guest, ownerId, ownerStt, guestStt } =
      await setupTwoRecordingClients("room-arb-1");

    // 発火前にリスナーを張る（active_speaker と transcript_interim は同時に
    // 届くため、await 後にリスナーを張ると取りこぼす）
    const ownerActivePromise = waitForMessage(owner, (m) => m.type === "active_speaker");
    const guestActivePromise = waitForMessage(guest, (m) => m.type === "active_speaker");
    const ownerInterimPromise = waitForMessage(
      owner,
      (m) => m.type === "transcript_interim",
    );

    // オーナーが話し始める（interim 到着）
    ownerStt.emitInterim("こんにちは");

    // 全参加者（本人＋相手）へ active_speaker が配信される
    const [toOwner, toGuest] = await Promise.all([ownerActivePromise, guestActivePromise]);
    expect(toOwner.participantId).toBe(ownerId);
    expect(toGuest.participantId).toBe(ownerId);

    // 本人には transcript_interim が届く
    await ownerInterimPromise;

    // 話者確定中、ゲスト側 STT の結果（相手の声を拾った誤認識）は破棄される。
    // interim だけでなく final も破棄され、message（翻訳配信）にも至らない。
    const guestReceivedPromise = collectForGracePeriod(guest, 400);
    const ownerReceivedPromise = collectForGracePeriod(owner, 400);
    guestStt.emitInterim("garbled crosstalk");
    guestStt.emitFinal("garbled crosstalk");
    guest.send(JSON.stringify({ type: "commit" }));
    const [guestReceived, ownerReceived] = await Promise.all([
      guestReceivedPromise,
      ownerReceivedPromise,
    ]);
    expect(guestReceived.filter((m) => m.type === "transcript_interim")).toHaveLength(0);
    expect(guestReceived.filter((m) => m.type === "transcript_final")).toHaveLength(0);
    expect(guestReceived.filter((m) => m.type === "utterance_committed")).toHaveLength(0);
    // 破棄された発話は相手（オーナー）へも配信されない
    expect(ownerReceived.filter((m) => m.type === "message")).toHaveLength(0);
  });

  it("audio_levelの音量差により、レベルの小さい側の発話活動は話者不在でも拒否される", async () => {
    const { owner, guest, ownerId, ownerStt, guestStt } =
      await setupTwoRecordingClients("room-arb-2");

    // オーナー側の音が明確に大きい（オーナーが話している）
    owner.send(JSON.stringify({ type: "audio_level", level: 0.5 }));
    guest.send(JSON.stringify({ type: "audio_level", level: 0.1 }));
    // audio_level の処理（サーバー到達）を待つ: ゲスト側 interim の拒否で確認するため
    // 少し待ってから発火する
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ゲスト端末の STT が先に interim を出しても（相手の声を拾った）、拒否される
    const guestReceivedPromise = collectForGracePeriod(guest, 400);
    guestStt.emitInterim("picked up other voice");
    const guestReceived = await guestReceivedPromise;
    expect(guestReceived.filter((m) => m.type === "transcript_interim")).toHaveLength(0);
    expect(guestReceived.filter((m) => m.type === "active_speaker")).toHaveLength(0);

    // レベルの大きいオーナーの interim は採用され、話者に確定する
    ownerStt.emitInterim("こんにちは");
    const activeSpeaker = await waitForMessage(guest, (m) => m.type === "active_speaker");
    expect(activeSpeaker.participantId).toBe(ownerId);
  });

  it("発話区切りの確定（commit）で話者が解放され、active_speaker: null が配信される", async () => {
    const { owner, guest, ownerId, ownerStt } =
      await setupTwoRecordingClients("room-arb-3");

    // オーナーが話して final まで到達
    ownerStt.emitInterim("こんにちは");
    ownerStt.emitFinal("こんにちは");
    await waitForMessage(owner, (m) => m.type === "transcript_final");
    await waitForMessage(
      guest,
      (m) => m.type === "active_speaker" && m.participantId === ownerId,
    );

    // 手動区切り（commit）→ 発話確定 → 話者解放
    owner.send(JSON.stringify({ type: "commit" }));
    const [releasedToOwner, releasedToGuest] = await Promise.all([
      waitForMessage(owner, (m) => m.type === "active_speaker" && m.participantId === null),
      waitForMessage(guest, (m) => m.type === "active_speaker" && m.participantId === null),
    ]);
    expect(releasedToOwner.participantId).toBeNull();
    expect(releasedToGuest.participantId).toBeNull();

    // 解放後はゲストが話者になれる
    const guestStt = sttStreams[1];
    guestStt.emitInterim("hello");
    const nextSpeaker = await waitForMessage(guest, (m) => m.type === "active_speaker");
    expect(nextSpeaker.participantId).not.toBeNull();
    expect(nextSpeaker.participantId).not.toBe(ownerId);
  });
});
