import {
  initialRoomState,
  roomReducer,
  toMessageView,
  type MessageView,
} from "../../src/app/(public)/room/[roomId]/reducer";
import type { JoinedMessage, MessageMessage } from "../../shared/index";

/**
 * RoomClient の reducer（src/app/(public)/room/[roomId]/reducer.ts）の単体テスト。
 *
 * `docs/design/frontend-design.md` 状態管理(reducer)節に列挙されたアクションのうち、
 * Phase1 で実際に使用する STATUS_CHANGED / JOINED / INTERIM / MESSAGE / ERROR / RESET
 * の状態遷移を中心に検証する。
 */
describe("roomReducer", () => {
  it("初期状態は idle かつ空の参加者/メッセージを持つ", () => {
    expect(initialRoomState.status).toBe("idle");
    expect(initialRoomState.participants).toEqual([]);
    expect(initialRoomState.messages).toEqual([]);
    expect(initialRoomState.error).toBeNull();
  });

  it("STATUS_CHANGED で status を更新する", () => {
    const state = roomReducer(initialRoomState, {
      type: "STATUS_CHANGED",
      status: "connecting",
    });
    expect(state.status).toBe("connecting");
  });

  it("JOINED で selfParticipantId・participants・messages を初期化し status を joined にする", () => {
    const joined: Omit<JoinedMessage, "type"> = {
      participantId: "p1",
      room: { id: "room-1", status: "active" },
      participants: [
        { participantId: "p1", role: "guest", language: "ja-JP", present: true },
      ],
      recentMessages: [
        {
          type: "message",
          messageId: "m1",
          roomId: "room-1",
          speakerParticipantId: "p2",
          speakerName: "Alice",
          sourceLanguage: "en-US",
          originalText: "hello",
          displayText: "こんにちは",
          displayLanguage: "ja-JP",
          isOwnMessage: false,
          createdAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    };

    const state = roomReducer(initialRoomState, { type: "JOINED", ...joined });

    expect(state.status).toBe("joined");
    expect(state.selfParticipantId).toBe("p1");
    expect(state.participants).toHaveLength(1);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].displayText).toBe("こんにちは");
    expect(state.roomEnded).toBe(false);
    expect(state.error).toBeNull();
  });

  it("JOINED で room.status が ended の場合 roomEnded を true にする", () => {
    const state = roomReducer(initialRoomState, {
      type: "JOINED",
      participantId: "p1",
      room: { id: "room-1", status: "ended" },
      participants: [],
      recentMessages: [],
    });
    expect(state.roomEnded).toBe(true);
  });

  it("INTERIM で interim テキストを置き換える", () => {
    const state = roomReducer(initialRoomState, { type: "INTERIM", text: "こんに" });
    expect(state.interim).toBe("こんに");
  });

  it("MESSAGE でメッセージを追加し interim をクリアする", () => {
    const withInterim = roomReducer(initialRoomState, {
      type: "INTERIM",
      text: "途中経過",
    });

    const message: MessageView = {
      messageId: "m2",
      speakerParticipantId: "p1",
      speakerName: "Bob",
      sourceLanguage: "ja-JP",
      originalText: "こんにちは",
      displayText: "こんにちは",
      displayLanguage: "ja-JP",
      isOwnMessage: true,
      createdAt: "2026-07-04T00:00:01.000Z",
    };

    const state = roomReducer(withInterim, { type: "MESSAGE", message });

    expect(state.messages).toEqual([message]);
    expect(state.interim).toBe("");
  });

  it("ERROR で fatal=true の場合 status を error にする", () => {
    const state = roomReducer(initialRoomState, {
      type: "ERROR",
      message: "致命的なエラー",
      fatal: true,
    });
    expect(state.error).toBe("致命的なエラー");
    expect(state.status).toBe("error");
  });

  it("ERROR で fatal=false の場合 status は変えない", () => {
    const state = roomReducer(
      { ...initialRoomState, status: "joined" },
      { type: "ERROR", message: "軽微なエラー", fatal: false },
    );
    expect(state.error).toBe("軽微なエラー");
    expect(state.status).toBe("joined");
  });

  it("RESET で初期状態に戻しつつ status を connecting にする（再接続用）", () => {
    const joined = roomReducer(initialRoomState, {
      type: "JOINED",
      participantId: "p1",
      room: { id: "room-1", status: "active" },
      participants: [
        { participantId: "p1", role: "guest", language: "ja-JP", present: true },
      ],
      recentMessages: [],
    });

    const state = roomReducer(joined, { type: "RESET" });

    expect(state.status).toBe("connecting");
    expect(state.selfParticipantId).toBeNull();
    expect(state.participants).toEqual([]);
  });

  it("toMessageView が type/roomId を除いたビューへ変換する", () => {
    const raw: MessageMessage = {
      type: "message",
      messageId: "m3",
      roomId: "room-1",
      speakerParticipantId: "p1",
      speakerName: "Carol",
      sourceLanguage: "ja-JP",
      originalText: "元のテキスト",
      displayText: "翻訳済みテキスト",
      displayLanguage: "en-US",
      isOwnMessage: false,
      createdAt: "2026-07-04T00:00:02.000Z",
    };

    const view = toMessageView(raw);

    expect(view).toEqual({
      messageId: "m3",
      speakerParticipantId: "p1",
      speakerName: "Carol",
      sourceLanguage: "ja-JP",
      originalText: "元のテキスト",
      displayText: "翻訳済みテキスト",
      displayLanguage: "en-US",
      isOwnMessage: false,
      createdAt: "2026-07-04T00:00:02.000Z",
    });
  });
});
