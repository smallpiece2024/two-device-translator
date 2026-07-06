"use client";

/**
 * トークルーム画面の最上位 Client Component。
 *
 * Phase1 スコープ: WS 接続確立 → `join` 送信 → `joined` 受信で状態初期化、
 * reducer による状態管理、および各UIコンポーネント（ChatTimeline / Recorder /
 * SettingsPanel(LanguageSelector・TTSToggle・言語検出トグル・表示名) /
 * audioPlaybackQueue）の結線を担う（`docs/design/frontend-design.md` 参照）。
 *
 * 認可チェックは Phase2 の範囲（`docs/design/security-design.md` Phase1行）
 * のため、このタスクでは token を仮発行して誰でも入室できる簡易動作とする。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  serverMessageSchema,
  type ClientMessage,
  type RoomEndedReason,
  type SupportedLanguage,
} from "@shared/index";
import { ChatTimeline } from "@/components/ChatTimeline/ChatTimeline";
import { Recorder, type RecorderStatus } from "@/components/Recorder/Recorder";
import { SettingsPanel } from "@/components/SettingsPanel/SettingsPanel";
import {
  createAudioPlaybackQueue,
  primeHtmlAudioPlayback,
  type AudioPlaybackQueue,
} from "@/lib/audioPlaybackQueue";
import { initialRoomState, roomReducer, toMessageView, type AppStatus } from "./reducer";
import styles from "./RoomClient.module.css";

export interface RoomClientProps {
  roomId: string;
  wsUrl: string;
  role?: "owner" | "guest";
  displayName?: string;
  language?: SupportedLanguage;
  /**
   * ルーム所有者の Supabase アクセストークン（Server Component が所有者と
   * 判定した場合のみ渡される、bd-fmk）。指定があれば `join` メッセージの
   * `token` に最優先で使用する（WSサーバーの厳格検証の owner 分岐が検証する）。
   */
  ownerToken?: string;
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
  ownerToken,
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
  // 表示名（`update_settings.displayName`、SettingsPanel から確定操作で変更）。
  // join 用の `displayName` prop とは独立させ、再接続時も join 用の初期値では
  // なくローカルで保持している最新値を使う（ttsEnabled と同様のパターン）。
  const [currentDisplayName, setCurrentDisplayName] = useState<string | undefined>(displayName);
  // 再接続時の `join` 送信は effect のクロージャ内（マウント時に一度だけ構築）
  // で行われるため、`currentDisplayName`/`currentLanguage` の state 変更を
  // その場で読み取れない（stale closure）。サーバー（roomManager）は再接続joinの
  // 値で表示名・言語を上書きする契約のため、SettingsPanelでの変更後に自動
  // 再接続が走ると設定が初期値へ巻き戻ってしまう。`ttsEnabledRef` と同じ
  // パターンで最新値を ref に同期し、join 組み立て時に ref 経由で参照する。
  const currentDisplayNameRef = useRef(currentDisplayName);
  const currentLanguageRef = useRef(currentLanguage);
  useEffect(() => {
    currentDisplayNameRef.current = currentDisplayName;
  }, [currentDisplayName]);
  useEffect(() => {
    currentLanguageRef.current = currentLanguage;
  }, [currentLanguage]);
  // 言語検出モード（FR-4.3）。次の `start.detectLanguage` に反映する。
  // 検出確定（`participant_updated`、自分宛て）を受けたら自動でOFFに戻す。
  const [detectLanguage, setDetectLanguage] = useState(false);
  // オーナーの終了ボタンの2段階確認（誤タップ防止）。
  const [endConfirming, setEndConfirming] = useState(false);

  // モバイルブラウザの自動再生制限対策（bd-8bd）: 最初のユーザー操作
  // （画面のどこかへのタップ/クリック）で共有 Audio 要素をアンロックする。
  // アンロック成功後の prime 呼び出しは no-op のため、リスナーは張ったままでよい
  // （失敗時は次のジェスチャで自動的に再試行される）。
  useEffect(() => {
    const prime = () => primeHtmlAudioPlayback();
    document.addEventListener("pointerdown", prime, { passive: true });
    document.addEventListener("touchend", prime, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", prime);
      document.removeEventListener("touchend", prime);
    };
  }, []);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `room_ended` を受信済みか（終端状態）。close ハンドラで参照して以降の
   * 自動再接続を停止するためのフラグ。ended ルームへ再接続しても再び
   * room_ended→close となるだけで無駄なため（server-design.md 実装確定事項
   * bd-e3p 節）。コンポーネントの生存期間を通じて維持する（reducer の
   * roomEnded state と異なり、close ハンドラのクロージャから同期的に
   * 参照できる ref にする）。
   */
  const roomEndedRef = useRef(false);
  const tokenRef = useRef<string | undefined>(undefined);
  if (tokenRef.current === undefined) {
    // 優先順位: ownerToken（Supabaseアクセストークン、bd-fmk）>
    // guestToken（`gtt_guest` クッキー由来）> Phase1 互換の仮トークン
    // （dev/E2E の AUTH_MODE=insecure 用フォールバック）。
    tokenRef.current = ownerToken ?? guestToken ?? createTemporaryToken();
  }

  /**
   * `participant_updated` が自分宛てかどうかをメッセージハンドラ内（WS effect
   * のクロージャ）で判定するための ref。WS の message ハンドラは接続確立時に
   * 一度だけ登録され、以降 `state` の変化では再登録されないため、
   * `state.selfParticipantId` を直接参照すると stale な値を掴む
   * （ttsEnabledRef と同じ理由でrefを介する）。
   */
  const selfParticipantIdRef = useRef<string | null>(null);
  useEffect(() => {
    selfParticipantIdRef.current = state.selfParticipantId;
  }, [state.selfParticipantId]);

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
   * 話す言語の変更ハンドラ（SettingsPanel経由）。ローカル状態（次回 `start` に
   * 反映）に加え、サーバーへ `update_settings` で通知する（他参加者への翻訳先
   * ルーティングは即時反映、STTの言語自体は次の `start` から反映、
   * `docs/design/websocket-protocol.md` `update_settings` 節）。
   */
  const handleLanguageChange = useCallback(
    (nextLanguage: SupportedLanguage) => {
      setCurrentLanguage(nextLanguage);
      sendMessage({ type: "update_settings", enableTts: ttsEnabledRef.current, language: nextLanguage });
    },
    [sendMessage],
  );

  /**
   * 表示名の変更確定ハンドラ（SettingsPanel の blur/Enter 確定）。
   * サーバーへ `update_settings` で通知し、他参加者へ `participant_updated`
   * として配信される（本人含む全参加者、bd-ecb で確定した配信範囲）。
   */
  const handleDisplayNameChange = useCallback(
    (nextDisplayName: string) => {
      setCurrentDisplayName(nextDisplayName);
      sendMessage({
        type: "update_settings",
        enableTts: ttsEnabledRef.current,
        displayName: nextDisplayName,
      });
    },
    [sendMessage],
  );

  /**
   * 言語検出モードトグルのハンドラ。サーバーへの通知は行わず、次の
   * `start.detectLanguage` に反映するのみ（`docs/design/frontend-design.md`
   * LanguageSelector節）。
   */
  const handleDetectLanguageChange = useCallback((next: boolean) => {
    setDetectLanguage(next);
  }, []);

  /**
   * オーナーの終了ボタン操作ハンドラ（2段階確認、誤タップ防止）。
   * 1回目のクリックで確認表示に切り替え、確認表示中の「終了する」クリックで
   * `request_end` を送信する（docs/design/websocket-protocol.md `request_end`節）。
   */
  const handleRequestEndClick = useCallback(() => {
    if (!endConfirming) {
      setEndConfirming(true);
      return;
    }
    sendMessage({ type: "request_end" });
    setEndConfirming(false);
  }, [endConfirming, sendMessage]);

  const handleCancelEnd = useCallback(() => {
    setEndConfirming(false);
  }, []);

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
          // 再接続時もSettingsPanelで変更した最新の表示名・言語を送る
          // （サーバーは join の値で表示名・言語を上書きする契約のため、
          // props の初期値のまま送ると設定が巻き戻ってしまう）。
          displayName: currentDisplayNameRef.current,
          language: currentLanguageRef.current,
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
            // 稀に room.status==="ended" で joined が届くケース（型上許容）でも
            // 終端状態として扱い、以降の自動再接続を止める（room_ended 受信時と
            // 同じ扱い、docs/design/server-design.md 実装確定事項 bd-e3p 節）。
            if (message.room.status === "ended") {
              roomEndedRef.current = true;
              audioQueueRef.current?.setEnabled(false);
            }
            // 直後に連続して届きうる participant_updated の自分判定（本判定は
            // このeffectと同じ message ハンドラ内で同期的に行われる）に確実に
            // 間に合わせるため、useEffect経由の同期を待たずここで同期的に
            // 設定する（useEffect側の同期は他経路からの更新のためそのまま残す）。
            selfParticipantIdRef.current = message.participantId;
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
          case "participant_updated":
            // 本人を含む全参加者へ配信される（bd-ecb で確定した配信範囲）。
            // 参加者一覧の言語表示を更新する。
            dispatch({
              type: "PARTICIPANT_UPDATED",
              participantId: message.participantId,
              language: message.language,
              displayName: message.displayName,
            });
            // 自分宛て（言語検出モードで自分の言語が確定した場合等）なら、
            // 言語セレクタの表示を検出結果に同期し、検出トグルを自動OFFに戻す
            // （常時再判定しない、`docs/design/frontend-design.md` LanguageSelector節）。
            if (message.participantId === selfParticipantIdRef.current) {
              setCurrentLanguage(message.language);
              setDetectLanguage(false);
            }
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
          case "room_ended":
            // room_ended は終端状態。以降の自動再接続を止める（サーバーは
            // ended ルームへの再joinに対しても room_ended→close(1000) を返すのみ
            // で、再接続ループは無駄になるため）。録音中なら強制停止し、
            // 音声キューは新規再生を止める（再生中の1件は最後まで再生させる、
            // audioPlaybackQueue.setEnabled の設計判断を踏襲）。
            roomEndedRef.current = true;
            audioQueueRef.current?.setEnabled(false);
            dispatch({ type: "ROOM_ENDED", reason: message.reason });
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

        if (roomEndedRef.current) {
          // room_ended（終端状態）に伴う close。終了バナーは既に room_ended
          // ハンドラで dispatch 済みのため、ここでは再接続もエラー表示もしない。
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

      {state.roomEnded && (
        <div role="status" className={styles.endedBanner} data-ended-reason={state.endedReason ?? undefined}>
          <p className={styles.endedBannerTitle}>会話は終了しました</p>
          <p className={styles.endedBannerReason}>{endedReasonLabel(state.endedReason)}</p>
          {/* Phase3: ここに終了時要約（summary）を表示する（docs/design/frontend-design.md AIAssistantPanel節） */}
        </div>
      )}

      <section className={styles.participants} aria-label="参加者一覧">
        <p>参加者: {state.participants.filter((p) => p.present).length}人</p>
      </section>

      {role === "owner" && !state.roomEnded && (
        <section className={styles.inviteSection} aria-label="招待">
          {/* 新規タブで開くことでWS接続（入室状態）を維持したままQRを提示できる
              （bd-hue。ルーム内モーダル化は将来の改善候補）。 */}
          <a
            href={`/rooms/${roomId}/invite?from=room`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="招待QRを表示（新しいタブで開く）"
            className={styles.inviteQrLink}
          >
            招待QRを表示
          </a>
        </section>
      )}

      <section className={styles.controls} aria-label="設定">
        <SettingsPanel
          displayName={currentDisplayName}
          onDisplayNameChange={handleDisplayNameChange}
          language={currentLanguage}
          onLanguageChange={handleLanguageChange}
          languageDisabled={isRecording}
          detectLanguage={detectLanguage}
          onDetectLanguageChange={handleDetectLanguageChange}
          ttsEnabled={ttsEnabled}
          onTtsChange={handleTtsToggle}
          disabled={state.roomEnded}
        />
      </section>

      <Recorder
        language={currentLanguage}
        sendMessage={sendMessage}
        disabled={!isJoinedOrRecording || state.roomEnded}
        forceStop={state.roomEnded}
        enableTts={ttsEnabled}
        detectLanguage={detectLanguage}
        onStatusChange={handleRecorderStatusChange}
      />

      {role === "owner" && !state.roomEnded && (
        <section className={styles.endSection} aria-label="ルーム終了">
          {endConfirming ? (
            <div className={styles.endConfirm} role="alertdialog" aria-label="ルーム終了の確認">
              <p className={styles.endConfirmMessage}>
                本当にルームを終了しますか？会話は終了し、元に戻せません。
              </p>
              <div className={styles.endConfirmActions}>
                <button
                  type="button"
                  onClick={handleRequestEndClick}
                  className={styles.endConfirmButton}
                >
                  終了する
                </button>
                <button type="button" onClick={handleCancelEnd} className={styles.endCancelButton}>
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={handleRequestEndClick} className={styles.endButton}>
              ルームを終了する
            </button>
          )}
        </section>
      )}

      <ChatTimeline messages={state.messages} interim={state.interim || null} />
    </div>
  );
}

/** `state.endedReason` に応じた終了バナー用の文言（FR-12.1/FR-12.2） */
function endedReasonLabel(reason: RoomEndedReason | null): string {
  switch (reason) {
    case "owner_ended":
      return "理由: オーナーによる終了";
    case "auto_timeout":
      return "理由: 一定時間の不在による自動終了";
    default:
      return "";
  }
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
