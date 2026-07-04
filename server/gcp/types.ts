/**
 * server/gcp/ 内の各ラッパーが共有する型定義。
 *
 * 対応言語（`SupportedLanguage` / `SUPPORTED_LANGUAGES`）は
 * `shared/languages/registry.ts` を正本とし、ここでは re-export のみ行う
 * （二重管理しない。`docs/design/gcp-integration.md` の「言語レジストリ」節参照）。
 * 各言語コードの実際の解決（STT/Translation/TTS 用コード）は
 * `server/gcp/languageCodes.ts` がレジストリを引いて行う。
 */
export type { SupportedLanguage } from "@shared/index";
export { SUPPORTED_LANGUAGES } from "@shared/index";

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
