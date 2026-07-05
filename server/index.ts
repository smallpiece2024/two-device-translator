import { WebSocketServer, WebSocket, RawData } from "ws";
import {
  SHARED_PLACEHOLDER,
  clientMessageSchema,
  type ServerMessage,
  type RoomEndedReason,
} from "@shared/index";
import { RoomManager, type Room, DEFAULT_AUTO_END_THRESHOLD_MS } from "./room/roomManager";
import type { Session, CreateSpeechStreamFn } from "./room/session";
import {
  verifyJoin as defaultVerifyJoin,
  isInsecureAuthMode,
  type VerifyJoinFn,
} from "./auth/verifyParticipant";
import { translateText } from "./gcp/translate";
import { synthesizeSpeechToBase64 } from "./gcp/textToSpeech";
import {
  createMockSpeechStream,
  mockTranslateText,
  mockSynthesizeSpeechToBase64,
} from "./gcp/mockGcp";
import { routeUtterance, type RoutingParticipant, type MessageRouterDeps } from "./routing/messageRouter";
import { markRoomEnded } from "./db/supabaseAdmin";

const WS_PORT = parseInt(process.env.WS_PORT ?? "3001", 10);
const WS_HOST = "127.0.0.1";

/** `startServer` の挙動を差し替えるためのオプション（テスト・Phase2差し替え用） */
export interface StartServerOptions {
  /**
   * join 検証ロジック（既定は `server/auth/verifyParticipant.ts` の本実装。
   * Supabase アクセストークン(owner)/ゲストJWT(guest)を検証する非同期関数。
   * テスト・`AUTH_MODE=insecure` 相当の差し替えに使う）。
   */
  verifyJoin?: VerifyJoinFn;
  /** 1ルームあたりの最大参加者数（既定2） */
  maxParticipants?: number;
  /**
   * 不在自動終了のしきい値（ms）。省略時は環境変数 `AUTO_END_THRESHOLD_MS`
   * → 既定値（`RoomManager.DEFAULT_AUTO_END_THRESHOLD_MS`、10分）の順で解決する
   * （bd-e3p、docs/design/server-design.md「再接続・不在・終了判定」参照）。
   * テスト用に短い値へ差し替え可能。
   */
  autoEndThresholdMs?: number;
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

/**
 * 不在自動終了のしきい値（ms）を解決する。
 * 優先順位: `options.autoEndThresholdMs` 明示指定 > 環境変数
 * `AUTO_END_THRESHOLD_MS`（正の整数のみ有効） > 既定値（10分）。
 */
function resolveAutoEndThresholdMs(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const envValue = process.env.AUTO_END_THRESHOLD_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_AUTO_END_THRESHOLD_MS;
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
 * ルーム終了（オーナーの `request_end` / 不在自動終了の両方）の共通処理。
 * `roomManager.endRoom()` 実行後に呼ぶこと（この関数自身は状態遷移を行わない）。
 *
 * - 全参加者へ `room_ended` を配信する
 * - 各参加者の録音セッション（STTストリーム等）を破棄する
 * - 各参加者のソケットを閉じる（`room_ended` 送信後、確実に届くよう非同期を待たない）
 * - DB `rooms.status`/`ended_at` を更新する（service_role、fire-and-forget。
 *   失敗しても接続終了処理は止めない、docs/design/server-design.md
 *   「ルーム終了シーケンス」参照）
 */
function finalizeRoomEnd(room: Room, reason: RoomEndedReason): void {
  for (const participant of room.participants.values()) {
    participant.send({ type: "room_ended", reason });
    participant.destroyRecording();
    participant.closeSocket(1000, `room ${reason}`);
  }
  void markRoomEnded(room.roomId);
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
  const roomManager = new RoomManager({
    maxParticipants: options.maxParticipants,
    autoEndThresholdMs: resolveAutoEndThresholdMs(options.autoEndThresholdMs),
    onAutoEnd: (room) => finalizeRoomEnd(room, "auto_timeout"),
  });
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
    if (isInsecureAuthMode()) {
      console.warn(
        "[WS Server] AUTH_MODE=insecure: join token verification is DISABLED " +
          "(server/auth/verifyParticipant.ts). 本番使用禁止 (do NOT use this in production).",
      );
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("[WS Server] Client connected");

    // join 完了後にのみ非 null になる（それまでは join 待ち状態）
    let session: Session | null = null;
    let roomId: string | null = null;
    // join 検証（Supabase/ゲストJWT検証は非同期）が完了するまでの間、
    // 後続の join メッセージの多重処理を防ぐガード
    // （検証中に他メッセージが届いた場合は session が null のままのため、
    // 既存の「join required」エラー経路に自然に落ちる）。
    let joinInProgress = false;

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

        // 検証中（非同期）に届いた追加の join は多重処理せず拒否する
        // （fatal:false。最初の join の検証結果を待たせる）
        if (joinInProgress) {
          sendError("join is already being verified", false);
          return;
        }
        joinInProgress = true;

        void (async () => {
          try {
            const identity = await verifyJoin(message);
            if (!identity) {
              sendError("Authentication failed", true);
              return;
            }

            // 検証待ち中の切断との競合対策: verifyJoin の await 中にクライアントが
            // 切断すると、close イベントは session=null のためクリーンアップ処理を
            // 素通りして先に発火してしまう（除去経路がない = close は再発火しない）。
            // ここでチェックせずに roomManager.join を呼ぶと、切断済みソケットの
            // セッションがルームに残り続け、maxParticipants の枠を永久に占有する
            // 「幽霊参加者」バグになる。以降は同期処理のみのため、この1箇所の
            // readyState チェックで十分。
            if (ws.readyState !== ws.OPEN) {
              return;
            }

            const joinResult = roomManager.join(message.roomId, identity, ws, {
              enableTts: message.enableTts,
            });
            if (!joinResult.ok) {
              // ルームが既に終了済みの場合は error ではなく room_ended を
              // 返してから接続を閉じる（must-fix1、コードレビュー指摘対応。
              // docs/design/server-design.md「再接続復帰」参照）。
              if (joinResult.endedReason) {
                sendMessage({ type: "room_ended", reason: joinResult.endedReason });
                ws.close(1000, "room already ended");
                return;
              }
              sendError(joinResult.reason, false);
              return;
            }

            session = joinResult.session;
            roomId = message.roomId;

            // 再接続復帰: 同一 participantId の古い接続がまだ開いていた場合、
            // 新しい接続を正としてそちらを閉じる（二重接続の設計判断、
            // docs/design/server-design.md「再接続・不在・終了判定」参照）。
            // 古い接続の close ハンドラは isCurrentSocket() ガードにより、
            // 既に差し替え済みの session の present/録音状態を壊さない。
            if (
              joinResult.reconnected &&
              joinResult.previousSocket &&
              joinResult.previousSocket !== ws &&
              joinResult.previousSocket.readyState === joinResult.previousSocket.OPEN
            ) {
              joinResult.previousSocket.close(4000, "reconnected from a new connection");
            }

            // 既に在室している他参加者へ、新規参加/再接続を通知する
            // （新規参加者自身への joined 応答より先に送ることで、他参加者側での
            // 受信順序に関するテスト時のレース（同時刻に別ソケットへ送信した際の
            // 到達順不定）の影響を抑える）。再接続時も participant_joined を
            // 再送する（server-design.md「再接続復帰」参照）。
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
          } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            console.error("[WS Server] join verification failed unexpectedly:", errMessage);
            sendError("Authentication failed", true);
          } finally {
            joinInProgress = false;
          }
        })();
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

        case "request_end": {
          // オーナーのみ有効（websocket-protocol.md「request_end（ルーム終了）」参照）。
          if (session.role !== "owner") {
            sendError("only the room owner can end the room", false);
            return;
          }
          if (!roomId) {
            return;
          }
          const ended = roomManager.endRoom(roomId, "owner_ended");
          if (ended) {
            finalizeRoomEnd(ended, "owner_ended");
          }
          return;
        }

        default:
          // idle_hint 等の Phase3 メッセージは別タスクで扱う
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

      if (!session) {
        return;
      }

      // 再接続により差し替え済みの「古い」物理接続の close イベント。
      // 新しい接続が正であり、こちらの close で present/録音状態を
      // 上書きしてはならない（server/room/session.ts の isCurrentSocket 参照）。
      if (!session.isCurrentSocket(ws)) {
        return;
      }

      session.destroyRecording();

      if (roomId) {
        const room = roomManager.getRoom(roomId);
        const leftParticipantId = session.participantId;
        // ルームが既に終了済み（request_end/自動終了で room_ended 配信済み）の
        // 場合は、finalizeRoomEnd 側で全参加者へ通知済みのため participant_left
        // を重ねて送らない（wasEnded は leave() 呼び出し前の状態で判定する。
        // leave() 自体は status を変更しないため前後どちらで見ても同じだが、
        // 意図を明確にするため呼び出し前の状態を見る）。
        const wasEnded = room?.status === "ended";
        roomManager.leave(roomId, leftParticipantId);
        if (room && !wasEnded) {
          for (const other of room.participants.values()) {
            if (other.participantId === leftParticipantId) {
              continue;
            }
            other.send({
              type: "participant_left",
              participantId: leftParticipantId,
              reason: "disconnected",
            });
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
