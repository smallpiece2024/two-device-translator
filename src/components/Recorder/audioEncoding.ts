/**
 * 音声エンコーディングの純粋ロジック。
 *
 * MediaRecorder が生成する Blob チャンクを WS の `audio` メッセージ
 * （base64 文字列）へ変換するための処理を提供する。
 * ブラウザ専用 API（MediaRecorder 等）には依存しないため、Node 環境の
 * Jest でもテスト可能（`tests/unit/audioEncoding.test.ts` 参照）。
 *
 * 参照: docs/design/frontend-design.md（useRecorder節）、
 * プロトタイプ simple-translator/src/lib/audio.ts の base64 変換ロジック。
 */

/** base64 変換時に一度に処理するバイト数（コールスタック超過を防ぐ） */
const CHUNK_SIZE = 8192;

/**
 * ArrayBuffer を base64 文字列に変換する。
 *
 * `btoa(String.fromCharCode(...uint8Array))` は大きい配列でコールスタック
 * 超過を起こすため、Uint8Array を CHUNK_SIZE 単位で分割して変換する。
 *
 * @param buffer 変換元 ArrayBuffer
 * @returns base64 文字列
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  let binary = "";

  for (let offset = 0; offset < uint8Array.length; offset += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * base64 文字列を ArrayBuffer に変換する（往復変換の検証・デコード用）。
 *
 * @param base64 変換元 base64 文字列
 * @returns ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const uint8Array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    uint8Array[i] = binary.charCodeAt(i);
  }
  return uint8Array.buffer;
}

/**
 * Blob を base64 文字列に変換する（非同期）。
 *
 * 内部で Blob.arrayBuffer() → arrayBufferToBase64 を呼ぶ。
 *
 * @param blob 変換元 Blob
 * @returns base64 文字列
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

/** MediaRecorder の優先 mimeType（フォールバック順） */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

/**
 * ブラウザが対応している mimeType を返す。
 * 優先度順に `PREFERRED_MIME_TYPES` を試し、最初に対応しているものを返す。
 * 全て非対応、または非ブラウザ環境（SSR・Node）の場合は undefined を返す。
 */
export function getSupportedMimeType(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (typeof MediaRecorder === "undefined") return undefined;

  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return undefined;
}
