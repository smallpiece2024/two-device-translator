import { WebSocketServer, WebSocket, RawData } from "ws";
import {
  SHARED_PLACEHOLDER,
  clientMessageSchema,
  type ServerMessage,
} from "@shared/index";
import { RoomManager, type Room } from "./room/roomManager";
import type { Session, CreateSpeechStreamFn } from "./room/session";
import { verifyJoin as defaultVerifyJoin, type VerifyJoinFn } from "./auth/verifyParticipant";
import { translateText } from "./gcp/translate";
import { synthesizeSpeechToBase64 } from "./gcp/textToSpeech";
import {
  createMockSpeechStream,
  mockTranslateText,
  mockSynthesizeSpeechToBase64,
} from "./gcp/mockGcp";
import { routeUtterance, type RoutingParticipant, type MessageRouterDeps } from "./routing/messageRouter";

const WS_PORT = parseInt(process.env.WS_PORT ?? "3001", 10);
const WS_HOST = "127.0.0.1";

/** `startServer` の挙動を差し替えるためのオプション（テスト・Phase2差し替え用） */
export interface StartServerOptions {
  /** join 検証ロジック（既定は Phase1 ダミー実装。Phase2 で Supabase/ゲストJWT検証へ差し替え） */
  verifyJoin?: VerifyJoinFn;
  /** 1ルームあたりの最大参加者数（既定2） */
  maxParticipants?: number;
  /**
   * STT ストリーム生成関数（省略時は `GCP_MODE` 環境変数で解決。
   * `GCP_MODE=mock` のときは E2E 用モック、それ以外は実 GCP 実装）。
   */
  createSpeechStream?: CreateSpeechStreamFn;
  /**
   * 翻訳関数（省略時は `GCP_MODE` 環境変数で解決。
   * `GCP_MODE=mock` のときは E2E 用モック、それ以外は実 GCP 実装）。
   */
  translate?: MessageRouterDeps["translate"];
  /**
   * 音声合成関数（省略時は `GCP_MODE` 環境変数で解決。
   * `GCP_MODE=mock` のときは E2E 用モック、それ以外は実 GCP 実装）。
   */
  synthesize?: MessageRouterDeps["synthesize"];
}

/** `GCP_MODE=mock` のとき true（E2E テスト用の決定的モックで動作させる）。 */
function isMockGcpMode(): boolean {
  return process.env.GCP_MODE === "mock";
}

/** `Session` から `messageRouter.ts` の `RoutingParticipant` へ変換する */
function toRoutingParticipant(session: Session): RoutingParticipant {
  return {
    participantId: session.participantId,
    displayName: session.displayName,
    language: session.language,
    enableTts: session.enableTts,
    send: (message: ServerMessage) => session.send(message),
  };
}

/**
 * 発話区切り確定時の翻訳・配信ルーティングを実行する。
 * ルームが既に存在しない（例: 話者以外全員退室済み）場合は何もしない。
 */
function routeCommittedUtterance(
  room: Room,
  speakerSession: Session,
  text: string,
  deps: MessageRouterDeps,
): void {
  const listeners = Array.from(room.participants.values())
    .filter((s) => s.participantId !== speakerSession.participantId)
    .map(toRoutingParticipant);

  // 配信を待たせない（会話テンポ優先、NFR-2.2）。エラーは routeUtterance 内部で
  // 話者への error 送信として処理されるため、ここでは失敗をログ出力するのみ。
  void routeUtterance(
    {
      roomId: room.roomId,
      speaker: toRoutingParticipant(speakerSession),
      listeners,
      sourceLanguage: speakerSession.language,
      text,
    },
    deps,
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[WS Server] routeUtterance failed unexpectedly:", message);
  });
}

/**
 * WebSocketServer を起動して返す。
 * テスト容易性のため関数として切り出す（index.ts から export）。
 *
 * 接続受理 → join 待ち（join前の他メッセージは error(fatal:false)）→
 * join 受信で RoomManager に登録 → joined 応答 →
 * start（STTストリーム開始・発話バッファ初期化）→ audio（STT書き込み）→
 * 発話区切り確定（翻訳・配信ルーティング）→ commit/stop、までを扱う
 * （docs/design/server-design.md「セッションライフサイクル」参照）。
 *
 * GCP 呼び出し（STT/翻訳/TTS）は `options` で明示指定しない限り、
 * 環境変数 `GCP_MODE=mock` のときは E2E テスト用の決定的モック
 * （`server/gcp/mockGcp.ts`）に切り替わる。**本番では `GCP_MODE` を
 * 設定しない（未設定時は実 GCP 実装を使用する）。**
 */
