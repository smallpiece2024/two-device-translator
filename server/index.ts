import { WebSocketServer, WebSocket, RawData } from "ws";
import { SHARED_PLACEHOLDER } from "@shared/index";

const WS_PORT = parseInt(process.env.WS_PORT ?? "3001", 10);
const WS_HOST = "127.0.0.1";

/**
 * WebSocketServer を起動して返す。
 * テスト容易性のため関数として切り出す（index.ts から export）。
 *
 * 雛形段階の最小実装: 接続受理と ping/pong のみ。
 * ルーム/セッション管理・zod によるメッセージ検証・GCP 連携等は後続タスクで実装する。
 */
export function startServer(
  port: number = WS_PORT,
  host: string = WS_HOST,
): WebSocketServer {
  const wss = new WebSocketServer({ port, host });

  wss.on("listening", () => {
    console.log(
      `[WS Server] Listening on ws://${host}:${port} (shared: ${SHARED_PLACEHOLDER})`,
    );
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[WS Server] Client connected");

    ws.on("message", (rawData: RawData) => {
      const text = Buffer.isBuffer(rawData)
        ? rawData.toString("utf8")
        : Buffer.concat(rawData as Buffer[]).toString("utf8");

      if (text === "ping") {
        ws.send("pong");
        return;
      }

      // 雛形段階では ping 以外のメッセージは無視する。
      console.log(`[WS Server] Received message: ${text}`);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[WS Server] Client disconnected (code=${code}, reason=${reason.toString()})`,
      );
    });

    ws.on("error", (err: Error) => {
      console.error("[WS Server] WebSocket error:", err.message);
    });
  });

  wss.on("error", (err: Error) => {
    console.error("[WS Server] Server error:", err.message);
  });

  return wss;
}

// このファイルが直接実行された場合のみサーバーを起動する（import 時は起動しない）
if (require.main === module) {
  startServer();
}
