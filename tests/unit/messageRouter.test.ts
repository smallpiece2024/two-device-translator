/**
 * server/routing/messageRouter.ts の単体テスト。
 *
 * I/O（translate / synthesize / send）はすべてモック注入し、GCP や WebSocket への
 * 実接続は一切行わない。1:1 / 1:N ルーティング・TTS分岐・翻訳失敗・TTS失敗の
 * 各シナリオを検証する。
 *
 * @see server/routing/messageRouter.ts
 */
import {
  routeUtterance,
  type MessageRouterDeps,
  type RoutingParticipant,
} from "../../server/routing/messageRouter";
import type { ServerMessage, SupportedLanguage } from "@shared/index";

function makeParticipant(
  overrides: Partial<RoutingParticipant> & { participantId: string; language: SupportedLanguage },
): RoutingParticipant {
  return {
    displayName: undefined,
    enableTts: false,
    send: jest.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MessageRouterDeps> = {}): MessageRouterDeps {
  return {
    translate: jest.fn(async (text: string) => `[TRANSLATED]${text}`),
    synthesize: jest.fn(async () => "base64-audio"),
    generateMessageId: jest.fn(() => "msg-1"),
    now: jest.fn(() => new Date("2026-07-04T00:00:00.000Z")),
    ...overrides,
  };
}

function sentMessages(send: RoutingParticipant["send"]): ServerMessage[] {
  return (send as jest.Mock).mock.calls.map((call) => call[0] as ServerMessage);
}

describe("routeUtterance() — 1:1 基本ルーティング", () => {
  test("話者(ja-JP)へ原文own、聞き手(en-US)へ翻訳済みメッセージを配信し、翻訳は1回だけ呼ばれる", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listener = makeParticipant({ participantId: "listener-1", language: "en-US" });
    const deps = makeDeps();

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listener],
        sourceLanguage: "ja-JP",
        text: "こんにちは",
      },
      deps,
    );

    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.translate).toHaveBeenCalledWith("こんにちは", "ja-JP", "en-US");

    const speakerMessages = sentMessages(speaker.send);
    expect(speakerMessages).toHaveLength(1);
    expect(speakerMessages[0]).toMatchObject({
      type: "message",
      speakerParticipantId: "speaker-1",
      sourceLanguage: "ja-JP",
      originalText: "こんにちは",
      displayText: "こんにちは",
      displayLanguage: "ja-JP",
      isOwnMessage: true,
    });

    const listenerMessages = sentMessages(listener.send);
    expect(listenerMessages).toHaveLength(1);
    expect(listenerMessages[0]).toMatchObject({
      type: "message",
      speakerParticipantId: "speaker-1",
      sourceLanguage: "ja-JP",
      originalText: "こんにちは",
      displayText: "[TRANSLATED]こんにちは",
      displayLanguage: "en-US",
      isOwnMessage: false,
    });
  });

  test("同一 messageId・createdAt が話者・聞き手の message で共有される（generateMessageId/now 注入値を使用）", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listener = makeParticipant({ participantId: "listener-1", language: "en-US" });
    const deps = makeDeps();

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listener],
        sourceLanguage: "ja-JP",
        text: "hello",
      },
      deps,
    );

    const speakerMsg = sentMessages(speaker.send)[0];
    const listenerMsg = sentMessages(listener.send)[0];
    expect(speakerMsg).toMatchObject({ messageId: "msg-1", createdAt: "2026-07-04T00:00:00.000Z" });
    expect(listenerMsg).toMatchObject({ messageId: "msg-1", createdAt: "2026-07-04T00:00:00.000Z" });
  });

  test("onMessageRouted フックへ翻訳結果を含む情報が渡される", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listener = makeParticipant({ participantId: "listener-1", language: "en-US" });
    const onMessageRouted = jest.fn();
    const deps = makeDeps({ onMessageRouted });

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listener],
        sourceLanguage: "ja-JP",
        text: "hello",
      },
      deps,
    );

    expect(onMessageRouted).toHaveBeenCalledTimes(1);
    expect(onMessageRouted).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        messageId: "msg-1",
        speakerParticipantId: "speaker-1",
        sourceLanguage: "ja-JP",
        originalText: "hello",
        translations: [{ language: "en-US", text: "[TRANSLATED]hello" }],
      }),
    );
  });
});

describe("routeUtterance() — 1:N ルーティング（言語ごとに1回だけ翻訳）", () => {
  test("聞き手3人（en-US, en-US, ja-JP＝話者と同言語）: 翻訳はen-US分の1回のみ、ja-JP聞き手には翻訳なしで原文が配信される", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listenerEn1 = makeParticipant({ participantId: "listener-en-1", language: "en-US" });
    const listenerEn2 = makeParticipant({ participantId: "listener-en-2", language: "en-US" });
    const listenerJa = makeParticipant({ participantId: "listener-ja", language: "ja-JP" });
    const deps = makeDeps();

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listenerEn1, listenerEn2, listenerJa],
        sourceLanguage: "ja-JP",
        text: "おはよう",
      },
      deps,
    );

    // 言語ごとに1回だけ翻訳される（en-US 2人でも1回）
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.translate).toHaveBeenCalledWith("おはよう", "ja-JP", "en-US");

    const en1Msg = sentMessages(listenerEn1.send)[0];
    const en2Msg = sentMessages(listenerEn2.send)[0];
    const jaMsg = sentMessages(listenerJa.send)[0];

    expect(en1Msg).toMatchObject({ displayText: "[TRANSLATED]おはよう", displayLanguage: "en-US", isOwnMessage: false });
    expect(en2Msg).toMatchObject({ displayText: "[TRANSLATED]おはよう", displayLanguage: "en-US", isOwnMessage: false });
    // 話者と同言語の聞き手には翻訳されず原文がそのまま配信される
    expect(jaMsg).toMatchObject({ displayText: "おはよう", displayLanguage: "ja-JP", isOwnMessage: false });
  });
});

