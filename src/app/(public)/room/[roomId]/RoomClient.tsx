"use client";

/**
 * トークルーム画面の最上位 Client Component（骨格）。
 *
 * Phase1 スコープ: WS 接続確立 → `join` 送信 → `joined` 受信で状態初期化、
 * および reducer による状態管理のみを担う。マイク入力・チャット表示UI・
 * 音声再生は後続タスクで拡張する（`docs/design/frontend-design.md` 参照）。
 *
 * 認可チェックは Phase2 の範囲（`docs/design/security-design.md` Phase1行）
 * のため、このタスクでは token を仮発行して誰でも入室できる簡易動作とする。
 */
import { useEffect, useReducer, useRef } from "react";
import { serverMessageSchema, type ClientMessage, type SupportedLanguage } from "@shared/index";
import { initialRoomState, roomReducer, toMessageView, type AppStatus } from "./reducer";
import styles from "./RoomClient.module.css";

export interface RoomClientProps {
  roomId: string;
  wsUrl: string;
  role?: "owner" | "guest";
  displayName?: string;
  language?: SupportedLanguage;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 8000;

/** Phase1 の仮トークン発行（Phase2 で正式な認証トークンに置き換える） */
function createTemporaryToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function RoomClient({
  roomId,
  wsUrl,
  role = "guest",
  displayName,
  language = "ja-JP",
}: RoomClientProps) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  if (tokenRef.current === undefined) {
    tokenRef.current = createTemporaryToken();
  }

  useEffect(() => {
    // StrictMode の mount→cleanup→mount 二重実行に対応するため、
    // 「このeffect実行が有効かどうか」は共有refではなくクロージャローカルの
    // 変数で判定する（前回実行のソケットが後から今回のソケットを差し替える
    // ことを防ぐ）。
    let cancelled = false;
    // fatal エラー確定後は再接続もエラー文言の上書きも行わないためのフラグ。
    // effect実行（＝マウント〜アンマウント）ごとにリセットされる。
    let fatal = false;

    function connect() {
      if (cancelled) return;

      dispatch({ type: "STATUS_CHANGED", status: "connecting" });

      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      /** このイベントが現在有効なソケット（＝有効なeffect実行）のものかを判定する */
      function isCurrent(): boolean {
        return !cancelled && socketRef.current === socket;
      }

      socket.addEventListener("open", () => {
        if (!isCurrent()) return;
        reconnectAttemptsRef.current = 0;
        const joinMessage: ClientMessage = {
          type: "join",
          roomId,
          role,
          token: tokenRef.current as string,
          displayName,
          language,
        };
        socket.send(JSON.stringify(joinMessage));
      });

      socket.addEventListener("message", (event) => {
        if (!isCurrent()) return;

        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          console.error("[RoomClient] 受信メッセージのJSONパースに失敗しました", event.data);
          return;
        }

        const result = serverMessageSchema.safeParse(raw);
        if (!result.success) {
          console.error("[RoomClient] 受信メッセージのスキーマ検証に失敗しました", result.error);
          return;
        }

        const message = result.data;
        switch (message.type) {
          case "joined":
            dispatch({
              type: "JOINED",
              participantId: message.participantId,
              room: message.room,
              participants: message.participants,
              recentMessages: message.recentMessages,
            });
            break;
          case "transcript_interim":
            dispatch({ type: "INTERIM", text: message.text });
            break;
          case "transcript_final":
            dispatch({ type: "INTERIM", text: message.text });
            break;
          case "utterance_committed":
            // 確定発話は後続の `message` でバブル化されるため、ここでは何もしない
            // （docs/design/frontend-design.md 状態管理(reducer)節）。
            break;
          case "message":
            dispatch({ type: "MESSAGE", message: toMessageView(message) });
            break;
          case "audio":
            // 音声再生は後続タスク（useAudioQueue）で扱う。
            break;
          case "error":
            dispatch({ type: "ERROR", message: message.message, fatal: message.fatal });
            if (message.fatal) {
              fatal = true;
              socket.close();
            }
            break;
        }
      });

      socket.addEventListener("close", () => {
        if (!isCurrent()) return;

        if (fatal) {
          // fatal エラーは message ハンドラで既にサーバー由来の文言を dispatch 済み。
          // ここで汎用文言を重ねて上書きしない。
          return;
        }

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const attempt = reconnectAttemptsRef.current;
          const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** attempt,
            MAX_RECONNECT_DELAY_MS,
          );
          reconnectAttemptsRef.current += 1;
          dispatch({ type: "RESET" });
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          dispatch({
            type: "ERROR",
            message: "サーバーとの接続を確立できませんでした。",
            fatal: true,
          });
        }
      });

      socket.addEventListener("error", () => {
        // close イベントが後続して発火するため、ここでは特別な処理は行わない。
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [roomId, wsUrl, role, displayName, language]);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>ルーム: {roomId}</h1>
        <p className={styles.status} data-status={state.status}>
          状態: {statusLabel(state.status)}
        </p>
      </header>

      {state.error && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <section className={styles.participants} aria-label="参加者一覧">
        <p>参加者: {state.participants.length}人</p>
      </section>

      <section className={styles.messages} aria-label="メッセージ一覧">
        <ul className={styles.messageList}>
          {state.messages.map((message) => (
            <li key={message.messageId} className={styles.messageItem}>
              <span className={styles.speaker}>{message.speakerName}</span>
              <span>{message.displayText}</span>
            </li>
          ))}
        </ul>
        {state.interim && <p className={styles.interim}>{state.interim}</p>}
      </section>
    </div>
  );
}

function statusLabel(status: AppStatus): string {
  switch (status) {
    case "idle":
      return "未接続";
    case "connecting":
      return "接続中...";
    case "joined":
      return "接続済み";
    case "recording":
      return "録音中";
    case "error":
      return "エラー";
    default:
      return status;
  }
}