export function startServer(
  port: number = WS_PORT,
  host: string = WS_HOST,
  options: StartServerOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ port, host });
  const roomManager = new RoomManager({ maxParticipants: options.maxParticipants });
  const verifyJoin = options.verifyJoin ?? defaultVerifyJoin;
  const mockMode = isMockGcpMode();

  // 非モック時かつ未指定の場合は undefined のまま渡す
  // （Session 側の既定である実 GCP 実装 `createSpeechStream` に委ねる）
  const createStream: CreateSpeechStreamFn | undefined =
    options.createSpeechStream ?? (mockMode ? createMockSpeechStream : undefined);
  const translate: MessageRouterDeps["translate"] =
    options.translate ?? (mockMode ? mockTranslateText : translateText);
  const synthesize: MessageRouterDeps["synthesize"] =
    options.synthesize ?? (mockMode ? mockSynthesizeSpeechToBase64 : synthesizeSpeechToBase64);
  const routerDeps: MessageRouterDeps = { translate, synthesize };

  wss.on("listening", () => {
    console.log(
      `[WS Server] Listening on ws://${host}:${port} (shared: ${SHARED_PLACEHOLDER})`,
    );
    if (mockMode) {
      console.log(
        "[WS Server] GCP_MODE=mock: using deterministic mock STT/Translation/TTS " +
          "(server/gcp/mockGcp.ts). Do NOT use this in production.",
      );
    }
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

        const joinResult = roomManager.join(message.roomId, identity, ws, {
          enableTts: message.enableTts,
        });
        if (!joinResult.ok) {
          sendError(joinResult.reason, false);
          return;
        }

        session = joinResult.session;
        roomId = message.roomId;

        // 既に在室している他参加者へ、新規参加を通知する
        // （新規参加者自身への joined 応答より先に送ることで、他参加者側での
        // 受信順序に関するテスト時のレース（同時刻に別ソケットへ送信した際の
        // 到達順不定）の影響を抑える）
        for (const other of joinResult.room.participants.values()) {
          if (other.participantId === session.participantId) {
            continue;
          }
          other.send({ type: "participant_joined", participant: session.toSummary() });
        }

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

      // join 済み: 録音セッション（start/audio/commit/stop）・設定更新を扱う
      switch (message.type) {
        case "update_settings": {
          session.enableTts = message.enableTts;
          return;
        }

        case "start": {
          session.startRecording(message, {
            createSpeechStream: createStream,
            onUtteranceCommitted: (utteranceText) => {
              if (!roomId || !session) {
                return;
              }
              const room = roomManager.getRoom(roomId);
              if (!room) {
                return;
              }
              routeCommittedUtterance(room, session, utteranceText, routerDeps);
            },
          });
          return;
        }

        case "audio": {
          if (!session.isRecording) {
            sendError("start message is required before audio", false);
            return;
          }
          session.writeAudioChunk(message.data);
          return;
        }

        case "commit": {
          if (!session.isRecording) {
            sendError("start message is required before commit", false);
            return;
          }
          session.commitUtterance();
          return;
        }

        case "stop": {
          if (!session.isRecording) {
            sendError("start message is required before stop", false);
            return;
          }
          session.stopRecording();
          return;
        }

        default:
          // update_settings / request_end 等の Phase2/3 メッセージは別タスクで扱う
          console.log(
            `[WS Server] Received message (not handled in this phase): ${message.type}`,
          );
          return;
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[WS Server] Client disconnected (code=${code}, reason=${reason.toString()})`,
      );
      if (session) {
        session.destroyRecording();
      }
      if (session && roomId) {
        const room = roomManager.getRoom(roomId);
        const leftParticipantId = session.participantId;
        roomManager.leave(roomId, leftParticipantId);
        if (room) {
          for (const other of room.participants.values()) {
            other.send({ type: "participant_left", participantId: leftParticipantId });
          }
        }
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
