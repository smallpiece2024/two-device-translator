/**
 * server/room/session.ts の単体テスト。
 *
 * STT ストリーム生成（`createSpeechStream`）はテスト用フェイクへ差し替え、
 * WebSocket も `send`/`readyState` のみ持つ最小フェイクを使う（GCP・実接続なし）。
 *
 * @see server/room/session.ts
 * @see server/utterance/utteranceBuffer.ts
 */
import { WebSocket } from "ws";
import { Session, type ParticipantIdentity } from "../../server/room/session";
import type { SpeechStreamHandle } from "../../server/gcp/types";
import type { StartMessage } from "@shared/index";

// ---------------------------------------------------------------------------
// テストヘルパー
// ---------------------------------------------------------------------------

/** createSpeechStream 呼び出しをキャプチャし、onFinal/onInterim/onError を手動発火できるフェイク */
function createFakeSpeechStreamFactory() {
  const instances: Array<{
    handle: SpeechStreamHandle;
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string, fatal: boolean) => void;
    write: jest.Mock;
    end: jest.Mock;
    destroy: jest.Mock;
  }> = [];

  const factory = jest.fn(
    (options: {
      languageCode: string;
      onInterim: (text: string) => void;
      onFinal: (text: string) => void;
      onError: (message: string, fatal: boolean) => void;
    }): SpeechStreamHandle => {
      const write = jest.fn();
      const end = jest.fn();
      const destroy = jest.fn();
      const handle: SpeechStreamHandle = { write, end, destroy };
      instances.push({
        handle,
        onInterim: options.onInterim,
        onFinal: options.onFinal,
        onError: options.onError,
        write,
        end,
        destroy,
      });
      return handle;
    },
  );

  return { factory, instances };
}

function makeFakeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    OPEN: WebSocket.OPEN,
    send: jest.fn(),
  } as unknown as WebSocket;
}

function makeIdentity(overrides: Partial<ParticipantIdentity> = {}): ParticipantIdentity {
  return {
    participantId: "participant-1",
    role: "owner",
    displayName: "Taro",
    language: "ja-JP",
    ...overrides,
  };
}

function makeStartMessage(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    type: "start",
    sourceLanguage: "ja-JP",
    enableTts: false,
    chunkMs: 250,
    silenceMs: 1000,
    maxChars: 80,
    maxSeconds: 10,
    ...overrides,
  };
}

// UtteranceBufferManager のタイマー（silence/maxDuration）が残ったままだと
// jest がハングする（open handle）ため、生成したセッションは全テスト終了時に
// 必ず destroyRecording() でタイマーを解放する。
const activeSessions: Session[] = [];

function makeSession(identityOverrides: Partial<ParticipantIdentity> = {}): {
  session: Session;
  ws: WebSocket;
} {
  const ws = makeFakeWs();
  const session = new Session(makeIdentity(identityOverrides), ws);
  activeSessions.push(session);
  return { session, ws };
}

afterEach(() => {
  while (activeSessions.length > 0) {
    const session = activeSessions.pop();
    session?.destroyRecording();
  }
});

describe("Session — startRecording / writeAudioChunk / commitUtterance / stopRecording", () => {
  test("startRecordingでsourceLanguage/enableTtsが更新され、isRecordingがtrueになる", () => {
    const { session, ws } = makeSession({ language: "ja-JP" });
    const { factory } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage({ sourceLanguage: "en-US", enableTts: true }), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    expect(session.language).toBe("en-US");
    expect(session.enableTts).toBe(true);
    expect(session.isRecording).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("writeAudioChunkはbase64をデコードしてSTTストリームへ書き込む", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted: jest.fn(),
      createSpeechStream: factory,
    });

    const original = Buffer.from("audio-bytes");
    session.writeAudioChunk(original.toString("base64"));

    expect(instances[0].write).toHaveBeenCalledTimes(1);
    const written = instances[0].write.mock.calls[0][0] as Buffer;
    expect(Array.from(written)).toEqual(Array.from(original));
  });

  test("録音開始前にwriteAudioChunkを呼んでも何も起きない", () => {
    const { session, ws } = makeSession();

    expect(() => session.writeAudioChunk(Buffer.from("x").toString("base64"))).not.toThrow();
  });

  test("STTのfinalでバッファへ追加され、commitUtteranceで確定しonUtteranceCommittedが発火する", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    instances[0].onFinal("こんにちは");
    session.commitUtterance();

    expect(onUtteranceCommitted).toHaveBeenCalledTimes(1);
    expect(onUtteranceCommitted).toHaveBeenCalledWith("こんにちは", "commit");

    // utterance_committed が ws へ送信されていること
    const sendMock = ws.send as jest.Mock;
    const sentTexts = sendMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sentTexts).toContainEqual({ type: "utterance_committed", text: "こんにちは", reason: "commit" });
  });

  test("バッファが空の状態でcommitUtteranceを呼んでもonUtteranceCommittedは発火しない", () => {
    const { session, ws } = makeSession();
    const { factory } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    session.commitUtterance();

    expect(onUtteranceCommitted).not.toHaveBeenCalled();
  });

  test("stopRecordingは残バッファを確定し、STTストリームをendしisRecordingをfalseにする", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    instances[0].onFinal("残りの発話");
    session.stopRecording();

    expect(onUtteranceCommitted).toHaveBeenCalledWith("残りの発話", "stop");
    expect(instances[0].end).toHaveBeenCalledTimes(1);
    expect(session.isRecording).toBe(false);
  });

  test("destroyRecordingは確定せずにSTTストリームをdestroyしisRecordingをfalseにする", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    instances[0].onFinal("破棄される発話");
    session.destroyRecording();

    expect(onUtteranceCommitted).not.toHaveBeenCalled();
    expect(instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(session.isRecording).toBe(false);
  });

  test("既に録音中に再度startRecordingすると、既存のストリームがdestroyされてから新しいストリームが生成される", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted: jest.fn(),
      createSpeechStream: factory,
    });
    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted: jest.fn(),
      createSpeechStream: factory,
    });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(session.isRecording).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 空文字final のエッジケース
