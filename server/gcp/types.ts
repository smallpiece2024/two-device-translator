/**
 * server/gcp/ 内の各ラッパーが共有する型定義。
 *
 * Phase1 では対応言語を ja-JP / en-US に固定する（言語検出モードは Phase2）。
 * `docs/design/gcp-integration.md` の「言語レジストリ」節が正本になる想定だが、
 * このタスク時点では `shared/languages` が未実装のため、
 * `server/gcp/languageCodes.ts` に最小限の変換表を置き、
 * レジストリ実装後は関数引数注入（`resolve*` オプション）で差し替えられるようにしている。
 */

/** Phase1 で対応する言語コード（WebSocket プロトコル上の正本と同一の BCP-47 相当コード）。 */
export const SUPPORTED_LANGUAGES = ["ja-JP", "en-US"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Cloud Speech-to-Text Streaming ストリームのハンドル。
 * `createSpeechStream()` が返す。
 */
export interface SpeechStreamHandle {
  /** base64 デコード済みの音声チャンクを STT ストリームへ書き込む。 */
  write(chunk: Buffer): void;
  /** STT ストリームへの書き込みを正常終了する（stop メッセージ受信時等）。 */
  end(): void;
  /** STT ストリームを強制破棄する（切断・再 start 時のクリーンアップ用）。 */
  destroy(): void;
}
