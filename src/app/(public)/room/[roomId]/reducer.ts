/**
 * RoomClient の状態管理 reducer。
 *
 * `docs/design/frontend-design.md`（状態管理(reducer)節）の設計に従う。
 * Phase1 スコープでは WS 接続（STATUS_CHANGED）・参加確定（JOINED）・
 * 確定発話（MESSAGE）・認識途中結果（INTERIM）・エラー（ERROR）・
 * 再接続時のリセット（RESET）のみを実際に使用するが、後続タスク
 * （マイク入力・チャットUI・AIアシスタント等）が同じ reducer を拡張
 * できるよう、設計ドキュメントに列挙されたアクション一式を定義しておく。
 */
import type {
  JoinedMessage,
  MessageMessage,
  ParticipantSummary,
  RoomEndedReason,
  SupportedLanguage,
} from "@shared/index";

/** 画面全体の接続・録音状態 */
export type AppStatus = "idle" | "connecting" | "joined" | "recording" | "error";

/** 参加者一覧の表示用ビュー（`ParticipantSummary` と同一形状） */
export type ParticipantView = ParticipantSummary;

/** チャットタイムライン表示用のメッセージビュー（`MessageMessage` から type/roomId を除いたもの） */
export type MessageView = Omit<MessageMessage, "type" | "roomId">;

export interface RoomState {
  status: AppStatus;
  selfParticipantId: string | null;
  participants: ParticipantView[];
  messages: MessageView[];
  /** 自分の途中認識（表示専用、翻訳/TTS対象外） */
  interim: string;
  /** 話題提供ボタン強調（owner、Phase3） */
  idleHint: boolean;
  topicSuggestion: string | null;
  /** 終了時要約（Phase3） */
  summary: string | null;
  roomEnded: boolean;
  /** ルーム終了理由（`"owner_ended"` | `"auto_timeout"`）。終了バナーの文言出し分けに使う */
  endedReason: RoomEndedReason | null;
  error: string | null;
}

export const initialRoomState: RoomState = {
  status: "idle",
  selfParticipantId: null,
  participants: [],
  messages: [],
  interim: "",
  idleHint: false,
  topicSuggestion: null,
  summary: null,
  roomEnded: false,
  endedReason: null,
  error: null,
};

export type RoomAction =
  | { type: "STATUS_CHANGED"; status: AppStatus }
  | {
      type: "JOINED";
      participantId: JoinedMessage["participantId"];
      room: JoinedMessage["room"];
      participants: JoinedMessage["participants"];
      recentMessages: JoinedMessage["recentMessages"];
    }
  | { type: "PARTICIPANT_JOINED"; participant: ParticipantView }
  | { type: "PARTICIPANT_LEFT"; participantId: string }
  /**
   * `participant_updated`（bd-ecb/bd-fki）の反映。サーバーからのペイロードは
   * `participantSummarySchema` の全項目（role/present含む）ではなく
   * `participantId`/`language`/`displayName`(optional) のみのため、
   * 既存の参加者一覧の該当エントリへ**マージ**する形にする（role/present は
   * 既存値を維持。`displayName` 省略時も既存値を維持、
   * `docs/design/websocket-protocol.md` `participant_updated` 節参照）。
   */
  | {
      type: "PARTICIPANT_UPDATED";
      participantId: string;
      language: SupportedLanguage;
      displayName?: string;
    }
  | { type: "INTERIM"; text: string }
  | { type: "MESSAGE"; message: MessageView }
  | { type: "IDLE_HINT" }
  | { type: "TOPIC"; suggestion: string }
  | { type: "SUMMARY"; summary: string }
  | { type: "ROOM_ENDED"; reason?: RoomEndedReason }
  | { type: "ERROR"; message: string; fatal: boolean }
  | { type: "RESET" };

/** `MessageMessage`（WS受信ペイロード）から `type`/`roomId` を除いた表示用ビューへ変換する */
export function toMessageView(message: MessageMessage): MessageView {
  return {
    messageId: message.messageId,
    speakerParticipantId: message.speakerParticipantId,
    speakerName: message.speakerName,
    sourceLanguage: message.sourceLanguage,
    originalText: message.originalText,
    displayText: message.displayText,
    displayLanguage: message.displayLanguage,
    isOwnMessage: message.isOwnMessage,
    createdAt: message.createdAt,
  };
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "STATUS_CHANGED":
      return { ...state, status: action.status };

    case "JOINED":
      // Phase1のサーバーは会話履歴を保持しないため、再接続時の recentMessages は
      // 常に空配列で返る。空配列で無条件に上書きすると再接続の度にクライアント側の
      // タイムラインが消えてしまうため、非空の場合のみ recentMessages で置き換え、
      // 空のときはクライアントが保持している messages をそのまま維持する。
      return {
        ...state,
        status: "joined",
        selfParticipantId: action.participantId,
        participants: action.participants,
        messages:
          action.recentMessages.length > 0
            ? action.recentMessages.map(toMessageView)
            : state.messages,
        roomEnded: action.room.status === "ended",
        error: null,
      };

    case "PARTICIPANT_JOINED": {
      const withoutSelf = state.participants.filter(
        (p) => p.participantId !== action.participant.participantId,
      );
      return { ...state, participants: [...withoutSelf, action.participant] };
    }

    case "PARTICIPANT_LEFT":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.participantId === action.participantId ? { ...p, present: false } : p,
        ),
      };

    case "PARTICIPANT_UPDATED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.participantId === action.participantId
            ? {
                ...p,
                language: action.language,
                displayName: action.displayName ?? p.displayName,
              }
            : p,
        ),
      };

    case "INTERIM":
      return { ...state, interim: action.text };

    case "MESSAGE":
      return {
        ...state,
        messages: [...state.messages, action.message],
        interim: "",
      };

    case "IDLE_HINT":
      return { ...state, idleHint: true };

    case "TOPIC":
      return { ...state, topicSuggestion: action.suggestion };

    case "SUMMARY":
      return { ...state, summary: action.summary };

    case "ROOM_ENDED":
      // reason 省略時（`joined.room.status==="ended"` 経由等）は既存の endedReason を維持する。
      return { ...state, roomEnded: true, endedReason: action.reason ?? state.endedReason };

    case "ERROR":
      return {
        ...state,
        error: action.message,
        status: action.fatal ? "error" : state.status,
      };

    case "RESET":
      // Phase1のサーバーは会話履歴を保持しないため、再接続時にクライアント保持分の
      // messages を消してしまうと会話の唯一の記録が失われる。接続状態・エラー・
      // 参加者情報など再接続で作り直されるべき項目のみ初期化し、messages は維持する。
      return { ...initialRoomState, status: "connecting", messages: state.messages };

    default:
      return state;
  }
}
