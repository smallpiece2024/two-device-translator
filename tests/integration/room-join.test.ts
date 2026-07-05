/**
 * WS server の join / RoomManager 連携の結合テスト。
 * 実際に WebSocketServer を起動し（port: 0 でOS割当）、複数クライアントで
 * join / leave の一連の流れを検証する。
 *
 * @see server/index.ts
 * @see server/room/roomManager.ts
 * @see docs/design/websocket-protocol.md
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer } from "../../server/index";
import {
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";
import type { JoinMessage, ServerMessage } from "@shared/index";

describe("WS server - room join (RoomManager結合テスト)", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
  // このテストは仮トークン("dummy-token")での join を前提にしている
  // （招待フロー未実装のため、正規のSupabase/ゲストJWTは発行できない）。
  // bd-0jy で join 検証が本実装（strict）化されたため、このテストの意図
  // （RoomManager連携の検証）を壊さない最小対応として AUTH_MODE=insecure
  // を明示し、Phase1相当のダミー検証を使う
  // （server/auth/verifyParticipant.ts「移行互換モード」参照）。
  let originalAuthMode: string | undefined;

  beforeAll(() => {
    originalAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "insecure";
  });

  afterAll(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

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

  function waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      ws.once("message", (data) => {
        try {
          resolve(JSON.parse(data.toString("utf8")) as ServerMessage);
        } catch (err) {
          reject(err);
        }
      });
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

  /**
   * 自動終了テストが finalizeRoomEnd → markRoomEnded を経由するため、
   * 実Supabase接続を避けるモックを注入する。
   */
  beforeEach(() => {
    const eq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ update });
    setSupabaseAdminClient({ from } as never);
  });

  afterEach(() => {
    resetSupabaseAdminClient();
  });

  beforeEach(async () => {
    wss = startServer(0, HOST);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
  });

  afterEach((done) => {
    // クライアント・サーバーのソケットを確実にすべて閉じ、ハンドルリークを防ぐ
    clients.forEach((client) => client.terminate());
    clients = [];
    if (!wss) {
      done();
      return;
    }
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => setTimeout(done, 50));
  });

  it("join前に他のメッセージを送るとerror(fatal:false)が返り、接続が維持される", async () => {
    const port = getPort(wss);
    const client = connect(port);
    await waitForOpen(client);

    const messagePromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "commit" }));
    const message = await messagePromise;

    expect(message).toEqual({
      type: "error",
      message: "join message is required before any other message",
      fatal: false,
    });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("2クライアントが同一roomIdへjoinすると両方がjoinedを受信し、2人目のjoinedには参加者2人分が含まれる", async () => {
    const port = getPort(wss);
    const roomId = `room-${Date.now()}`;

    const client1 = connect(port);
    await waitForOpen(client1);
    const joined1Promise = waitForMessage(client1);
    client1.send(JSON.stringify(makeJoin(roomId, "owner")));
    const joined1 = (await joined1Promise) as Extract<ServerMessage, { type: "joined" }>;

    expect(joined1.type).toBe("joined");
    expect(typeof joined1.participantId).toBe("string");
    expect(joined1.participantId.length).toBeGreaterThan(0);
    expect(joined1.room).toEqual({ id: roomId, status: "active" });
    expect(joined1.participants).toHaveLength(1);
    expect(joined1.participants[0]).toMatchObject({
      participantId: joined1.participantId,
      role: "owner",
      present: true,
    });

    const client2 = connect(port);
    await waitForOpen(client2);
    const joined2Promise = waitForMessage(client2);
    client2.send(JSON.stringify(makeJoin(roomId, "guest", { language: "en-US" })));
    const joined2 = (await joined2Promise) as Extract<ServerMessage, { type: "joined" }>;

    expect(joined2.type).toBe("joined");
    expect(joined2.participantId).not.toBe(joined1.participantId);
    expect(joined2.room).toEqual({ id: roomId, status: "active" });
    expect(joined2.participants).toHaveLength(2);

    const ids = joined2.participants.map((p) => p.participantId).sort();
    expect(ids).toEqual([joined1.participantId, joined2.participantId].sort());

    const guestSummary = joined2.participants.find(
      (p) => p.participantId === joined2.participantId,
    );
    expect(guestSummary).toMatchObject({ role: "guest", language: "en-US", present: true });
  });

  it("maxParticipants(既定2)を超える3人目のjoinは拒否され、既存の2人は影響を受けない", async () => {
    const port = getPort(wss);
    const roomId = `room-full-${Date.now()}`;

    const client1 = connect(port);
    await waitForOpen(client1);
    const joined1Promise = waitForMessage(client1);
    client1.send(JSON.stringify(makeJoin(roomId, "owner")));
    await joined1Promise;

    const client2 = connect(port);
    await waitForOpen(client2);
    const joined2Promise = waitForMessage(client2);
    client2.send(JSON.stringify(makeJoin(roomId, "guest")));
    await joined2Promise;

    const client3 = connect(port);
    await waitForOpen(client3);
    const errorPromise = waitForMessage(client3);
    client3.send(JSON.stringify(makeJoin(roomId, "guest")));
    const error3 = (await errorPromise) as Extract<ServerMessage, { type: "error" }>;

    expect(error3.type).toBe("error");
    expect(error3.fatal).toBe(false);
    expect(error3.message).toMatch(/full/i);
    // fatal:false のため3人目の接続自体は維持される（join待ち状態のまま）
    expect(client3.readyState).toBe(WebSocket.OPEN);

    // 既存の2人（client1, client2）は引き続き接続されたままであること
    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);
  });

  it(
    "close時はleaveされるのみでルームは即座に破棄されない。全員不在の状態が" +
      "autoEndThresholdMs継続すると自動終了し、以降の同一roomIdへのjoinは" +
      "errorではなくroom_ended(reason:auto_timeout)を受信した後に接続がcloseされる" +
      "（bd-e3p、must-fix1: leaveだけでは破棄されず、自動終了タイマー経由でendedになる仕様に変更）",
    async () => {
      // このテストのみ、しきい値を短く注入して自動終了を検証する
      // （固定sleepではなく、しきい値+十分な余裕を持たせた1回の待機で検証する）。
      wss.clients.forEach((client) => client.terminate());
      wss.close();
      await new Promise<void>((resolve) => wss.once("close", resolve));
      wss = startServer(0, HOST, { autoEndThresholdMs: 100 });
      await new Promise<void>((resolve) => wss.once("listening", resolve));

      const port = getPort(wss);
      const roomId = `room-autoend-${Date.now()}`;

      const client1 = connect(port);
      await waitForOpen(client1);
      const joined1Promise = waitForMessage(client1);
      client1.send(JSON.stringify(makeJoin(roomId, "owner")));
      await joined1Promise;

      const client2 = connect(port);
      await waitForOpen(client2);
      const joined2Promise = waitForMessage(client2);
      client2.send(JSON.stringify(makeJoin(roomId, "guest")));
      await joined2Promise;

      // 両クライアントをcloseし、サーバー側のleave処理（close イベント）完了を待つ
      const close1 = waitForClose(client1);
      const close2 = waitForClose(client2);
      client1.close();
      client2.close();
      await Promise.all([close1, close2]);

      // autoEndThresholdMs(100ms)より十分長く待ち、自動終了タイマーの発火を確実にする
      await new Promise((resolve) => setTimeout(resolve, 400));

      const client3 = connect(port);
      await waitForOpen(client3);
      const roomEndedPromise = waitForMessage(client3);
      const closePromise = new Promise<number>((resolve) => {
        client3.once("close", (code: number) => resolve(code));
      });
      client3.send(JSON.stringify(makeJoin(roomId, "owner")));
      const roomEnded = (await roomEndedPromise) as Extract<
        ServerMessage,
        { type: "room_ended" }
      >;

      expect(roomEnded).toEqual({ type: "room_ended", reason: "auto_timeout" });

      const closeCode = await closePromise;
      expect(closeCode).toBe(1000);
    },
  );
});
