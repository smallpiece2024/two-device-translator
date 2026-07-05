/**
 * 再接続復帰（bd-e3p）の結合テスト。
 *
 * 実際の WebSocketServer を起動し、`options.verifyJoin` を注入して
 * 同一 identity（role固定）に対して常に同じ `participantId` を返すことで、
 * 「同一 participantId での再接続」を安定的に再現する
 * （実 Supabase / ゲストJWT を経由しないため注入で代替する）。
 *
 * @see server/index.ts（joinResult.reconnected分岐、isCurrentSocketガード）
 * @see server/room/roomManager.ts（join の再接続復帰・refreshAutoEndTimer）
 * @see server/room/session.ts（attachSocket・isCurrentSocket）
 * @see docs/design/server-design.md 「再接続・不在・終了判定」
 */
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer } from "../../server/index";
import {
  setSupabaseAdminClient,
  resetSupabaseAdminClient,
} from "../../server/db/supabaseAdmin";
import type { JoinMessage, ServerMessage } from "@shared/index";
import type { ParticipantIdentity } from "../../server/room/session";

describe("WS server - 再接続復帰（bd-e3p）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];

  /**
   * request_end（ended済みルームへの再joinテスト）が finalizeRoomEnd →
   * markRoomEnded を経由するため、実Supabase接続を避けるモックを注入する。
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

  function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      ws.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
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

  /**
   * role に応じて安定した participantId を返す verifyJoin モック
   * （同一role・同一ルームでの複数回joinを「同一participantIdでの再接続」として扱わせる）。
   */
  function stableVerifyJoin(ids: { owner: string; guest: string }) {
    return jest.fn(async (join: JoinMessage): Promise<ParticipantIdentity> => {
      return {
        participantId: join.role === "owner" ? ids.owner : ids.guest,
        role: join.role,
        displayName: join.displayName,
        language: join.language,
      };
    });
  }

  async function startTestServer(
    verifyJoin: ReturnType<typeof stableVerifyJoin>,
  ): Promise<WebSocketServer> {
    wss = startServer(0, HOST, { verifyJoin });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return wss;
  }

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
    "不在復帰: 切断後、同一participantIdで再joinするとjoined応答で自身がpresent:trueになり、" +
      "他参加者へparticipant_joinedが再配信される",
    async () => {
      const verifyJoin = stableVerifyJoin({ owner: "owner-1", guest: "guest-1" });
      const server = await startTestServer(verifyJoin);
      const port = getPort(server);
      const roomId = `reconnect-restore-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const guest1 = connect(port);
      await waitForOpen(guest1);
      const guestJoined1Promise = waitForMessage(guest1);
      // 1人目のjoinで owner が受け取る participant_joined は本テストの検証対象外のため
      // 明示的に読み捨てる（後続の waitForMessage(owner) が正しいイベントを拾うため）。
      const ownerParticipantJoined1Promise = waitForMessage(owner);
      guest1.send(JSON.stringify(makeJoin(roomId, "guest")));
      await guestJoined1Promise;
      await ownerParticipantJoined1Promise;

      // guest切断 → owner に participant_left が届く
      const ownerLeftPromise = waitForMessage(owner);
      const guestClose = waitForClose(guest1);
      guest1.close();
      await guestClose;
      const leftEvent = (await ownerLeftPromise) as Extract<
        ServerMessage,
        { type: "participant_left" }
      >;
      expect(leftEvent.type).toBe("participant_left");
      expect(leftEvent.participantId).toBe("guest-1");

      // 同一participantId(guest-1)で再接続
      const ownerParticipantJoinedPromise = waitForMessage(owner);
      const guest2 = connect(port);
      await waitForOpen(guest2);
      const guestJoined2Promise = waitForMessage(guest2);
      guest2.send(JSON.stringify(makeJoin(roomId, "guest", { displayName: "Bob復帰" })));
      const joined2 = (await guestJoined2Promise) as Extract<ServerMessage, { type: "joined" }>;

      // (a) joined応答で自身が復帰状態（present:true）
      expect(joined2.participantId).toBe("guest-1");
      const selfSummary = joined2.participants.find((p) => p.participantId === "guest-1");
      expect(selfSummary).toMatchObject({ participantId: "guest-1", present: true });

      // (b) 他参加者（owner）へ participant_joined が再配信される
      const rejoinedEvent = (await ownerParticipantJoinedPromise) as Extract<
        ServerMessage,
        { type: "participant_joined" }
      >;
      expect(rejoinedEvent.type).toBe("participant_joined");
      expect(rejoinedEvent.participant).toMatchObject({
        participantId: "guest-1",
        present: true,
        displayName: "Bob復帰",
      });
    },
  );

  it(
    "二重接続: 旧ソケットが開いたまま同一participantIdで新規接続すると、" +
      "旧ソケットはcode 4000でサーバーからcloseされ、新しい接続が正になる",
    async () => {
      const verifyJoin = stableVerifyJoin({ owner: "owner-1", guest: "guest-1" });
      const server = await startTestServer(verifyJoin);
      const port = getPort(server);
      const roomId = `reconnect-double-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      const guestOld = connect(port);
      await waitForOpen(guestOld);
      const guestOldJoinedPromise = waitForMessage(guestOld);
      guestOld.send(JSON.stringify(makeJoin(roomId, "guest")));
      await guestOldJoinedPromise;

      // 旧ソケットをcloseせずに同一participantIdで新規接続する（二重接続）
      const oldClosePromise = waitForClose(guestOld);
      const guestNew = connect(port);
      await waitForOpen(guestNew);
      const guestNewJoinedPromise = waitForMessage(guestNew);
      guestNew.send(JSON.stringify(makeJoin(roomId, "guest")));
      const joinedNew = (await guestNewJoinedPromise) as Extract<ServerMessage, { type: "joined" }>;
      expect(joinedNew.participantId).toBe("guest-1");

      // 旧ソケットはサーバーからcode 4000でcloseされる
      const { code } = await oldClosePromise;
      expect(code).toBe(4000);

      // (d) 旧ソケットのcloseハンドラが新セッションのpresentを壊さないこと
      //     （isCurrentSocketガード）を、旧ソケットclose処理が完了した後で
      //     ownerへparticipant_leftが送られていないことで確認する
      //     （送られていれば新セッションの状態が誤って崩されたことになる）
      const ownerMessagesAfterOldClose = await collectMessagesForGracePeriod(owner, 300);
      expect(ownerMessagesAfterOldClose).not.toContainEqual(
        expect.objectContaining({ type: "participant_left", participantId: "guest-1" }),
      );
    },
  );

  it(
    "ended済みルームへの再joinはerrorではなくroom_ended(reason:owner_ended)を受信し、" +
      "その後サーバー側から接続がcloseされる（must-fix1、コードレビュー指摘対応）",
    async () => {
      const verifyJoin = stableVerifyJoin({ owner: "owner-1", guest: "guest-1" });
      const server = await startTestServer(verifyJoin);
      const port = getPort(server);
      const roomId = `reconnect-ended-${Date.now()}`;

      const owner = connect(port);
      await waitForOpen(owner);
      const ownerJoinedPromise = waitForMessage(owner);
      owner.send(JSON.stringify(makeJoin(roomId, "owner")));
      await ownerJoinedPromise;

      // オーナーがルームを終了する
      const ownerRoomEndedPromise = waitForMessage(owner);
      owner.send(JSON.stringify({ type: "request_end" }));
      const roomEnded = (await ownerRoomEndedPromise) as Extract<
        ServerMessage,
        { type: "room_ended" }
      >;
      expect(roomEnded.type).toBe("room_ended");

      // 終了済みルームへ別参加者が再joinを試みる
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

      const { code } = await guestClosePromise;
      expect(code).toBe(1000);
    },
  );
});
