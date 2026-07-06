import {
  clientMessageSchema,
  serverMessageSchema,
  joinSchema,
  startSchema,
  audioClientSchema,
  commitSchema,
  stopSchema,
  joinedSchema,
  messageSchema,
  transcriptInterimSchema,
  transcriptFinalSchema,
  utteranceCommittedSchema,
  audioServerSchema,
  errorSchema,
  updateSettingsSchema,
  participantJoinedSchema,
  participantLeftSchema,
  requestEndSchema,
  roomEndedSchema,
} from "../../shared/ws-protocol/schema";

/**
 * shared/ws-protocol/schema.ts の単体テスト。
 *
 * docs/design/websocket-protocol.md に記載のJSON例を正常系の入力として
 * 用い、異常系（必須フィールド欠落・型不正・未対応値・未実装type）と
 * デフォルト値の挙動を検証する。
 */
describe("ws-protocol schema", () => {
  describe("clientMessageSchema: 正常系", () => {
    it("join メッセージ（仕様書例）をparseできる（enableTts省略時は既定値trueが補完される）", () => {
      const input = {
        type: "join",
        roomId: "b1f2...",
        role: "owner",
        token: "<Supabase access token>",
        displayName: "Taro",
        language: "ja-JP",
      };
      const result = clientMessageSchema.parse(input);
      expect(result).toEqual({ ...input, enableTts: true });
    });

    it("join メッセージは displayName 省略可", () => {
      const input = {
        type: "join",
        roomId: "b1f2...",
        role: "guest",
        token: "guest-jwt",
        language: "en-US",
      };
      expect(() => clientMessageSchema.parse(input)).not.toThrow();
    });

    it("join: enableTts を明示的に false にできる", () => {
      const input = {
        type: "join",
        roomId: "b1f2...",
        role: "guest",
        token: "guest-jwt",
        language: "en-US",
        enableTts: false,
      };
      const result = clientMessageSchema.parse(input);
      expect(result).toEqual(input);
    });

    it("join: enableTts を明示的に true にできる", () => {
      const input = {
        type: "join",
        roomId: "b1f2...",
        role: "guest",
        token: "guest-jwt",
        language: "en-US",
        enableTts: true,
      };
      const result = clientMessageSchema.parse(input);
      expect(result).toEqual(input);
    });

    it("start メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        detectLanguage: false,
        enableTts: true,
        chunkMs: 250,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      const result = clientMessageSchema.parse(input);
      expect(result).toEqual(input);
    });

    it("audio メッセージ（仕様書例）をparseできる", () => {
      const input = { type: "audio", data: "GkXfo59...(base64 WebM/Opus)" };
      expect(clientMessageSchema.parse(input)).toEqual(input);
    });

    it("commit メッセージをparseできる", () => {
      const input = { type: "commit" };
      expect(clientMessageSchema.parse(input)).toEqual(input);
    });

    it("stop メッセージをparseできる", () => {
      const input = { type: "stop" };
      expect(clientMessageSchema.parse(input)).toEqual(input);
    });
  });

  describe("startSchema: detectLanguage デフォルト値", () => {
    it("detectLanguage を省略すると false が補完される", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        enableTts: true,
        chunkMs: 250,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      const result = startSchema.parse(input);
      expect(result.detectLanguage).toBe(false);
    });

    it("detectLanguage を明示的に true にできる", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        detectLanguage: true,
        enableTts: true,
        chunkMs: 250,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(startSchema.parse(input).detectLanguage).toBe(true);
    });
  });

  describe("clientMessageSchema: 異常系（必須フィールド欠落）", () => {
    it("join: roomId 欠落を拒否する", () => {
      const input = {
        type: "join",
        role: "owner",
        token: "t",
        language: "ja-JP",
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: token 欠落を拒否する", () => {
      const input = {
        type: "join",
        roomId: "r1",
        role: "owner",
        language: "ja-JP",
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: language 欠落を拒否する", () => {
      const input = { type: "join", roomId: "r1", role: "owner", token: "t" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("start: enableTts 欠落を拒否する", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        chunkMs: 250,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("audio: data 欠落を拒否する", () => {
      const input = { type: "audio" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("audio: data が空文字列の場合は拒否する", () => {
      const input = { type: "audio", data: "" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });
  });

  describe("clientMessageSchema: 異常系（型不正）", () => {
    it("join: roomId が数値の場合は拒否する", () => {
      const input = {
        type: "join",
        roomId: 12345,
        role: "owner",
        token: "t",
        language: "ja-JP",
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: role が不正な値の場合は拒否する", () => {
      const input = {
        type: "join",
        roomId: "r1",
        role: "admin",
        token: "t",
        language: "ja-JP",
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: language が未対応言語コードの場合は拒否する", () => {
      const input = {
        type: "join",
        roomId: "r1",
        role: "owner",
        token: "t",
        language: "fr-FR",
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: displayName が50文字を超える場合は拒否する", () => {
      const input = {
        type: "join",
        roomId: "r1",
        role: "owner",
        token: "t",
        language: "ja-JP",
        displayName: "a".repeat(51),
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("join: displayName がちょうど50文字なら許可する", () => {
      const input = {
        type: "join",
        roomId: "r1",
        role: "owner",
        token: "t",
        language: "ja-JP",
        displayName: "a".repeat(50),
      };
      expect(() => clientMessageSchema.parse(input)).not.toThrow();
    });

    it("start: chunkMs が文字列の場合は拒否する", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        enableTts: true,
        chunkMs: "250",
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("start: chunkMs が0以下（非positive）の場合は拒否する", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        enableTts: true,
        chunkMs: 0,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("start: chunkMs が整数でない場合は拒否する", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        enableTts: true,
        chunkMs: 250.5,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("start: enableTts が真偽値でない場合は拒否する", () => {
      const input = {
        type: "start",
        sourceLanguage: "ja-JP",
        enableTts: "true",
        chunkMs: 250,
        silenceMs: 1000,
        maxChars: 80,
        maxSeconds: 10,
      };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });
  });

  describe("update_settings メッセージ", () => {
    it("update_settings（正しい形）をparseできる", () => {
      const input = { type: "update_settings", enableTts: false };
      expect(clientMessageSchema.parse(input)).toEqual(input);
    });

    it("update_settings: enableTts 欠落を拒否する", () => {
      const input = { type: "update_settings" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("update_settings: enableTts が真偽値でない場合は拒否する", () => {
      const input = { type: "update_settings", enableTts: "false" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    /**
     * bd-fki: updateSettingsSchema に追加された language/displayName の境界値テスト
     * （テストレビュー should-fix: 個別スキーマの境界値検証を追加）。
     */
    it("update_settings: language 付きの正しい形をparseできる", () => {
      const input = { type: "update_settings", enableTts: true, language: "en-US" };
      expect(updateSettingsSchema.parse(input)).toEqual(input);
    });

    it("update_settings: displayName がちょうど50文字なら許可する", () => {
      const input = {
        type: "update_settings",
        enableTts: true,
        displayName: "a".repeat(50),
      };
      expect(() => updateSettingsSchema.parse(input)).not.toThrow();
    });

    it("update_settings: displayName が51文字の場合は拒否する", () => {
      const input = {
        type: "update_settings",
        enableTts: true,
        displayName: "a".repeat(51),
      };
      expect(() => updateSettingsSchema.parse(input)).toThrow();
    });

    it("update_settings: language が未対応言語コード('fr-FR')の場合は拒否する", () => {
      const input = { type: "update_settings", enableTts: true, language: "fr-FR" };
      expect(() => updateSettingsSchema.parse(input)).toThrow();
    });
  });

  describe("clientMessageSchema: 異常系（type不正・未実装）", () => {
    it("未知の type を拒否する", () => {
      const input = { type: "unknown_type", foo: "bar" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });

    it("request_end（bd-e3p、オーナーによるルーム終了要求）をparseできる", () => {
      const input = { type: "request_end" };
      expect(clientMessageSchema.parse(input)).toEqual(input);
    });

    it("type フィールド自体が欠落している場合は拒否する", () => {
      const input = { roomId: "r1" };
      expect(() => clientMessageSchema.parse(input)).toThrow();
    });
  });

  describe("serverMessageSchema: 正常系", () => {
    it("joined メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "joined",
        participantId: "p_123",
        room: { id: "b1f2...", status: "active" },
        participants: [
          {
            participantId: "p_123",
            role: "owner",
            displayName: "Taro",
            language: "ja-JP",
            present: true,
          },
          {
            participantId: "p_456",
            role: "guest",
            displayName: "John",
            language: "en-US",
            present: true,
          },
        ],
        recentMessages: [],
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("transcript_interim メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "transcript_interim",
        text: "今日は雨が降っているので",
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("transcript_final メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "transcript_final",
        text: "今日は雨が降っているので",
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("utterance_committed メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "utterance_committed",
        text: "今日は雨が降っているので、屋内に行きましょう",
        reason: "silence",
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it.each(["silence", "maxChars", "maxSeconds", "commit", "stop"])(
      "utterance_committed の reason='%s' を許可する",
      (reason) => {
        const input = { type: "utterance_committed", text: "test", reason };
        expect(() => serverMessageSchema.parse(input)).not.toThrow();
      },
    );

    it("message メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "message",
        messageId: "m_789",
        roomId: "b1f2...",
        speakerParticipantId: "p_123",
        speakerName: "Taro",
        sourceLanguage: "ja-JP",
        originalText: "今日は雨が降っているので、屋内に行きましょう",
        displayText: "Since it is raining today, let's go indoors.",
        displayLanguage: "en-US",
        isOwnMessage: false,
        createdAt: "2026-07-04T10:00:00.000Z",
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("audio メッセージ（仕様書例）をparseできる", () => {
      const input = {
        type: "audio",
        messageId: "m_789",
        mimeType: "audio/mpeg",
        data: "//uQxAAA...(base64 mp3)",
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("error メッセージ（仕様書例）をparseできる", () => {
      const input = { type: "error", message: "...", fatal: false };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });
  });

  describe("serverMessageSchema: 異常系", () => {
    it("joined: participants が配列でない場合は拒否する", () => {
      const input = {
        type: "joined",
        participantId: "p_123",
        room: { id: "b1f2...", status: "active" },
        participants: "not-an-array",
        recentMessages: [],
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("joined: room.status が不正な値の場合は拒否する", () => {
      const input = {
        type: "joined",
        participantId: "p_123",
        room: { id: "b1f2...", status: "pending" },
        participants: [],
        recentMessages: [],
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("utterance_committed: reason が未対応の値の場合は拒否する", () => {
      const input = {
        type: "utterance_committed",
        text: "test",
        reason: "timeout",
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("message: sourceLanguage が未対応言語コードの場合は拒否する", () => {
      const input = {
        type: "message",
        messageId: "m_789",
        roomId: "b1f2...",
        speakerParticipantId: "p_123",
        speakerName: "Taro",
        sourceLanguage: "fr-FR",
        originalText: "text",
        displayText: "text",
        displayLanguage: "en-US",
        isOwnMessage: false,
        createdAt: "2026-07-04T10:00:00.000Z",
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("error: fatal が欠落している場合は拒否する", () => {
      const input = { type: "error", message: "..." };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("Phase3の summary（未実装）を拒否する", () => {
      const input = {
        type: "summary",
        roomId: "b1f2...",
        text: "...",
        createdAt: "2026-07-04T10:30:00.000Z",
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it.each(["owner_ended", "auto_timeout"])(
      "room_ended（bd-e3p、reason='%s'）をparseできる",
      (reason) => {
        const input = { type: "room_ended", reason };
        expect(serverMessageSchema.parse(input)).toEqual(input);
      },
    );

    it("room_ended: reason が未対応の値の場合は拒否する", () => {
      const input = { type: "room_ended", reason: "unknown_reason" };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("room_ended: reason 欠落を拒否する", () => {
      const input = { type: "room_ended" };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });
  });

  describe("participant_joined / participant_left メッセージ", () => {
    it("participant_joined（正しい形）をparseできる", () => {
      const input = {
        type: "participant_joined",
        participant: {
          participantId: "p_456",
          role: "guest",
          displayName: "John",
          language: "en-US",
          present: true,
        },
      };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("participant_joined: participant フィールド欠落を拒否する", () => {
      const input = { type: "participant_joined" };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("participant_joined: participant.role が不正な値の場合は拒否する", () => {
      const input = {
        type: "participant_joined",
        participant: {
          participantId: "p_456",
          role: "admin",
          displayName: "John",
          language: "en-US",
          present: true,
        },
      };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("participant_left（正しい形）をparseできる", () => {
      const input = { type: "participant_left", participantId: "p_456" };
      expect(serverMessageSchema.parse(input)).toEqual(input);
    });

    it("participant_left: participantId 欠落を拒否する", () => {
      const input = { type: "participant_left" };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });

    it("participant_left: participantId が空文字列の場合は拒否する", () => {
      const input = { type: "participant_left", participantId: "" };
      expect(() => serverMessageSchema.parse(input)).toThrow();
    });
  });

  describe("個別スキーマのエクスポート", () => {
    it("joinSchema, updateSettingsSchema, startSchema, audioClientSchema, commitSchema, stopSchema, requestEndSchema が個別にexportされている", () => {
      expect(joinSchema).toBeDefined();
      expect(updateSettingsSchema).toBeDefined();
      expect(startSchema).toBeDefined();
      expect(audioClientSchema).toBeDefined();
      expect(commitSchema).toBeDefined();
      expect(stopSchema).toBeDefined();
      expect(requestEndSchema).toBeDefined();
    });

    it("joinedSchema, messageSchema, transcript系, audioServerSchema, participant系, errorSchema, roomEndedSchema が個別にexportされている", () => {
      expect(joinedSchema).toBeDefined();
      expect(messageSchema).toBeDefined();
      expect(transcriptInterimSchema).toBeDefined();
      expect(transcriptFinalSchema).toBeDefined();
      expect(utteranceCommittedSchema).toBeDefined();
      expect(audioServerSchema).toBeDefined();
      expect(participantJoinedSchema).toBeDefined();
      expect(participantLeftSchema).toBeDefined();
      expect(errorSchema).toBeDefined();
      expect(roomEndedSchema).toBeDefined();
    });
  });
});
