"use client";

/**
 * トークルーム画面の最上位 Client Component。
 *
 * Phase1 スコープ: WS 接続確立 → `join` 送信 → `joined` 受信で状態初期化、
 * reducer による状態管理、および各UIコンポーネント（ChatTimeline / Recorder /
 * LanguageSelector / TTSToggle / audioPlaybackQueue）の結線を担う
 * （`docs/design/frontend-design.md` 参照）。
 *
 * 認可チェックは Phase2 の範囲（`docs/design/security-design.md` Phase1行）
 * のため、このタスクでは token を仮発行して誰でも入室できる簡易動作とする。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { serverMessageSchema, type ClientMessage, type SupportedLanguage } from "@shared/index";
import { ChatTimeline } from "@/components/ChatTimeline/ChatTimeline";
import { Recorder, type RecorderStatus } from "@/components/Recorder/Recorder";
import { LanguageSelector } from "@/components/LanguageSelector/LanguageSelector";
import { TTSToggle } from "@/components/TTSToggle/TTSToggle";
import { createAudioPlaybackQueue, type AudioPlaybackQueue } from "@/lib/audioPlaybackQueue";
import { initialRoomState, roomReducer, toMessageView, type AppStatus } from "./reducer";
import styles from "./RoomClient.module.css";

export interface RoomClientProps {
  roomId: string;
  wsUrl: string;
  role?: "owner" | "guest";
  displayName?: string;
  language?: SupportedLanguage;
  /**
   * ゲスト参加フロー（`POST /api/guest/join`）で発行された `gtt_guest`
   * クッキーの値（JWT文字列）。指定があれば `join` メッセージの `token` に
   * 使用し、無ければ Phase1 互換の仮トークンを発行する（既存動作を壊さない
   * 最小変更、`docs/design/supabase-design.md#ゲストのクッキー識別との連携` 参照）。
   */
  guestToken?: string;
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
  guestToken,
}: RoomClientProps) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);

  // ルーム内での言語変更（次の `start` 送信に反映）は join 時の言語とは
  // 独立させる。join 用の `language` prop を変更しても再接続はしない
  // （下記 useEffect の依存配列は `language` prop のまま＝初回参加時のみ使用）。
  const [currentLanguage, setCurrentLanguage] = useState<SupportedLanguage>(language);
  // 自分が聞き手としてTTSを受け取るかどうか（`start.enableTts` および
  // audioPlaybackQueue の再生可否の両方に連動する）。
  const [ttsEnabled, setTtsEnabled] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  if (tokenRef.current === undefined) {
    // `guestToken`（`gtt_guest` クッキー由来）があればそれを正式なゲスト識別
    // トークンとして使用する。無ければ Phase1 互換の仮トークンにフォールバック
    // する（既存動作を壊さない最小変更）。
    tokenRef.current = guestToken ?? createTemporaryToken();
  }

  // 音声再生キュー（TTS）。
  // レンダー時（関数コンポーネント本体）でインスタンスを生成すると、
  // StrictMode の setup→cleanup→setup 二重実行時に「cleanupでdispose済みの
  // 単一インスタンス」がrefに残ったまま復活せず、以降 enqueue が恒久的に
  // 無視される（TTS再生が永久に無効化される）不具合になる。
  // そのため生成は必ず effect 内で行い、cleanup で dispose + ref を null に
  // 戻す（＝次回の setup で必ず新しいインスタンスを作り直す）標準パターンとする。
  const audioQueueRef = useRef<AudioPlaybackQueue | null>(null);
  // effect 実行タイミングに関わらず「生成直後の有効状態」を正しく反映するための
  // ref（ttsEnabled の最新値をクロージャの stale値なしに参照する）。
  const ttsEnabledRef = useRef(ttsEnabled);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
    audioQueueRef.current?.setEnabled(ttsEnabled);
  }, [ttsEnabled]);

  useEffect(() => {
    // 生成時点では Audio 要素は作られない（enqueue 時に初めてファクトリが
    // 実行される）ため、副作用としては軽量。
    const queue = createAudioPlaybackQueue();
    queue.setEnabled(ttsEnabledRef.current);
    audioQueueRef.current = queue;

    return () => {
      queue.dispose();
      audioQueueRef.current = null;
    };
  }, []);

  /**
   * WS へ型安全にメッセージを送信するラッパー。
   * 未接続（OPEN以外）の場合は送信をスキップする（Recorder等からの誤送信防止）。
   */
  const sendMessage = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn("[RoomClient] WS未接続のため送信をスキップしました:", message.type);
      return;
    }
    socket.send(JSON.stringify(message));
  }, []);

  /**
   * TTSトグル操作時のハンドラ。ローカル状態（audioQueueの再生可否・次回
   * `start.enableTts` に反映）に加え、既に参加中のサーバーへも即時反映
   * されるよう `update_settings` を送信する。未接続時は `sendMessage` 側の
   * ガードにより送信がスキップされる。
   */
  const handleTtsToggle = useCallback(
    (enabled: boolean) => {
      setTtsEnabled(enabled);
      sendMessage({ type: "update_settings", enableTts: enabled });
    },
    [sendMessage],
  );

  /**
   * Recorder の内部状態変化をアプリ全体の状態（AppStatus）に連動させる。
   * 録音開始で "recording"、録音停止（idleに戻る）で "joined" に戻す。
   * 既に error 等の場合は誤って上書きしないよう、現在の状態を見て判定する。
   */
  const handleRecorderStatusChange = useCallback(
    (recorderStatus: RecorderStatus) => {
      if (recorderStatus === "recording") {
        dispatch({ type: "STATUS_CHANGED", status: "recording" });
      } else if (recorderStatus === "idle" && state.status === "recording") {
        dispatch({ type: "STATUS_CHANGED", status: "joined" });
      }
    },
    [state.status],
  );

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
          enableTts: ttsEnabledRef.current,
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
          case "participant_joined":
            dispatch({ type: "PARTICIPANT_JOINED", participant: message.participant });
            break;
          case "participant_left":
            dispatch({ type: "PARTICIPANT_LEFT", participantId: message.participantId });
            break;
          case "message":
            dispatch({ type: "MESSAGE", message: toMessageView(message) });
            break;
          case "audio":
            // 合成音声（TTS）をキューに追加する。
            // オートプレイ制約への配慮: 初回の音声はユーザー操作（録音開始ボタン
            // 押下）を起点とした発話に対する応答として届くため、ブラウザの
            // autoplay制限（ユーザー操作を起点としない再生のブロック）には
            // 通常抵触しない。
            audioQueueRef.current?.enqueue(message.data);
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

  const isRecording = state.status === "recording";
  const isJoinedOrRecording = state.status === "joined" || state.status === "recording";

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
        <p>参加者: {state.participants.filter((p) => p.present).length}人</p>
      </section>

      <section className={styles.controls} aria-label="設定">
        <LanguageSelector
          value={currentLanguage}
          onChange={setCurrentLanguage}
          disabled={isRecording}
        />
        <TTSToggle enabled={ttsEnabled} onChange={handleTtsToggle} />
      </section>

      <Recorder
        language={currentLanguage}
        sendMessage={sendMessage}
        disabled={!isJoinedOrRecording}
        enableTts={ttsEnabled}
        onStatusChange={handleRecorderStatusChange}
      />

      <ChatTimeline messages={state.messages} interim={state.interim || null} />
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
