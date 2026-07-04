/**
 * WS接続ごとのセッション状態（1接続 = ルーム内の1参加者）。
 *
 * `join` 受理後に生成され、接続が close するまで生存する。
 * 言語設定・TTSトグル・在室状態（present）を保持し、この接続への
 * メッセージ送信を担う。
 *
 * Phase1スコープでは STT ストリーム・発話バッファ等の録音セッション状態は
 * 扱わない（`start`/`audio` は別タスクで拡張する。server-design.md 参照）。
 *
 * @see docs/design/server-design.md 「モジュール構成」「状態モデル（インメモリ）」
 */
import type { WebSocket } from "ws";
import type { ParticipantSummary, ServerMessage } from "@shared/index";
import type { SupportedLanguage } from "@shared/index";

/** 参加者ロール（owner=ルーム作成者、guest=招待された相手） */
export type ParticipantRole = "owner" | "guest";

/** `verifyJoin` が返す、検証済み参加者の識別情報 */
export interface ParticipantIdentity {
  participantId: string;
  role: ParticipantRole;
  displayName?: string;
  language: SupportedLanguage;
}

/** `Session` 生成時の追加オプション */
export interface SessionOptions {
  /** 聞き手として TTS を受け取るか（既定 false） */
  enableTts?: boolean;
}

/**
 * 1接続 = 1参加者のセッション。
 *
 * ルーム内での可変状態（言語・TTSトグル・在室状態）と、この接続への
 * メッセージ送信手段を1つにまとめる。
 */
export class Session {
  readonly participantId: string;
  readonly role: ParticipantRole;
  displayName?: string;
  language: SupportedLanguage;
  enableTts: boolean;
  present: boolean;

  private readonly ws: WebSocket;

  constructor(identity: ParticipantIdentity, ws: WebSocket, options: SessionOptions = {}) {
    this.participantId = identity.participantId;
    this.role = identity.role;
    this.displayName = identity.displayName;
    this.language = identity.language;
    this.enableTts = options.enableTts ?? false;
    this.present = true;
    this.ws = ws;
  }

  /**
   * この接続へサーバー→クライアントメッセージを送信する。
   * 接続が既に開いていない場合は何もしない（close処理中の二重送信防止）。
   */
  send(message: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /** `joined.participants` 等に載せるための要約情報へ変換する */
  toSummary(): ParticipantSummary {
    return {
      participantId: this.participantId,
      role: this.role,
      displayName: this.displayName,
      language: this.language,
      present: this.present,
    };
  }
}