describe("routeUtterance() — TTS分岐", () => {
  test("enableTts=trueの聞き手のみaudioを受信し、falseの聞き手はaudioを受信しない", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listenerTtsOn = makeParticipant({
      participantId: "listener-tts-on",
      language: "en-US",
      enableTts: true,
    });
    const listenerTtsOff = makeParticipant({
      participantId: "listener-tts-off",
      language: "en-US",
      enableTts: false,
    });
    const deps = makeDeps();

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listenerTtsOn, listenerTtsOff],
        sourceLanguage: "ja-JP",
        text: "こんばんは",
      },
      deps,
    );

    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.synthesize).toHaveBeenCalledWith("[TRANSLATED]こんばんは", "en-US");

    const onMessages = sentMessages(listenerTtsOn.send);
    expect(onMessages).toHaveLength(2);
    expect(onMessages[0].type).toBe("message");
    expect(onMessages[1]).toMatchObject({ type: "audio", mimeType: "audio/mpeg", data: "base64-audio" });

    const offMessages = sentMessages(listenerTtsOff.send);
    expect(offMessages).toHaveLength(1);
    expect(offMessages[0].type).toBe("message");
  });

  test("synthesizeがnullを返す場合（TTS無効等）はaudioを配信しない", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listener = makeParticipant({
      participantId: "listener-1",
      language: "en-US",
      enableTts: true,
    });
    const deps = makeDeps({ synthesize: jest.fn(async () => null) });

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listener],
        sourceLanguage: "ja-JP",
        text: "hello",
      },
      deps,
    );

    const messages = sentMessages(listener.send);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("message");
  });
});

describe("routeUtterance() — 翻訳失敗", () => {
  test("翻訳失敗時は話者へerror(fatal:false)を送り、聞き手には何も配信しない", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listener1 = makeParticipant({ participantId: "listener-1", language: "en-US" });
    const listener2 = makeParticipant({ participantId: "listener-2", language: "en-US" });
    const onMessageRouted = jest.fn();
    const deps = makeDeps({
      translate: jest.fn(async () => {
        throw new Error("translation api down");
      }),
      onMessageRouted,
    });

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listener1, listener2],
        sourceLanguage: "ja-JP",
        text: "こんにちは",
      },
      deps,
    );

    // 話者: 1) 原文own message、2) error(fatal:false) の2回のみ
    const speakerMessages = sentMessages(speaker.send);
    expect(speakerMessages).toHaveLength(2);
    expect(speakerMessages[0].type).toBe("message");
    expect(speakerMessages[1]).toMatchObject({ type: "error", fatal: false });

    // 聞き手には何も配信されない
    expect(listener1.send).not.toHaveBeenCalled();
    expect(listener2.send).not.toHaveBeenCalled();

    // 音声合成も呼ばれない
    expect(deps.synthesize).not.toHaveBeenCalled();

    // DBフックも呼ばれない（配信が完了していないため）
    expect(onMessageRouted).not.toHaveBeenCalled();
  });
});

describe("routeUtterance() — TTS失敗", () => {
  test("特定の聞き手のTTSが失敗しても、そのmessageは届き、話者へerrorが送られ、他の聞き手のaudioは継続する", async () => {
    const speaker = makeParticipant({ participantId: "speaker-1", language: "ja-JP" });
    const listenerFail = makeParticipant({
      participantId: "listener-fail",
      language: "en-US",
      enableTts: true,
    });
    const listenerOk = makeParticipant({
      participantId: "listener-ok",
      language: "en-US",
      enableTts: true,
    });
    const synthesize = jest
      .fn()
      .mockRejectedValueOnce(new Error("tts api down"))
      .mockResolvedValueOnce("base64-audio-ok");
    const deps = makeDeps({ synthesize });

    await routeUtterance(
      {
        roomId: "room-1",
        speaker,
        listeners: [listenerFail, listenerOk],
        sourceLanguage: "ja-JP",
        text: "hello",
      },
      deps,
    );

    // TTS失敗した聞き手も message は受信済み（audioは受信しない）
    const failMessages = sentMessages(listenerFail.send);
    expect(failMessages).toHaveLength(1);
    expect(failMessages[0].type).toBe("message");

    // 話者へerror(fatal:false)が送られる（原文ownメッセージに続き2件目）
    const speakerMessages = sentMessages(speaker.send);
    expect(speakerMessages).toHaveLength(2);
    expect(speakerMessages[1]).toMatchObject({ type: "error", fatal: false });

    // 他の聞き手はmessage + audioを両方受信し、継続して処理される
    const okMessages = sentMessages(listenerOk.send);
    expect(okMessages).toHaveLength(2);
    expect(okMessages[0].type).toBe("message");
    expect(okMessages[1]).toMatchObject({ type: "audio", data: "base64-audio-ok" });
  });
});
