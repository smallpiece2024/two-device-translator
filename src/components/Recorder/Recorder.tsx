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
 * - 言語検出モードトグル（FR-4.3）は Phase2 のため UI のみ用意し disabled にする。
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
export type RecorderStatus = "idle" | "recording" | "error";

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
  /** 録音チャンク送信間隔（ms）。既定 `DEFAULT_CHUNK_MS` */
  chunkMs?: number;
  /** 発話区切り: 無音しきい値（ms）。既定 `DEFAULT_SILENCE_MS` */
  silenceMs?: number;
  /** 発話区切り: 最大文字数。既定 `DEFAULT_MAX_CHARS` */
  maxChars?: number;
  /** 発話区切り: 最大秒数。既定 `DEFAULT_MAX_SECONDS` */
  maxSeconds?: number;
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
  chunkMs = DEFAULT_CHUNK_MS,
  silenceMs = DEFAULT_SILENCE_MS,
  maxChars = DEFAULT_MAX_CHARS,
  maxSeconds = DEFAULT_MAX_SECONDS,
}: RecorderProps) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 言語検出モードトグル（Phase2 のため UI のみ・常に false で送信） */
  const [detectLanguage, setDetectLanguage] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isUnmountedRef = useRef(false);

  const sendMessageRef = useRef(sendMessage);
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

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
    if (disabled || status === "recording") return;

    let stream: MediaStream;
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

    if (isUnmountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;

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
      detectLanguage: false,
      enableTts,
      chunkMs,
      silenceMs,
      maxChars,
      maxSeconds,
    });

    setErrorMessage(null);
    setStatus("recording");
  }, [disabled, status, language, enableTts, chunkMs, silenceMs, maxChars, maxSeconds]);

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

  const isRecording = status === "recording";

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
            disabled={disabled}
            className={`${styles.btn} ${styles.btnStart}`}
          >
            開始
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

      <label className={styles.detectLanguageToggle}>
        <input
          type="checkbox"
          checked={detectLanguage}
          onChange={(e) => setDetectLanguage(e.target.checked)}
          disabled
          aria-label="言語検出モード（Phase2で有効化予定）"
        />
        言語検出モード（近日公開）
      </label>
    </div>
  );
}

function statusLabel(status: RecorderStatus): string {
  switch (status) {
    case "idle":
      return "待機中";
    case "recording":
      return "録音中";
    case "error":
      return "エラー";
    default:
      return status;
  }
}
