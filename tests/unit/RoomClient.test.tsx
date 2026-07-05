/** @jest-environment jsdom */
/**
 * RoomClient（トークルーム画面の最上位 Client Component）の結線テスト。
 *
 * `RoomClient` は WS接続確立→join送信、joined/message/audio/error受信の
 * reducer反映、Recorder/LanguageSelector/TTSToggle/ChatTimeline/
 * audioPlaybackQueue の結線を担う（bd-two-device-translator-e5p）。
 *
 * jsdom には WebSocket が存在しないため、イベントを手動発火できる
 * モッククラスに差し替えて検証する。`createAudioPlaybackQueue` も
 * jest.mock してキューへの enqueue/setEnabled/dispose 呼び出しを検証する。
 */
import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RoomClient } from "@/app/(public)/room/[roomId]/RoomClient";
import { createAudioPlaybackQueue } from "@/lib/audioPlaybackQueue";
import type { ClientMessage, ServerMessage } from "@shared/index";

jest.mock("@/lib/audioPlaybackQueue", () => ({
  createAudioPlaybackQueue: jest.fn(),
}));

const createAudioPlaybackQueueMock = createAudioPlaybackQueue as jest.MockedFunction<
  typeof createAudioPlaybackQueue
>;

/** 生成されたキューモック（enqueue/setEnabled/dispose の呼び出し検証用）の型 */
interface QueueMock {
  enqueue: jest.Mock;
  setEnabled: jest.Mock;
  dispose: jest.Mock;
}

function createQueueMock(): QueueMock {
  return {
    enqueue: jest.fn(),
    setEnabled: jest.fn(),
    dispose: jest.fn(),
  };
}

/**
 * jsdom に存在しない WebSocket のテスト用モック。
 * 生成されたインスタンスは `MockWebSocket.instances` に蓄積され、
 * テストコードから `dispatchOpen` / `dispatchMessage` / `dispatchClose` で
 * イベントを手動発火できる。
 */
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

  /** テストコードからの手動発火: 接続確立 */
  dispatchOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open.forEach((listener) => listener({}));
  }

  /** テストコードからの手動発火: メッセージ受信 */
  dispatchMessage(message: ServerMessage): void {
    this.listeners.message.forEach((listener) =>
      listener({ data: JSON.stringify(message) }),
    );
  }

  /** テストコードからの手動発火: クローズ */
  dispatchClose(): void {
    this.listeners.close.forEach((listener) => listener({}));
  }

  /** 最後に送信された `join` メッセージの内容を取得するテストヘルパー */
  getSentMessages(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage);
  }
}

