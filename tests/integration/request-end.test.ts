/**
 * request_end（オーナーによるルーム明示終了、bd-e3p）の結合テスト。
 *
 * - オーナーからの request_end: 全参加者へ room_ended(reason:"owner_ended") が配信され、
 *   サーバー側から接続がcloseされる
 * - ゲスト（非オーナー）からの request_end: 拒否される（権限昇格がないことを確認する）
 *
 * AUTH_MODE=insecure を使い、join.role をそのまま識別情報として使う
 * （実 Supabase / ゲストJWT を経由しない。tests/integration/room-join.test.ts と同じ方針）。
 *
 * @see server/index.ts（request_end ハンドラ、finalizeRoomEnd）
 * @see server/room/roomManager.ts（endRoom）
 * @see shared/ws-protocol/schema.ts（requestEndSchema, roomEndedSchema）
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer } from "../../server/index";
import {
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";
import type { JoinMessage, ServerMessage } from "@shared/index";

describe("WS server - request_end（ルーム明示終了、bd-e3p）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];
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

  /**
   * finalizeRoomEnd が呼ぶ markRoomEnded（実Supabase接続）を回避するため、
   * from("rooms").update().eq() のみをモックした最小クライアントを注入する
   * （実 Supabase への通信は行わない）。
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

  function waitForClose(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      ws.once("close", (code: number) => resolve(code));
    });
  }

  /** 指定した猶予時間内に届いたメッセージをすべて集める（届かなくてもタイムアウトしない） */
  function collectMessagesForGracePeriod(ws: WebSocket, graceMs = 300): Promise<ServerMessage[]> {
    return new Promise((resolve) => {
      const received: ServerMessage[] = [];
      const onMessage = (data: WebSocket.RawData) => {
        received.push(JSON.parse(data.toString("utf8")) as ServerMessage);
      };
      ws.on("message", onMessage);
      setTimeout(() => {
        ws.off("message", onMessage);
        resolve(received);
      }, graceMs);
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

  beforeEach(async () => {
    wss = startServer(0, HOST);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
  });

  afterEach((done) => {
    clients.forEach((client) => client.terminate());
    clients = [];
    if (!wss) {
      done();
      return;
    }
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => setTimeout(done, 50));
  });

  it(
    "オーナーがrequest_endを送ると、全参加者へroom_ended(reason:owner_ended)が配信され、" +
      "サーバー側から接続がcloseされる",
    async () => {
      const port = getPort(wss);
      const roomId = `request-end-owner-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const guest = connect(port);
      await waitForOpen(guest);
      const guestJoinedPromise = waitForMessage(guest);
      guest.send(JSON.stringify(makeJoin(roomId, "guest")));
      await guestJoinedPromise;

      const ownerRoomEndedPromise = waitForMessage(owner);
      const guestRoomEndedPromise = waitForMessage(guest);
      const ownerClosePromise = waitForClose(owner);
      const guestClosePromise = waitForClose(guest);

      owner.send(JSON.stringify({ type: "request_end" }));

      const [ownerRoomEnded, guestRoomEnded] = await Promise.all([
        ownerRoomEndedPromise,
        guestRoomEndedPromise,
      ]);
      expect(ownerRoomEnded).toEqual({ type: "room_ended", reason: "owner_ended" });
      expect(guestRoomEnded).toEqual({ type: "room_ended", reason: "owner_ended" });

      const [ownerCloseCode, guestCloseCode] = await Promise.all([
        ownerClosePromise,
        guestClosePromise,
      ]);
      expect(ownerCloseCode).toBe(1000);
      expect(guestCloseCode).toBe(1000);
      expect(owner.readyState).toBe(WebSocket.CLOSED);
      expect(guest.readyState).toBe(WebSocket.CLOSED);
    },
  );

  it(
    "ゲスト（非オーナー）がrequest_endを送っても拒否され、ルームは終了しない" +
      "（権限昇格がないことを確認する）",
    async () => {
      const port = getPort(wss);
      const roomId = `request-end-guest-rejected-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const guest = connect(port);
      await waitForOpen(guest);
      const guestJoinedPromise = waitForMessage(guest);
      guest.send(JSON.stringify(makeJoin(roomId, "guest")));
      await guestJoinedPromise;

      const guestErrorPromise = waitForMessage(guest);
      guest.send(JSON.stringify({ type: "request_end" }));
      const guestError = (await guestErrorPromise) as Extract<ServerMessage, { type: "error" }>;

      expect(guestError.type).toBe("error");
      expect(guestError.fatal).toBe(false);
      expect(guestError.message).toMatch(/owner/i);

      // ゲストの接続は維持される（fatal:falseのため）
      expect(guest.readyState).toBe(WebSocket.OPEN);
      // ownerへroom_endedが送られていない（ルームは終了していない）ことを猶予期間内で確認する
      const ownerMessages = await collectMessagesForGracePeriod(owner, 300);
      expect(ownerMessages).not.toContainEqual(expect.objectContaining({ type: "room_ended" }));
      expect(owner.readyState).toBe(WebSocket.OPEN);

      // ルームがactiveのままであることを、オーナー自身のrequest_endが正常に成立することで確認する
      const ownerRoomEndedPromise = waitForMessage(owner);
      owner.send(JSON.stringify({ type: "request_end" }));
      const ownerRoomEnded = await ownerRoomEndedPromise;
      expect(ownerRoomEnded).toEqual({ type: "room_ended", reason: "owner_ended" });
    },
  );
});
