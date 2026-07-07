"use client";

/**
 * Recorder: マイク入力の開始/停止・手動区切りを行う自己完結の Client Component。
 *
 * プロトタイプ（simple-translator/src/components/Recorder.tsx +
 * src/hooks/useRecorder.ts + src/lib/audio.ts）を移植し、WS メッセージ生成を
 * `shared/ws-protocol` の `ClientMessage` 型に適合させたもの。
 *
 * 設計方針（docs/design/frontend-design.md Recorder節）:
 * - ボタンは「開始」「停止」「手動で発話を区切る」の3つ。
 * - 開始: マイク権限取得 → MediaRecorder 開始 → `start` 送信（sourceLanguage・
 *   しきい値設定を含む）。
 * - 停止: `stop` 送信 → MediaRecorder 停止・トラック解放。
 * - 手動で発話を区切る: `commit` 送信。
 * - 言語検出モードトグル（FR-4.3）は `SettingsPanel` が担当し、本コンポーネントは
 *   `detectLanguage` prop を受け取って `start` に反映するのみ（bd-fki で移管）。
 *
 * このコンポーネントは RoomClient への結線を行わない（並行タスクとの衝突防止）。
 * 呼び出し側が `sendMessage` で WS 送信を担い、`disabled` で外部状態（未接続等）
 * による活性制御を行う。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, SupportedLanguage } from "@shared/index";
import { blobToBase64, getSupportedMimeType } from "./audioEncoding";
import styles from "./Recorder.module.css";

/** 発話区切りしきい値の既定値（docs/design/websocket-protocol.md `start`節） */
export const DEFAULT_CHUNK_MS = 250;
export const DEFAULT_SILENCE_MS = 1000;
export const DEFAULT_MAX_CHARS = 80;
export const DEFAULT_MAX_SECONDS = 10;

/** 録音操作の内部状態 */
export type RecorderStatus = "idle" | "starting" | "recording" | "error";

export interface RecorderProps {
  /** 自分の話す言語（`start.sourceLanguage` に使う） */
  language: SupportedLanguage;
  /** WS へメッセージを送信する関数（結線は呼び出し側の責務） */
  sendMessage: (message: ClientMessage) => void;
  /**
   * 外部要因（未接続・ルーム終了等）による操作不可フラグ。
   * true の場合、開始ボタンを無効化する。
   */
  disabled?: boolean;
  /** 自分が聞き手として TTS を受け取るか（`start.enableTts`）。既定 true */
  enableTts?: boolean;
  /**
   * 言語検出モード（FR-4.3、`start.detectLanguage`）。トグルUIは
   * `SettingsPanel` が担い、本コンポーネントは値を受け取って次の `start` に
   * 反映するのみ。既定 false。
   */
  detectLanguage?: boolean;
  /** 録音チャンク送信間隔（ms）。既定 `DEFAULT_CHUNK_MS` */
  chunkMs?: number;
  /** 発話区切り: 無音しきい値（ms）。既定 `DEFAULT_SILENCE_MS` */
  silenceMs?: number;
  /** 発話区切り: 最大文字数。既定 `DEFAULT_MAX_CHARS` */
  maxChars?: number;
  /** 発話区切り: 最大秒数。既定 `DEFAULT_MAX_SECONDS` */
  maxSeconds?: number;
  /**
   * true の間、録音中であれば強制的に停止する（ルーム終了時など、呼び出し側が
   * 能動的に録音を打ち切りたい場合に使う）。`disabled` は開始操作のみを抑止する
   * ため、既に録音中のセッションを止めるにはこのフラグを使う
   * （`docs/design/frontend-design.md` room_ended ハンドリング節）。既定 false。
   */
  forceStop?: boolean;
  /**
   * 録音の内部状態（`RecorderStatus`）が変化するたびに呼ばれるコールバック。
   * 呼び出し側（RoomClient）が録音開始/停止をアプリ全体の状態（`AppStatus`）に
   * 連動させるためのフック。結線は呼び出し側の責務とし、本コンポーネントは
   * 自身の状態変化を通知するのみ。
   */
  onStatusChange?: (status: RecorderStatus) => void;
  /**
   * true の間、マイクトラックを一時ミュートする（`MediaStreamTrack.enabled=false`。
   * 半二重制御 bd-dnh: TTS再生中の音響フィードバック防止）。
   * 録音・チャンク送信自体は継続する（無音が送られる）ため、サーバー側の
   * STTストリームは途切れない（送信を止める方式は Audio Timeout を招くため不採用）。
   * 既定 false。
   */
  muted?: boolean;
}

/**
 * Recorder コンポーネント。
 *
 * マイク権限の取得・MediaRecorder の開始/停止・音声チャンクの base64 化と
 * 送信を自己完結で行う。RoomClient への結線（reducer 更新等）は行わない。
 */
