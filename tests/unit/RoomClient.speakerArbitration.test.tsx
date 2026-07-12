/** @jest-environment jsdom */
/**
 * RoomClient × 話者交代制（bd-9mo）の結線テスト。
 *
 * Recorder をモックして muted prop（マイクミュートの最終判定 =
 * TTS半二重抑止 OR 他参加者が話者）と onAudioLevel 結線を RoomClient
 * レベルで検証する（実 Recorder の muted 動作は Recorder.test.tsx /
 * Recorder.audioPipeline.test.tsx、TTS抑止判定自体は halfDuplex.test.ts が担う）。
 *
 * WebSocket は RoomClient.test.tsx と同じ手動発火モックを使う。
 */
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RoomClient } from "@/app/(public)/room/[roomId]/RoomClient";
import { createAudioPlaybackQueue } from "@/lib/audioPlaybackQueue";
import type { ClientMessage, ServerMessage } from "@shared/index";
import { TTS_ECHO_GRACE_MS } from "@/app/(public)/room/[roomId]/halfDuplex";

jest.mock("@/lib/audioPlaybackQueue", () => ({
  createAudioPlaybackQueue: jest.fn(),
  primeHtmlAudioPlayback: jest.fn(),
}));

/** Recorder モック: muted を DOM 属性に出し、onAudioLevel を外から呼べるよう保持する */
let latestRecorderProps: {
  muted?: boolean;
  onAudioLevel?: (level: number) => void;
} = {};

jest.mock("@/components/Recorder/Recorder", () => ({
  Recorder: (props: { muted?: boolean; onAudioLevel?: (level: number) => void }) => {
    latestRecorderProps = props;
    return <div data-testid="recorder-mock" data-muted={String(props.muted ?? false)} />;
  },
}));

const createAudioPlaybackQueueMock = createAudioPlaybackQueue as jest.MockedFunction<
  typeof createAudioPlaybackQueue
>;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;

  private listeners: Record<string, Array<(event: unknown) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type]?.push(listener);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchClose();
  }

  dispatchOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open.forEach((listener) => listener({}));
  }

  dispatchMessage(message: ServerMessage): void {
    this.listeners.message.forEach((listener) =>
      listener({ data: JSON.stringify(message) }),
    );
  }

  dispatchClose(code?: number): void {
    this.listeners.close.forEach((listener) => listener({ code }));
  }

  getSentMessages(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage);
  }
}

describe("RoomClient × 話者交代制（bd-9mo）", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    latestRecorderProps = {};
    // @ts-expect-error jsdom には WebSocket が存在しないためモックで上書きする
    globalThis.WebSocket = MockWebSocket;
    createAudioPlaybackQueueMock.mockReset();
    createAudioPlaybackQueueMock.mockImplementation(
      () => ({ enqueue: jest.fn(), setEnabled: jest.fn(), dispose: jest.fn() }) as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  function latestSocket(): MockWebSocket {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!socket) throw new Error("no MockWebSocket instance created");
    return socket;
  }

  /** 接続確立 → joined（自分=p-self、相手=p-other 在室）まで進める共通処理 */
  function setupJoined(): MockWebSocket {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();
    act(() => {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p-self",
        room: { id: "room-abc", status: "active" },
        participants: [
          { participantId: "p-self", role: "owner", language: "ja-JP", present: true },
          { participantId: "p-other", role: "guest", language: "en-US", present: true },
        ],
        recentMessages: [],
      });
    });
    return socket;
  }

  function recorderMuted(): string | null {
    return screen.getByTestId("recorder-mock").getAttribute("data-muted");
  }

  it("active_speaker(他参加者)でmuted、active_speaker(null)で解除される", () => {
    const socket = setupJoined();
    expect(recorderMuted()).toBe("false");

    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-other" });
    });
    expect(recorderMuted()).toBe("true");

    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: null });
    });
    expect(recorderMuted()).toBe("false");
  });

  it("active_speaker(自分)ではmutedされない", () => {
    const socket = setupJoined();

    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-self" });
    });
    expect(recorderMuted()).toBe("false");
  });

  it("TTS半二重抑止とのOR: 両方立っている間は片方が解除されてもmutedが続く", () => {
    const socket = setupJoined();

    // audioPlaybackQueue の再生状態コールバック（第2引数）を取得して
    // 自分のTTS再生開始を模す
    const onPlaybackStateChange = createAudioPlaybackQueueMock.mock
      .calls[createAudioPlaybackQueueMock.mock.calls.length - 1][1] as (
      playing: boolean,
    ) => void;

    act(() => {
      onPlaybackStateChange(true); // TTS再生中
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-other" });
    });
    expect(recorderMuted()).toBe("true");

    // 話者が解放されてもTTS再生中なのでmuted継続
    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: null });
    });
    expect(recorderMuted()).toBe("true");

    // TTS再生停止＋残響猶予の経過で解除
    act(() => {
      onPlaybackStateChange(false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS);
    });
    expect(recorderMuted()).toBe("false");
  });

  it("joined（自分の再接続）で話者状態がリセットされ、mutedが解除される", () => {
    const socket = setupJoined();

    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-other" });
    });
    expect(recorderMuted()).toBe("true");

    // 再接続後の joined（切断中に active_speaker(null) を受け損ねた想定）
    act(() => {
      socket.dispatchMessage({
        type: "joined",
        participantId: "p-self",
        room: { id: "room-abc", status: "active" },
        participants: [
          { participantId: "p-self", role: "owner", language: "ja-JP", present: true },
        ],
        recentMessages: [],
      });
    });
    expect(recorderMuted()).toBe("false");
  });

  it("participant_left（退室者が話者）で話者状態がリセットされる。話者以外の退室では変わらない", () => {
    const socket = setupJoined();

    act(() => {
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-other" });
    });
    expect(recorderMuted()).toBe("true");

    // 話者ではない参加者の退室 → muted 維持
    act(() => {
      socket.dispatchMessage({ type: "participant_left", participantId: "p-third" });
    });
    expect(recorderMuted()).toBe("true");

    // 話者の退室 → リセット（サーバーのnull配信を受け損ねた場合の二重防御）
    act(() => {
      socket.dispatchMessage({ type: "participant_left", participantId: "p-other" });
    });
    expect(recorderMuted()).toBe("false");
  });

  it("joined前にactive_speakerを受信してもクラッシュせず、mutedにはなるがRecorderはdisabledのため実害がない（防御的確認）", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();
    act(() => {
      socket.dispatchOpen();
      // joined 前（selfParticipantId 未確定）に届くケース（通常は発生しない経路）
      socket.dispatchMessage({ type: "active_speaker", participantId: "p-other" });
    });

    // selfParticipantId=null のため「自分以外が話者」と判定され muted になるが、
    // この時点では未参加（Recorder は disabled）のため録音への実害はない。
    expect(recorderMuted()).toBe("true");

    // その後 joined が届けばリセットされて解除される
    act(() => {
      socket.dispatchMessage({
        type: "joined",
        participantId: "p-self",
        room: { id: "room-abc", status: "active" },
        participants: [
          { participantId: "p-self", role: "owner", language: "ja-JP", present: true },
        ],
        recentMessages: [],
      });
    });
    expect(recorderMuted()).toBe("false");
  });

  it("RecorderのonAudioLevelがaudio_levelメッセージとしてWS送信される", () => {
    setupJoined();
    const socket = latestSocket();

    act(() => {
      latestRecorderProps.onAudioLevel?.(0.42);
    });

    const sent = socket.getSentMessages().filter((m) => m.type === "audio_level");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "audio_level", level: 0.42 });
  });
});