// ---------------------------------------------------------------------------
describe("Session — STTのfinalがtranscript未定義（空文字）で発火するケース", () => {
  test("空文字finalが1回だけ来てもtranscript_finalは送信されず、commitしても発話は確定・配信されない（onUtteranceCommittedは呼ばれない）", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    // speechStream.ts の実装では `result.alternatives[0].transcript ?? ""` により
    // transcript 未定義時は onFinal("") が呼ばれるが、Session 側は空文字（trim後空含む）を
    // バッファに積む前にスキップし、transcript_final も送信しない（新仕様）。
    expect(() => instances[0].onFinal("")).not.toThrow();

    const sendMock = ws.send as jest.Mock;
    const sentMessages = sendMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "transcript_final" }),
    );

    expect(() => session.commitUtterance()).not.toThrow();
    // 空発話は配信されない（addFinal 自体がスキップされているため onCommit は発火しない）
    expect(onUtteranceCommitted).not.toHaveBeenCalled();

    const committedMessages = sendMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((m) => m.type === "utterance_committed");
    expect(committedMessages).toHaveLength(0);
  });

  test("空文字finalの後に実発話が来た場合、空文字は無視され実発話のみが確定・配信される", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    instances[0].onFinal("");
    instances[0].onFinal("実際の発話");
    session.commitUtterance();

    expect(onUtteranceCommitted).toHaveBeenCalledTimes(1);
    expect(onUtteranceCommitted).toHaveBeenCalledWith("実際の発話", "commit");
  });

  test("空文字finalのみでstopRecordingしても例外は起きず、確定は発生しない", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    instances[0].onFinal("");

    expect(() => session.stopRecording()).not.toThrow();
    expect(onUtteranceCommitted).not.toHaveBeenCalled();
    expect(session.isRecording).toBe(false);
  });

  test("空文字finalが連続しても例外は起きず、後続のdestroyRecordingも安全に呼べる", () => {
    const { session, ws } = makeSession();
    const { factory, instances } = createFakeSpeechStreamFactory();
    const onUtteranceCommitted = jest.fn();

    session.startRecording(makeStartMessage(), {
      onUtteranceCommitted,
      createSpeechStream: factory,
    });

    expect(() => {
      instances[0].onFinal("");
      instances[0].onFinal("");
      instances[0].onFinal("");
    }).not.toThrow();

    expect(() => session.destroyRecording()).not.toThrow();
    expect(onUtteranceCommitted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attachSocket — 再接続時の録音破棄分岐（bd-e3p、テストレビュー指摘対応）
// ---------------------------------------------------------------------------
describe("Session — attachSocket（再接続時のソケット差し替え）", () => {
  test(
    "旧セッションが録音中（isRecording）の状態で再接続すると、destroyRecording相当の" +
      "処理でSTTストリームがdestroyされ、孤立ストリームが残らない",
    () => {
      const { session } = makeSession();
      const { factory, instances } = createFakeSpeechStreamFactory();
      const onUtteranceCommitted = jest.fn();

      session.startRecording(makeStartMessage(), {
        onUtteranceCommitted,
        createSpeechStream: factory,
      });
      expect(session.isRecording).toBe(true);

      const newWs = makeFakeWs();
      session.attachSocket(newWs);

      // 旧STTストリームがdestroyされ（孤立させない）、確定されずに破棄される
      expect(instances[0].destroy).toHaveBeenCalledTimes(1);
      expect(onUtteranceCommitted).not.toHaveBeenCalled();
      expect(session.isRecording).toBe(false);
    },
  );

  test("録音中でない状態での再接続は、destroyRecording相当の処理を呼ばない（副作用なし）", () => {
    const { session } = makeSession();

    const newWs = makeFakeWs();
    expect(() => session.attachSocket(newWs)).not.toThrow();
    expect(session.isRecording).toBe(false);
  });

  test("attachSocketはpresent:falseだったセッションをtrueに戻し、差し替え前のソケットを返す", () => {
    const { session, ws: oldWs } = makeSession();
    session.present = false; // 不在（切断済み）状態を模す

    const newWs = makeFakeWs();
    const returned = session.attachSocket(newWs);

    expect(returned).toBe(oldWs);
    expect(session.present).toBe(true);
  });
});
