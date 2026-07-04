import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { startServer } from "../../server/index";

describe("WS server (integration smoke test)", () => {
  const HOST = "127.0.0.1";
  let wss: WebSocketServer;

  afterEach((done) => {
    if (!wss) {
      done();
      return;
    }
    // 全クライアントを終了させたうえでサーバーをcloseし、
    // ハンドルリークによるjestのハングを防ぐ。
    // クライアント側close後、サーバー側のsocket close処理（ログ出力含む）が
    // 非同期に発火することがあるため、少し待ってからdoneする。
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => setTimeout(done, 50));
  });

  it("起動でき、listeningイベント発火時にaddressから実際のポートが取得できる", (done) => {
    // port: 0 を指定してOSに空きポートを割り当てさせる（テスト間のポート衝突回避）
    wss = startServer(0, HOST);

    wss.once("listening", () => {
      const address = wss.address();
      expect(address).not.toBeNull();
      if (address && typeof address !== "string") {
        expect(address.port).toBeGreaterThan(0);
      }
      done();
    });
  });

  it("クライアントから接続でき、pingを送るとpongが返る", (done) => {
    wss = startServer(0, HOST);

    wss.once("listening", () => {
      const address = wss.address();
      if (!address || typeof address === "string") {
        done(new Error("failed to obtain server address"));
        return;
      }
      const port = address.port;

      const client = new WebSocket(`ws://${HOST}:${port}`);

      client.on("open", () => {
        client.send("ping");
      });

      client.on("message", (data) => {
        expect(data.toString("utf8")).toBe("pong");
        client.close();
      });

      client.on("close", () => {
        done();
      });

      client.on("error", (err) => {
        done(err);
      });
    });
  });

  it("ping以外の不正なメッセージを送るとerror(fatal:false)が返り、接続は維持される", (done) => {
    wss = startServer(0, HOST);

    wss.once("listening", () => {
      const address = wss.address();
      if (!address || typeof address === "string") {
        done(new Error("failed to obtain server address"));
        return;
      }
      const port = address.port;

      const client = new WebSocket(`ws://${HOST}:${port}`);

      client.on("open", () => {
        // "hello" はJSONとしてparseできない → error(fatal:false)が返り、接続は維持される仕様
        // （websocket-protocol.md参照。join前の他メッセージ/parse失敗はfatal:falseで通知）
        client.send("hello");
      });

      client.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString("utf8"));
          expect(message).toEqual({
            type: "error",
            message: "Invalid message: not a valid JSON text",
            fatal: false,
          });
          // fatal:false のため接続は維持されているはず
          expect(client.readyState).toBe(WebSocket.OPEN);
          client.close();
        } catch (err) {
          done(err as Error);
        }
      });

      client.on("close", () => {
        done();
      });

      client.on("error", (err) => {
        done(err);
      });
    });
  });
});