export function Recorder({
  language,
  sendMessage,
  disabled = false,
  enableTts = true,
  detectLanguage = false,
  chunkMs = DEFAULT_CHUNK_MS,
  silenceMs = DEFAULT_SILENCE_MS,
  maxChars = DEFAULT_MAX_CHARS,
  maxSeconds = DEFAULT_MAX_SECONDS,
  forceStop = false,
  onStatusChange,
  muted = false,
}: RecorderProps) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isUnmountedRef = useRef(false);
  /**
   * 開始処理の多重実行防止用フラグ。
   * `getUserMedia` はマイク許可ダイアログ表示中（数百ms〜数秒）待たされるため、
   * `status` の state 更新（非同期・バッチ処理）だけに頼ると、その間の連打で
   * handleStart が並行実行されてしまう。ref による同期的なガードで
   * 呼び出し開始時点から確実にブロックする（finally で解除）。
   */
  const isStartingRef = useRef(false);

  const sendMessageRef = useRef(sendMessage);
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  // 半二重ミュート（bd-dnh）: muted の変化をマイクトラックへ反映する。
  // getUserMedia 完了前に muted が変わるケースに備え、ref にも保持して
  // ストリーム取得直後（handleStart 内）にも現在値を適用する。
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }, [muted]);

  useEffect(() => {
    onStatusChangeRef.current?.(status);
  }, [status]);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      stopInternal();
    };
    // マウント/アンマウント時のみ実行する（stopInternal は関数宣言のため参照は安定）
  }, []);

  /** MediaRecorder の停止とマイクトラックの解放を行う（内部専用） */
  function stopInternal() {
    const recorder = mediaRecorderRef.current;
    if (recorder && (recorder.state === "recording" || recorder.state === "paused")) {
      recorder.stop();
    }
    mediaRecorderRef.current = null;

    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
  }

  const handleStart = useCallback(async () => {
    if (disabled || status === "recording" || status === "starting" || isStartingRef.current) {
      return;
    }
    // getUserMedia 呼び出し前に同期的にガードをセットする（連打対策）。
    isStartingRef.current = true;
    setStatus("starting");

    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (isUnmountedRef.current) return;
        const message =
          err instanceof Error
            ? `マイクへのアクセスが拒否されました: ${err.message}`
            : "マイクへのアクセスに失敗しました";
        setErrorMessage(message);
        setStatus("error");
        return;
      }
    } finally {
      isStartingRef.current = false;
    }

    if (isUnmountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;

    // 取得直後に現在のミュート状態を適用する（TTS再生中に録音を開始した場合、
    // 最初から無音トラックで開始する。bd-dnh）。
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !mutedRef.current;
    });

    const supportedMimeType = getSupportedMimeType();
    const options: MediaRecorderOptions = supportedMimeType ? { mimeType: supportedMimeType } : {};
    const recorder = new MediaRecorder(stream, options);

    recorder.ondataavailable = (event: BlobEvent) => {
      const blob = event.data;
      if (blob.size === 0) return;

      blobToBase64(blob)
        .then((base64) => {
          if (isUnmountedRef.current) return;
          sendMessageRef.current({ type: "audio", data: base64 });
        })
        .catch((err: unknown) => {
          console.error("[Recorder] 音声チャンクのbase64変換に失敗しました", err);
        });
    };

    mediaRecorderRef.current = recorder;
    recorder.start(chunkMs);

    sendMessageRef.current({
      type: "start",
      sourceLanguage: language,
      detectLanguage,
      enableTts,
      chunkMs,
      silenceMs,
      maxChars,
      maxSeconds,
    });

    setErrorMessage(null);
    setStatus("recording");
  }, [
    disabled,
    status,
    language,
    detectLanguage,
    enableTts,
    chunkMs,
    silenceMs,
    maxChars,
    maxSeconds,
  ]);

  const handleStop = useCallback(() => {
    if (status !== "recording") return;
    sendMessageRef.current({ type: "stop" });
    stopInternal();
    setStatus("idle");
  }, [status]);

  const handleCommit = useCallback(() => {
    if (status !== "recording") return;
    sendMessageRef.current({ type: "commit" });
  }, [status]);

  /**
   * `forceStop=true` を受けたら、録音中であれば強制的に停止する
   * （ルーム終了時の即時停止。`docs/design/frontend-design.md` room_ended
   * ハンドリング節）。`handleStop` は `status==="recording"` 以外は no-op なので
   * 何度呼ばれても安全。
   *
   * 【レース対策】依存配列に `status` も含める。`forceStop` が true になった
   * 瞬間、まだ `getUserMedia` の許可待ち（`status==="starting"`）であることが
   * あり、その時点ではこの effect が実行されても `handleStop` は no-op で終わる。
   * その後 `forceStop` 自体は値が変わらないため、`status` を依存に入れておかないと
   * `getUserMedia` 解決後に `status` が "recording" に遷移しても effect が
   * 再実行されず、room_ended 後もマイク許可待ちからそのまま録音が続いてしまう。
   * `status` を依存に含めることで "starting"→"recording" の遷移時にも再評価され、
   * `forceStop && status === "recording"` を確実に検出して停止できる。
   */
  useEffect(() => {
    if (forceStop && status === "recording") {
      handleStop();
    }
  }, [forceStop, status, handleStop]);

  const isRecording = status === "recording";
  const isStarting = status === "starting";

  return (
    <div className={styles.recorder}>
      <div className={styles.statusRow}>
        <span>状態: {statusLabel(status)}</span>
        {errorMessage && <span className={styles.errorText}>{" | "}エラー: {errorMessage}</span>}
      </div>

      {isRecording && (
        <div className={styles.recordingIndicator} aria-live="polite" aria-label="録音中">
          <span className={styles.recordingDot} aria-hidden="true" />
          <span>録音中</span>
        </div>
      )}

      <div className={styles.controls}>
        {isRecording ? (
          <button type="button" onClick={handleStop} className={`${styles.btn} ${styles.btnStop}`}>
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            disabled={disabled || isStarting}
            className={`${styles.btn} ${styles.btnStart}`}
          >
            {isStarting ? "開始中..." : "開始"}
          </button>
        )}

        <button
          type="button"
          onClick={handleCommit}
          disabled={!isRecording}
          className={styles.btn}
          aria-label="手動で発話を区切る"
        >
          手動で発話を区切る
        </button>
      </div>
    </div>
  );
}

function statusLabel(status: RecorderStatus): string {
  switch (status) {
    case "idle":
      return "待機中";
    case "starting":
      return "開始中...";
    case "recording":
      return "録音中";
    case "error":
      return "エラー";
    default:
      return status;
  }
}
