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

  /**
   * 以下は Phase2/3 で実際に使用される予定のアクションのスモークテスト。
   * RoomClient.tsx 側の dispatch はまだ実装されていないが、reducer 単体としての
   * 実装漏れ・退行を検知するために追加する。
   */
  describe("Phase2/3 向けアクション（スモークテスト）", () => {
    const participantA = {
      participantId: "p1",
      role: "owner" as const,
      language: "ja-JP",
      present: true,
    };

    const participantB = {
      participantId: "p2",
      role: "guest" as const,
      language: "en-US",
      present: true,
    };

    it("PARTICIPANT_JOINED で新規参加者を末尾に追加する", () => {
      const withA = roomReducer(initialRoomState, {
        type: "PARTICIPANT_JOINED",
        participant: participantA,
      });

      const state = roomReducer(withA, {
        type: "PARTICIPANT_JOINED",
        participant: participantB,
      });

      expect(state.participants).toEqual([participantA, participantB]);
    });

    it("PARTICIPANT_JOINED で同一 participantId が既に存在する場合は置き換える", () => {
      const withA = roomReducer(initialRoomState, {
        type: "PARTICIPANT_JOINED",
        participant: participantA,
      });

      const updatedA = { ...participantA, present: false };
      const state = roomReducer(withA, {
        type: "PARTICIPANT_JOINED",
        participant: updatedA,
      });

      expect(state.participants).toEqual([updatedA]);
    });

    it("PARTICIPANT_LEFT で該当participantのpresentをfalseにする（一覧からは削除しない）", () => {
      const withBoth = roomReducer(
        roomReducer(initialRoomState, {
          type: "PARTICIPANT_JOINED",
          participant: participantA,
        }),
        { type: "PARTICIPANT_JOINED", participant: participantB },
      );

      const state = roomReducer(withBoth, {
        type: "PARTICIPANT_LEFT",
        participantId: "p2",
      });

      expect(state.participants).toHaveLength(2);
      expect(state.participants.find((p) => p.participantId === "p2")?.present).toBe(
        false,
      );
      expect(state.participants.find((p) => p.participantId === "p1")?.present).toBe(
        true,
      );
    });

    it("PARTICIPANT_LEFT で該当participantIdが存在しない場合は状態を変えない", () => {
      const withA = roomReducer(initialRoomState, {
        type: "PARTICIPANT_JOINED",
        participant: participantA,
      });

      const state = roomReducer(withA, {
        type: "PARTICIPANT_LEFT",
        participantId: "unknown",
      });

      expect(state.participants).toEqual([participantA]);
    });

    it("PARTICIPANT_UPDATED で該当participantを新しい内容に置き換える", () => {
      const withA = roomReducer(initialRoomState, {
        type: "PARTICIPANT_JOINED",
        participant: participantA,
      });

      const updatedA = { ...participantA, language: "en-US" };
      const state = roomReducer(withA, {
        type: "PARTICIPANT_UPDATED",
        participant: updatedA,
      });

      expect(state.participants).toEqual([updatedA]);
    });

    it("IDLE_HINT で idleHint を true にする", () => {
      const state = roomReducer(initialRoomState, { type: "IDLE_HINT" });
      expect(state.idleHint).toBe(true);
    });

    it("TOPIC で topicSuggestion を設定する", () => {
      const state = roomReducer(initialRoomState, {
        type: "TOPIC",
        suggestion: "最近見た映画の話",
      });
      expect(state.topicSuggestion).toBe("最近見た映画の話");
    });

    it("SUMMARY で summary を設定する", () => {
      const state = roomReducer(initialRoomState, {
        type: "SUMMARY",
        summary: "会話の要約テキスト",
      });
      expect(state.summary).toBe("会話の要約テキスト");
    });

    it("ROOM_ENDED で roomEnded を true にする", () => {
      const state = roomReducer(initialRoomState, { type: "ROOM_ENDED" });
      expect(state.roomEnded).toBe(true);
    });

    it("未知のアクション（default分岐）では状態を変更しない", () => {
      const state = roomReducer(initialRoomState, {
        type: "UNKNOWN_ACTION",
      } as unknown as Parameters<typeof roomReducer>[1]);
      expect(state).toBe(initialRoomState);
    });
  });
});
