import { WebSocketServer, WebSocket, RawData } from "ws";
import {
  SHARED_PLACEHOLDER,
  clientMessageSchema,
  type ServerMessage,
} from "@shared/index";
import { RoomManager } from "./room/roomManager";
import type { Session } from "./room/session";
import { verifyJoin as defaultVerifyJoin, type VerifyJoinFn } from "./auth/verifyParticipant";

const WS_PORT = parseInt(process.env.WS_PORT ?? "3001", 10);
const WS_HOST = "127.0.0.1";

/** `startServer` の挙動を差し替えるためのオプション（テスト・Phase2差し替え用） */
export interface StartServerOptions {
  /** join 検証ロジック（既定は Phase1 ダミー実装。Phase2 で Supabase/ゲストJWT検証へ差し替え） */
  verifyJoin?: VerifyJoinFn;
  /** 1ルームあたりの最大参加者数（既定2） */
  maxParticipants?: number;
}

/**
 * WebSocketServer を起動して返す。
 * テスト容易性のため関数として切り出す（index.ts から export）。
 *
 * 接続受理 → join 待ち（join前の他メッセージは error(fatal:false)）→
 * join 受信で RoomManager に登録 → joined 応答、までを扱う。
 * `start`/`audio` 等の録音セッション処理・GCP連携は別タスクで拡張する
 * （docs/design/server-design.md「フェーズ対応」Phase1参照）。
 */
export function startServer(
  port: number = WS_PORT,
  host: string = WS_HOST,
  options: StartServerOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ port, host });
  const roomManager = new RoomManager({ maxParticipants: options.maxParticipants });
  const verifyJoin = options.verifyJoin ?? defaultVerifyJoin;

  wss.on("listening", () => {
    console.log(
      `[WS Server] Listening on ws://${host}:${port} (shared: ${SHARED_PLACEHOLDER})`,
    );
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[WS Server] Client connected");

    // join 完了後にのみ非 null になる（それまでは join 待ち状態）
    let session: Session | null = null;
    let roomId: string | null = null;

    const sendMessage = (message: ServerMessage): void => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      ws.send(JSON.stringify(message));
    };

    const sendError = (message: string, fatal: boolean): void => {
      sendMessage({ type: "error", message, fatal });
      if (fatal) {
        ws.close();
      }
    };

    ws.on("message", (rawData: RawData) => {
      const text = Buffer.isBuffer(rawData)
        ? rawData.toString("utf8")
        : Buffer.concat(rawData as Buffer[]).toString("utf8");

      // 雛形段階からの疎通確認用（プロトコル外）。既存の ping/pong 動作を維持する。
      if (text === "ping") {
        ws.send("pong");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendError("Invalid message: not a valid JSON text", false);
        return;
      }

      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError("Invalid message: schema validation failed", false);
        return;
      }

      const message = result.data;

      if (!session) {
        // join 待ち状態: join 以外のメッセージは拒否する
        if (message.type !== "join") {
          sendError("join message is required before any other message", false);
          return;
        }

        const identity = verifyJoin(message);
        if (!identity) {
          sendError("Authentication failed", true);
          return;
        }

        const joinResult = roomManager.join(message.roomId, identity, ws);
        if (!joinResult.ok) {
          sendError(joinResult.reason, false);
          return;
        }

        session = joinResult.session;
        roomId = message.roomId;

        sendMessage({
          type: "joined",
          participantId: joinResult.session.participantId,
          room: { id: joinResult.room.roomId, status: joinResult.room.status },
          participants: Array.from(joinResult.room.participants.values()).map(
            (s) => s.toSummary(),
          ),
          recentMessages: [],
        });
        return;
      }

      // join 済み: start/audio/commit/stop 等の処理は本タスクの範囲外
      // （RoomManager/セッション管理のみを扱う。別タスクで拡張する）。
      console.log(
        `[WS Server] Received message (not handled in this phase): ${message.type}`,
      );
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[WS Server] Client disconnected (code=${code}, reason=${reason.toString()})`,
      );
      if (session && roomId) {
        roomManager.leave(roomId, session.participantId);
      }
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
