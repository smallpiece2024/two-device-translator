/**
 * WS server の join 認証（verifyJoin, bd-0jy）の結合テスト。
 *
 * - 認証失敗経路: verifyJoin が null を返す → error(fatal:true) + 接続クローズ
 * - 幽霊参加者の回帰テスト: verifyJoin の解決待ち中にクライアントが切断した場合、
 *   ルームに参加者が残らないこと（server/index.ts の readyState チェックの検証）
 *
 * 実 Supabase / GCP への通信は行わない（options.verifyJoin にモックを注入する）。
 *
 * @see server/index.ts（joinInProgress ガード・readyState チェック）
 * @see server/auth/verifyParticipant.ts
 * @see tests/integration/room-join.test.ts（既存のRoomManager結合テスト）
 */
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer, type StartServerOptions } from "../../server/index";
import type { JoinMessage, ServerMessage } from "@shared/index";
import type { ParticipantIdentity } from "../../server/room/session";

describe("WS server - join 認証（verifyJoin結合テスト、bd-0jy）", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;
  let clients: WebSocket[] = [];

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

  /** マイクロタスク・直近のI/Oキューをすべて処理させるための明示的なティック。固定sleepではなくイベントループの1周を待つ。 */
  function flushAsync(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
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

  function startTestServer(options: StartServerOptions = {}): Promise<WebSocketServer> {
    wss = startServer(0, HOST, options);
    return new Promise((resolve) => wss.once("listening", () => resolve(wss)));
  }

  /**
   * サーバー側で受理された接続（ws インスタンス）を、受理順に記録する。
   * クライアント側の `close` イベントはサーバー側の close ハンドラ完了を
   * 保証しないため、幽霊参加者の再現には「サーバー側 close ハンドラが
   * 既に実行済み（session=null のまま素通り済み）」であることを直接
   * 観測する必要がある（server/index.ts の該当コメント参照）。
   */
  function trackServerConnections(server: WebSocketServer): WebSocket[] {
    const serverConnections: WebSocket[] = [];
    server.on("connection", (ws) => serverConnections.push(ws));
    return serverConnections;
  }

  function waitForServerSideClose(serverWs: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (serverWs.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      serverWs.once("close", () => resolve());
    });
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

  it("verifyJoinがnullを返す（認証失敗）とき、error(fatal:true)が返り接続がサーバー側からcloseされる", async () => {
    const verifyJoin = jest.fn().mockResolvedValue(null);
    const port = getPort(await startTestServer({ verifyJoin }));
    const roomId = `room-authfail-${Date.now()}`;

    const client = connect(port);
    await waitForOpen(client);

    const errorPromise = waitForMessage(client);
    const closePromise = waitForClose(client);
    client.send(JSON.stringify(makeJoin(roomId, "owner")));

    const error = (await errorPromise) as Extract<ServerMessage, { type: "error" }>;
    expect(error.type).toBe("error");
    expect(error.fatal).toBe(true);
    expect(error.message).toBe("Authentication failed");

    await closePromise;
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(verifyJoin).toHaveBeenCalledTimes(1);
  });

  it(
    "幽霊参加者の回帰テスト: verifyJoin解決待ち中にクライアントが切断しても、" +
      "ルームに参加者が残らない（maxParticipants=1で2人目が正常にjoinできることで確認）",
    async () => {
      let resolveFirstVerify!: (identity: ParticipantIdentity) => void;
      const firstVerifyPromise = new Promise<ParticipantIdentity>((resolve) => {
        resolveFirstVerify = resolve;
      });
      let callCount = 0;

      const verifyJoin = jest.fn(async (join: JoinMessage): Promise<ParticipantIdentity | null> => {
        callCount += 1;
        if (callCount === 1) {
          // 1人目(client1)の検証はテストが手動でresolveするまで待たせる
          return firstVerifyPromise;
        }
        // 2人目以降は即座に成功させる
        return {
          participantId: randomUUID(),
          role: join.role,
          displayName: join.displayName,
          language: join.language,
        };
      });

      const server = await startTestServer({ verifyJoin, maxParticipants: 1 });
      const port = getPort(server);
      const serverConnections = trackServerConnections(server);
      const roomId = `room-ghost-${Date.now()}`;

      // client1: join送信直後（verifyJoin解決前）に切断する
      const client1 = connect(port);
      await waitForOpen(client1);
      // サーバー側で受理された接続（client1に対応するもの）を捕捉する
      const serverWs1 = serverConnections[0];
      const close1Promise = waitForClose(client1);
      const serverClose1Promise = waitForServerSideClose(serverWs1);
      client1.send(JSON.stringify(makeJoin(roomId, "owner")));
      client1.close();
      await close1Promise;
      // 重要: クライアント側のcloseイベントは、サーバー側closeハンドラの
      // 完了を保証しない（別々のソケットイベント）。verifyJoin解決前に
      // サーバー側closeハンドラが「session=null のまま素通り」済みである
      // ことを直接待ってから検証を解決しないと、幽霊参加者バグの再現
      // 条件（読み取りガードが無ければ壊れる状況）を確実に作れない。
      await serverClose1Promise;

      // ここで初めてverifyJoinを解決する（client1のサーバー側closeは処理済み）
      resolveFirstVerify({
        participantId: randomUUID(),
        role: "owner",
        displayName: undefined,
        language: "ja-JP",
      });

      // サーバー側の非同期継続（readyStateチェック→早期return→finally）を
      // イベントループの次周まで進める（固定時間sleepではなくティック待ち）
      await flushAsync();
      await flushAsync();

      // client2: 同じルームへjoinを試みる。maxParticipants=1のため、
      // 幽霊参加者が残っていれば "room is full" 相当のerror(fatal:false)になる。
      // バグが修正されていれば、参加者0人分のルームへの1人目として正常にjoinできる。
      const client2 = connect(port);
      await waitForOpen(client2);
      const messagePromise = waitForMessage(client2);
      client2.send(JSON.stringify(makeJoin(roomId, "guest")));
      const message = await messagePromise;

      expect(message.type).toBe("joined");
      const joined = message as Extract<ServerMessage, { type: "joined" }>;
      expect(joined.participants).toHaveLength(1);
      expect(joined.participants[0]).toMatchObject({
        participantId: joined.participantId,
        role: "guest",
        present: true,
      });
    },
  );
});