describe("RoomClient", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error jsdom には WebSocket が存在しないためモックで上書きする
    globalThis.WebSocket = MockWebSocket;
    createAudioPlaybackQueueMock.mockReset();
    createAudioPlaybackQueueMock.mockImplementation(() => createQueueMock() as never);
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

  function latestQueueMock(): QueueMock {
    const result = createAudioPlaybackQueueMock.mock.results[
      createAudioPlaybackQueueMock.mock.results.length - 1
    ];
    return result.value as QueueMock;
  }

  it("接続openでjoinメッセージをroomId/role/language/displayName反映して送信する", () => {
    render(
      <RoomClient
        roomId="room-abc"
        wsUrl="ws://localhost:3001/ws"
        role="owner"
        displayName="たろう"
        language="en-US"
      />,
    );

    const socket = latestSocket();
    expect(socket.url).toBe("ws://localhost:3001/ws");

    act(() => {
      socket.dispatchOpen();
    });

    const sent = socket.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "join",
      roomId: "room-abc",
      role: "owner",
      displayName: "たろう",
      language: "en-US",
    });
  });

  it("joined受信で参加者情報・接続状態表示を更新する", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
    });

    expect(screen.getByText("状態: 接続中...")).toBeInTheDocument();

    act(() => {
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [
          { participantId: "p1", role: "guest", language: "ja-JP", present: true },
          { participantId: "p2", role: "owner", language: "en-US", present: true },
        ],
        recentMessages: [],
      });
    });

    expect(screen.getByText("状態: 接続済み")).toBeInTheDocument();
    expect(screen.getByText("参加者: 2人")).toBeInTheDocument();
  });

  it("message受信でChatTimelineにバブルが描画され、isOwnMessageで左右が変わる", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [],
        recentMessages: [],
      });
    });

    act(() => {
      socket.dispatchMessage({
        type: "message",
        messageId: "m1",
        roomId: "room-abc",
        speakerParticipantId: "p1",
        speakerName: "自分",
        sourceLanguage: "ja-JP",
        originalText: "こんにちは",
        displayText: "こんにちは",
        displayLanguage: "ja-JP",
        isOwnMessage: true,
        createdAt: new Date().toISOString(),
      });
      socket.dispatchMessage({
        type: "message",
        messageId: "m2",
        roomId: "room-abc",
        speakerParticipantId: "p2",
        speakerName: "相手",
        sourceLanguage: "en-US",
        originalText: "hello",
        displayText: "こんにちは(訳)",
        displayLanguage: "ja-JP",
        isOwnMessage: false,
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("こんにちは(訳)")).toBeInTheDocument();

    const rows = screen.getByLabelText("メッセージ一覧").querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-own", "true");
    expect(rows[1]).toHaveAttribute("data-own", "false");
    expect(screen.getByText("相手")).toBeInTheDocument();
  });

  it("audio受信でaudioPlaybackQueueにbase64データがenqueueされる", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
    });

    act(() => {
      socket.dispatchMessage({
        type: "audio",
        messageId: "m1",
        mimeType: "audio/mpeg",
        data: "QkFTRTY0REFUQQ==",
      });
    });

    const queue = latestQueueMock();
    expect(queue.enqueue).toHaveBeenCalledWith("QkFTRTY0REFUQQ==");
  });

  it("TTSトグル操作でaudioPlaybackQueue.setEnabledが呼ばれる", async () => {
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
    });

    const queue = latestQueueMock();
    // 初期化 useEffect でも既定値(true)が反映される
    expect(queue.setEnabled).toHaveBeenCalledWith(true);
    queue.setEnabled.mockClear();

    const toggle = screen.getByRole("switch", { name: "読み上げ(TTS)" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(queue.setEnabled).toHaveBeenCalledWith(false);
  });

  it("Recorderのステータス変化(recording)でステータス表示とLanguageSelectorのdisabledが連動する", async () => {
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    const getUserMediaMock = jest.fn().mockResolvedValue({
      getTracks: () => [{ stop: jest.fn() }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    class MockMediaRecorder {
      static isTypeSupported(): boolean {
        return false;
      }
      state = "inactive";
      ondataavailable: ((event: unknown) => void) | null = null;
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        this.state = "inactive";
      }
    }
    // @ts-expect-error jsdom には MediaRecorder が存在しないためモックで上書きする
    globalThis.MediaRecorder = MockMediaRecorder;

    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [],
        recentMessages: [],
      });
    });

    expect(screen.getByRole("combobox", { name: "話す言語" })).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "開始" }));

    await waitFor(() => {
      expect(screen.getByText("ルーム: room-abc").closest("header")).toHaveTextContent(
        "状態: 録音中",
      );
    });
    expect(screen.getByRole("combobox", { name: "話す言語" })).toBeDisabled();

    const sent = socket.getSentMessages();
    expect(sent.some((m) => m.type === "start")).toBe(true);
  });

  it("StrictModeの二重mountでもaudioQueueが機能し続ける(生成2回・dispose1回・最後のインスタンスにenqueue)", () => {
    render(
      <StrictMode>
        <RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />
      </StrictMode>,
    );

    expect(createAudioPlaybackQueueMock).toHaveBeenCalledTimes(2);

    const firstQueue = createAudioPlaybackQueueMock.mock.results[0].value as QueueMock;
    const secondQueue = createAudioPlaybackQueueMock.mock.results[1].value as QueueMock;

    expect(firstQueue.dispose).toHaveBeenCalledTimes(1);
    expect(secondQueue.dispose).not.toHaveBeenCalled();

    // StrictModeでも WebSocket 接続の effect は最終的に1つだけ有効な状態になる
    const socket = latestSocket();
    act(() => {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "audio",
        messageId: "m1",
        mimeType: "audio/mpeg",
        data: "ZGF0YQ==",
      });
    });

    expect(secondQueue.enqueue).toHaveBeenCalledWith("ZGF0YQ==");
    expect(firstQueue.enqueue).not.toHaveBeenCalled();
  });

  /**
   * bd-two-device-translator-652: WS再接続時にチャットタイムラインが全消去される
   * バグの修正確認テスト（TDD Red）。
   *
   * シナリオ: 接続→joined→message受信でタイムラインに表示→サーバー側close
   * （fatalではない）→自動再接続（バックオフ 500ms）→再joined
   * （Phase1ではサーバーがrecentMessages: []を返す）→元のメッセージが
   * 表示され続けていることを検証する。
   *
   * 現状の実装は close ハンドラで `dispatch({ type: "RESET" })` を実行し、
   * reducer の RESET が messages を含む全状態を初期化してしまうため、
   * このテストは失敗する（修正後は成功する想定）。
   */
  it("再接続（close→再connect→joined）をまたいでもタイムラインのメッセージが表示され続ける", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const firstSocket = latestSocket();

    act(() => {
      firstSocket.dispatchOpen();
      firstSocket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [],
        recentMessages: [],
      });
    });

    act(() => {
      firstSocket.dispatchMessage({
        type: "message",
        messageId: "m1",
        roomId: "room-abc",
        speakerParticipantId: "p1",
        speakerName: "自分",
        sourceLanguage: "ja-JP",
        originalText: "こんにちは",
        displayText: "こんにちは",
        displayLanguage: "ja-JP",
        isOwnMessage: true,
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText("こんにちは")).toBeInTheDocument();

    // サーバー側切断（fatalではない）→ 自動再接続がスケジュールされる
    act(() => {
      firstSocket.dispatchClose();
    });

    // バックオフ（BASE_RECONNECT_DELAY_MS=500ms、初回attempt=0）経過で再接続
    act(() => {
      jest.advanceTimersByTime(500);
    });

    const secondSocket = latestSocket();
    expect(secondSocket).not.toBe(firstSocket);

    act(() => {
      secondSocket.dispatchOpen();
      // Phase1ではサーバーは recentMessages を常に空配列で返す
      secondSocket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [],
        recentMessages: [],
      });
    });

    // 再接続をまたいでも元のメッセージが表示され続けていること
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
  });
});
