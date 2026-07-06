/**
 * endedルームの再開（bd-gz1、FR-12.3）の結合テスト。
 *
 * - オーナーがrequest_endでルームを終了 → 同じオーナーが再joinすると再開し、
 *   joinedを受信して会話を再開できる
 * - オーナーの再joinでは常に markRoomActive（DB rooms.status を 'active' に戻す）が呼ばれる
 *
 * AUTH_MODE=insecure を使い、join.role をそのまま識別情報として使う
 * （tests/integration/request-end.test.ts, room-join.test.ts と同じ方針）。
 *
 * @see server/index.ts（join成功パスでのmarkRoomActive呼び出し）
 * @see server/room/roomManager.ts（reopenRoom）
 * @see server/db/supabaseAdmin.ts（markRoomActive）
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer } from "../../server/index";
import {
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";
import type { JoinMessage, ServerMessage } from "@shared/index";

describe("WS server - endedルームの再開（bd-gz1）", () => {
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

  let updateMock: jest.Mock;
  let eqMock: jest.Mock;
  let fromMock: jest.Mock;

  /**
   * finalizeRoomEnd（markRoomEnded）・再開時（markRoomActive）双方が呼ぶ
   * from("rooms").update().eq() をモックし、実Supabase接続を避ける。
   * 呼び出し引数をテストから検証できるよう、モック関数を describe スコープで保持する。
   */
  beforeEach(() => {
    eqMock = jest.fn().mockResolvedValue({ error: null });
    updateMock = jest.fn().mockReturnValue({ eq: eqMock });
    fromMock = jest.fn().mockReturnValue({ update: updateMock });
    setSupabaseAdminClient({ from: fromMock } as never);
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

  /** markRoomActive 呼び出しを待つ（fire-and-forgetのため、呼び出しまで短時間ポーリングする） */
  async function waitForMarkRoomActiveCall(timeoutMs = 500): Promise<void> {
    const start = Date.now();
    while (
      !fromMock.mock.calls.some((call) => call[0] === "rooms") ||
      !updateMock.mock.calls.some((call) => call[0]?.status === "active")
    ) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("markRoomActive was not called within timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    "オーナーがrequest_endで終了させた後、同じオーナーが再joinすると再開し、" +
      "joinedを受信して会話を再開できる",
    async () => {
      const port = getPort(wss);
      const roomId = `room-reopen-owner-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const ownerRoomEndedPromise = waitForMessage(owner);
      const ownerClosePromise = waitForClose(owner);
      owner.send(JSON.stringify({ type: "request_end" }));
      await ownerRoomEndedPromise;
      await ownerClosePromise;

      // オーナーが同一roomIdへ再joinすると再開し、joinedを受信する
      const ownerAgain = connect(port);
      await waitForOpen(ownerAgain);
      const rejoinedPromise = waitForMessage(ownerAgain);
      ownerAgain.send(JSON.stringify(makeJoin(roomId, "owner")));
      const rejoined = (await rejoinedPromise) as Extract<ServerMessage, { type: "joined" }>;

      expect(rejoined.type).toBe("joined");
      expect(rejoined.room).toEqual({ id: roomId, status: "active" });
      expect(ownerAgain.readyState).toBe(WebSocket.OPEN);

      // 会話再開の確認: 続けてゲストが同じルームへjoinでき、2人分の参加者が含まれる
      const guest = connect(port);
      await waitForOpen(guest);
      const guestJoinedPromise = waitForMessage(guest);
      guest.send(JSON.stringify(makeJoin(roomId, "guest")));
      const guestJoined = (await guestJoinedPromise) as Extract<ServerMessage, { type: "joined" }>;
      expect(guestJoined.participants).toHaveLength(2);
    },
  );

  it(
    "owner+guestが参加したルームをrequest_endで終了後、ownerが再joinして再開すると、" +
      "旧guestのエントリがクリアされ、別の新ゲストがmaxParticipants=2でも正常にjoinできる" +
      "（コードレビュー指摘should-fix1の実WS版回帰テスト）",
    async () => {
      const port = getPort(wss);
      const roomId = `room-reopen-clear-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const oldGuest = connect(port);
      await waitForOpen(oldGuest);
      const oldGuestJoinedPromise = waitForMessage(oldGuest);
      oldGuest.send(JSON.stringify(makeJoin(roomId, "guest")));
      await oldGuestJoinedPromise;

      // オーナーがrequest_endで終了させる（オーナー・旧ゲスト双方へroom_endedが配信されcloseされる）
      const ownerRoomEndedPromise = waitForMessage(owner);
      const oldGuestRoomEndedPromise = waitForMessage(oldGuest);
      const ownerClosePromise = waitForClose(owner);
      const oldGuestClosePromise = waitForClose(oldGuest);
      owner.send(JSON.stringify({ type: "request_end" }));
      await Promise.all([ownerRoomEndedPromise, oldGuestRoomEndedPromise]);
      await Promise.all([ownerClosePromise, oldGuestClosePromise]);

      // オーナーが同一roomIdへ再joinすると再開する（旧guestのエントリはクリアされる想定）
      const ownerAgain = connect(port);
      await waitForOpen(ownerAgain);
      const ownerRejoinedPromise = waitForMessage(ownerAgain);
      ownerAgain.send(JSON.stringify(makeJoin(roomId, "owner")));
      const ownerRejoined = (await ownerRejoinedPromise) as Extract<
        ServerMessage,
        { type: "joined" }
      >;
      expect(ownerRejoined.type).toBe("joined");
      expect(ownerRejoined.participants).toHaveLength(1);

      // 別の新ゲストがjoinできる（旧guestの席が残留していればroom is fullで拒否されるはず）
      const newGuest = connect(port);
      await waitForOpen(newGuest);
      const newGuestJoinedPromise = waitForMessage(newGuest);
      newGuest.send(JSON.stringify(makeJoin(roomId, "guest")));
      const newGuestJoined = (await newGuestJoinedPromise) as Extract<
        ServerMessage,
        { type: "joined" }
      >;

      expect(newGuestJoined.type).toBe("joined");
      expect(newGuestJoined.participants).toHaveLength(2);
      expect(newGuestJoined.room).toEqual({ id: roomId, status: "active" });
      expect(newGuest.readyState).toBe(WebSocket.OPEN);
    },
  );

  it("オーナーのjoin成功時、markRoomActiveに対応するDB更新（rooms.status:'active'）が呼ばれる", async () => {
    const port = getPort(wss);
    const roomId = `room-reopen-markactive-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = waitForMessage(owner);
    owner.send(JSON.stringify(makeJoin(roomId, "owner")));
    await ownerJoinedPromise;

    await waitForMarkRoomActiveCall();

    expect(fromMock).toHaveBeenCalledWith("rooms");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", ended_at: null }),
    );
    expect(eqMock).toHaveBeenCalledWith("id", roomId);
  });

  it("ゲストの再joinはendedルームでは拒否され、markRoomActiveは呼ばれない（権限確認）", async () => {
    const port = getPort(wss);
    const roomId = `room-reopen-guest-rejected-${Date.now()}`;

    const owner = connect(port);
    await waitForOpen(owner);
    const ownerJoinedPromise = waitForMessage(owner);
    owner.send(JSON.stringify(makeJoin(roomId, "owner")));
    await ownerJoinedPromise;

    const ownerRoomEndedPromise = waitForMessage(owner);
    owner.send(JSON.stringify({ type: "request_end" }));
    await ownerRoomEndedPromise;

    // これまでのmarkRoomActive呼び出し履歴をクリアする
    updateMock.mockClear();
    fromMock.mockClear();

    const guest = connect(port);
    await waitForOpen(guest);
    const guestRoomEndedPromise = waitForMessage(guest);
    const guestClosePromise = waitForClose(guest);
    guest.send(JSON.stringify(makeJoin(roomId, "guest")));
    const guestRoomEnded = (await guestRoomEndedPromise) as Extract<
      ServerMessage,
      { type: "room_ended" }
    >;

    expect(guestRoomEnded).toEqual({ type: "room_ended", reason: "owner_ended" });
    await guestClosePromise;
    expect(
      updateMock.mock.calls.some((call) => call[0]?.status === "active"),
    ).toBe(false);
  });
});
