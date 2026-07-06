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
  primeHtmlAudioPlayback: jest.fn(),
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

  /**
   * two-device-translator-4xi: room_ended（オーナー終了／不在自動終了）受信時の
   * ハンドリング。終了バナー表示（reason別文言）・以降の自動再接続停止・
   * 操作UIのdisabled化・オーナーの終了ボタン（2段階確認）・guestには
   * 終了ボタン非表示、を検証する（docs/design/frontend-design.md
   * room_ended ハンドリング節）。
   */
  describe("room_ended ハンドリング（two-device-translator-4xi）", () => {
    function joinRoom(socket: MockWebSocket) {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [],
        recentMessages: [],
      });
    }

    it("room_ended(owner_ended)受信で終了バナーが表示され、以降close→再接続されない", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      act(() => {
        socket.dispatchMessage({ type: "room_ended", reason: "owner_ended" });
      });

      expect(screen.getByText("会話は終了しました")).toBeInTheDocument();
      expect(screen.getByText("理由: オーナーによる終了")).toBeInTheDocument();

      const instancesBeforeClose = MockWebSocket.instances.length;

      // サーバー側切断。room_ended後は自動再接続がスケジュールされないこと。
      act(() => {
        socket.dispatchClose();
      });

      act(() => {
        jest.advanceTimersByTime(10_000);
      });

      expect(MockWebSocket.instances.length).toBe(instancesBeforeClose);
      // バナーは引き続き表示されたまま（エラー表示に置き換わらない）
      expect(screen.getByText("会話は終了しました")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("room_ended(auto_timeout)受信で理由文言が出し分けられる", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="guest" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      act(() => {
        socket.dispatchMessage({ type: "room_ended", reason: "auto_timeout" });
      });

      expect(screen.getByText("会話は終了しました")).toBeInTheDocument();
      expect(screen.getByText("理由: 一定時間の不在による自動終了")).toBeInTheDocument();
    });

    it("roomEnded後はLanguageSelector・TTSToggle・Recorderの開始ボタンがdisabledになる", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      expect(screen.getByRole("combobox", { name: "話す言語" })).not.toBeDisabled();
      expect(screen.getByRole("switch", { name: "読み上げ(TTS)" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "開始" })).not.toBeDisabled();

      act(() => {
        socket.dispatchMessage({ type: "room_ended", reason: "owner_ended" });
      });

      expect(screen.getByRole("combobox", { name: "話す言語" })).toBeDisabled();
      expect(screen.getByRole("switch", { name: "読み上げ(TTS)" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "開始" })).toBeDisabled();
    });

    it("role=ownerでは終了ボタンが表示され、クリックで確認ダイアログ→「終了する」でrequest_endが送信される", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      const endButton = screen.getByRole("button", { name: "ルームを終了する" });
      expect(endButton).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      await user.click(endButton);

      const dialog = screen.getByRole("alertdialog", { name: "ルーム終了の確認" });
      expect(dialog).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "終了する" }));

      const sent = socket.getSentMessages();
      expect(sent.some((m) => m.type === "request_end")).toBe(true);
    });

    it("確認ダイアログで「キャンセル」を押すとrequest_endは送信されずダイアログが閉じる", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      await user.click(screen.getByRole("button", { name: "ルームを終了する" }));
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "キャンセル" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "ルームを終了する" })).toBeInTheDocument();

      const sent = socket.getSentMessages();
      expect(sent.some((m) => m.type === "request_end")).toBe(false);
    });

    it("role=guestでは終了ボタンが表示されない", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="guest" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      expect(screen.queryByRole("button", { name: "ルームを終了する" })).not.toBeInTheDocument();
    });

    it("role=ownerでは招待QRリンクが表示され、招待ページを新規タブで開く（bd-hue）", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      const inviteLink = screen.getByRole("link", {
        name: "招待QRを表示（新しいタブで開く）",
      });
      expect(inviteLink).toHaveAttribute("href", "/rooms/room-abc/invite?from=room");
      expect(inviteLink).toHaveAttribute("target", "_blank");
      // タブナビング防止（セキュリティ属性の回帰ガード、レビュー指摘）
      expect(inviteLink).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("role=guestでは招待QRリンクが表示されない（bd-hue）", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="guest" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      expect(
        screen.queryByRole("link", { name: "招待QRを表示（新しいタブで開く）" })
      ).not.toBeInTheDocument();
    });

    it("room_ended後は招待QRリンクが表示されない（bd-hue）", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });
      expect(
        screen.getByRole("link", { name: "招待QRを表示（新しいタブで開く）" })
      ).toBeInTheDocument();

      act(() => {
        socket.dispatchMessage({ type: "room_ended", reason: "owner_ended" });
      });

      expect(
        screen.queryByRole("link", { name: "招待QRを表示（新しいタブで開く）" })
      ).not.toBeInTheDocument();
    });

    it("録音中に room_ended を受信すると、forceStop の配線経由で Recorder から stop メッセージが送信される", async () => {
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

      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      await user.click(screen.getByRole("button", { name: "開始" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
      });

      act(() => {
        socket.dispatchMessage({ type: "room_ended", reason: "owner_ended" });
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "開始" })).toBeDisabled();

      const sent = socket.getSentMessages();
      expect(sent.some((m) => m.type === "stop")).toBe(true);
    });
  });

  /**
   * bd-fki: SettingsPanel（表示名・言語・言語検出トグル）の結線テスト。
   *
   * - 言語変更 → `update_settings{enableTts, language}` を送信する
   * - 表示名確定（blur） → `update_settings{enableTts, displayName}` を送信する
   * - 検出トグルON → WS送信はせず、次の `start` に `detectLanguage:true` が載る
   * - `participant_updated`（自分宛） → PARTICIPANT_UPDATED dispatch・言語表示を
   *   検出結果に同期・検出トグルを自動OFFに戻す
   * - `participant_updated`（他人宛） → 自分の言語表示・検出トグルは変わらない
   *   （参加者一覧の言語更新のみ、reducer側で検証済み）
   */
  describe("SettingsPanel結線（bd-fki: language/displayName/detectLanguage）", () => {
    interface JoinParticipant {
      participantId: string;
      role: "owner" | "guest";
      language: "ja-JP" | "en-US";
      present: boolean;
    }

    function joinRoom(socket: MockWebSocket, participants: JoinParticipant[] = []) {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants,
        recentMessages: [],
      });
    }

    it("言語を変更するとupdate_settingsメッセージ(enableTts, language)がWS送信される", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" language="ja-JP" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");

      const sent = socket.getSentMessages();
      const updateSettingsMessages = sent.filter((m) => m.type === "update_settings");
      expect(updateSettingsMessages).toHaveLength(1);
      expect(updateSettingsMessages[0]).toMatchObject({
        type: "update_settings",
        enableTts: true,
        language: "en-US",
      });
    });

    it("表示名を編集してblurするとupdate_settingsメッセージ(enableTts, displayName)がWS送信される", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(
        <RoomClient
          roomId="room-abc"
          wsUrl="ws://localhost:3001/ws"
          displayName="たろう"
        />,
      );
      const socket = latestSocket();

      act(() => {
        joinRoom(socket);
      });

      const nameInput = screen.getByLabelText("表示名");
      await user.clear(nameInput);
      await user.type(nameInput, "じろう");
      await user.tab();

      const sent = socket.getSentMessages();
      const updateSettingsMessages = sent.filter((m) => m.type === "update_settings");
      expect(updateSettingsMessages).toHaveLength(1);
      expect(updateSettingsMessages[0]).toMatchObject({
        type: "update_settings",
        enableTts: true,
        displayName: "じろう",
      });
    });

    it("検出トグルをONにしてもWS送信は発生しないが、次のstartメッセージにdetectLanguage:trueが載る", async () => {
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
        joinRoom(socket);
      });

      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));

      // 検出トグルON操作自体はWS送信を伴わない
      expect(socket.getSentMessages().some((m) => m.type === "update_settings")).toBe(false);

      await user.click(screen.getByRole("button", { name: "開始" }));

      await waitFor(() => {
        expect(socket.getSentMessages().some((m) => m.type === "start")).toBe(true);
      });

      const startMessage = socket.getSentMessages().find((m) => m.type === "start");
      expect(startMessage).toMatchObject({ type: "start", detectLanguage: true });
    });

    it("participant_updated（自分宛）を受信すると検出トグルが自動OFFになり、言語表示が同期される", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" language="ja-JP" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket, [
          { participantId: "p1", role: "guest", language: "ja-JP", present: true },
        ]);
      });

      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));
      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).toBeChecked();

      act(() => {
        socket.dispatchMessage({
          type: "participant_updated",
          participantId: "p1",
          language: "en-US",
        });
      });

      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).not.toBeChecked();
      expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("en-US");
    });

    it("participant_updated（他人宛）を受信しても自分の言語表示・検出トグルは変わらない", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" language="ja-JP" />);
      const socket = latestSocket();

      act(() => {
        joinRoom(socket, [
          { participantId: "p1", role: "guest", language: "ja-JP", present: true },
          { participantId: "p2", role: "owner", language: "en-US", present: true },
        ]);
      });

      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));
      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).toBeChecked();

      act(() => {
        socket.dispatchMessage({
          type: "participant_updated",
          participantId: "p2",
          language: "ja-JP",
        });
      });

      // 自分(p1)宛てではないため、検出トグル・言語表示は変わらない
      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).toBeChecked();
      expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("ja-JP");
    });

    /**
     * レビュー対応（must-fix回帰ガード）: 再接続時の join メッセージが
     * join用propsの初期値のまま送られると、SettingsPanelで変更した言語・
     * 表示名が再接続の度に巻き戻ってしまう不具合の回帰防止テスト。
     * `RoomClient.tsx` の join送信は `currentLanguageRef`/`currentDisplayNameRef`
     * （SettingsPanel操作で更新される最新値）を参照する契約になっている。
     */
    it("言語・表示名を変更後、close→自動再接続すると再送されるjoinに最新のlanguage/displayNameが載る", async () => {
      const user = userEvent.setup({
        advanceTimers: (ms) => {
          jest.advanceTimersByTime(ms);
        },
      });
      render(
        <RoomClient
          roomId="room-abc"
          wsUrl="ws://localhost:3001/ws"
          language="ja-JP"
          displayName="たろう"
        />,
      );
      const firstSocket = latestSocket();

      act(() => {
        joinRoom(firstSocket);
      });

      await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");

      const nameInput = screen.getByLabelText("表示名");
      await user.clear(nameInput);
      await user.type(nameInput, "じろう");
      await user.tab();

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
      });

      const sent = secondSocket.getSentMessages();
      const joinMessage = sent.find((m) => m.type === "join");
      expect(joinMessage).toBeDefined();
      // 初期props値（language="ja-JP", displayName="たろう"）ではなく、
      // SettingsPanelで変更した最新値が再接続時のjoinに載ること。
      expect(joinMessage).toMatchObject({
        type: "join",
        language: "en-US",
        displayName: "じろう",
      });
    });
  });

  /**
   * two-device-translator-2re: 再接続の指数バックオフ・上限到達時のfatal化・
   * fatalエラー受信後の再接続抑止・StrictMode二重mount耐性のテスト。
   *
   * `RoomClient.tsx` の定数: MAX_RECONNECT_ATTEMPTS=5,
   * BASE_RECONNECT_DELAY_MS=500, MAX_RECONNECT_DELAY_MS=8000。
   * delay = min(500 * 2^attempt, 8000) （attempt は0始まりの失敗回数）。
   */
  describe("再接続の指数バックオフ・上限・fatal抑止（bd-2re）", () => {
    it("close→再接続の遅延が 500ms→1000ms→2000ms→4000ms→8000ms と指数的に増加し、MAX_RECONNECT_DELAY_MSで頭打ちになる", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
      const socket1 = latestSocket();

      act(() => {
        socket1.dispatchOpen();
      });

      // 1回目: close → 500ms後に再接続（499msでは未接続）
      act(() => {
        socket1.dispatchClose();
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(499);
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      const socket2 = latestSocket();
      expect(socket2).not.toBe(socket1);

      // 2回目: 前回接続が成立しないまま close（＝失敗）→ 1000ms後に再接続
      // （999msでは未接続）。open済みの状態だと open ハンドラが
      // reconnectAttemptsRef を0にリセットしてしまうため、意図的に open せず
      // 「接続確立前の失敗」を再現する。
      act(() => {
        socket2.dispatchClose();
      });
      act(() => {
        jest.advanceTimersByTime(999);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(3);
      const socket3 = latestSocket();

      // 3回目: 2000ms後
      act(() => {
        socket3.dispatchClose();
      });
      act(() => {
        jest.advanceTimersByTime(1999);
      });
      expect(MockWebSocket.instances).toHaveLength(3);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(4);
      const socket4 = latestSocket();

      // 4回目: 4000ms後
      act(() => {
        socket4.dispatchClose();
      });
      act(() => {
        jest.advanceTimersByTime(3999);
      });
      expect(MockWebSocket.instances).toHaveLength(4);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(5);
      const socket5 = latestSocket();

      // 5回目: 本来 500*2^4=8000ms のところ、MAX_RECONNECT_DELAY_MS=8000ms の
      // 頭打ちと一致する（7999msでは未接続・8000msで新インスタンス）。
      act(() => {
        socket5.dispatchClose();
      });
      act(() => {
        jest.advanceTimersByTime(7999);
      });
      expect(MockWebSocket.instances).toHaveLength(5);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(6);
    });

    it("MAX_RECONNECT_ATTEMPTS回（5回）失敗すると以降は再接続されずfatalエラー表示になる", () => {
      render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
      const socket1 = latestSocket();

      act(() => {
        socket1.dispatchOpen();
      });

      // 1〜5回目の失敗（delay: 500,1000,2000,4000,8000ms）。open済みの初回接続
      // (socket1)がclose、以降4回は接続未確立のまま close する。
      const delays = [500, 1000, 2000, 4000, 8000];
      let current = socket1;
      for (const delay of delays) {
        act(() => {
          current.dispatchClose();
        });
        act(() => {
          jest.advanceTimersByTime(delay);
        });
        current = latestSocket();
      }

      // ここまでで6個目のソケット（5回目の再接続で生成されたもの）が存在する
      expect(MockWebSocket.instances).toHaveLength(6);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // 6回目のclose（5回の再接続すべてが失敗）→ 上限到達、fatalエラー表示。
      act(() => {
        current.dispatchClose();
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "サーバーとの接続を確立できませんでした。",
      );

      // 以降タイマーを進めても再接続されない
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(MockWebSocket.instances).toHaveLength(6);
    });

    it("サーバーからfatalなerrorを受信してcloseされた後は再接続されず、エラー文言もサーバー由来のまま維持される", () => {
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

      const instancesBeforeFatal = MockWebSocket.instances.length;

      act(() => {
        socket.dispatchMessage({
          type: "error",
          message: "ルームが見つかりません。",
          fatal: true,
        });
      });

      // message ハンドラが fatal:true を受けて socket.close() を呼ぶため、
      // close イベントも連動して発火する（MockWebSocketの実装）。
      expect(socket.closed).toBe(true);
      expect(screen.getByRole("alert")).toHaveTextContent("ルームが見つかりません。");

      act(() => {
        jest.advanceTimersByTime(60_000);
      });

      // 再接続はスケジュールされない
      expect(MockWebSocket.instances.length).toBe(instancesBeforeFatal);
      // 汎用のfatal文言（上限到達時の文言）で上書きされていないこと
      expect(screen.getByRole("alert")).toHaveTextContent("ルームが見つかりません。");
      expect(screen.queryByText("サーバーとの接続を確立できませんでした。")).not.toBeInTheDocument();
    });
  });

  /**
   * two-device-translator-2re: StrictMode二重mount時のWebSocket接続の
   * 収束性・joinの送信元ソケット・unmount時の全ソケットclose検証。
   * （既存の「StrictModeの二重mountでもaudioQueueが機能し続ける」テストは
   * audioPlaybackQueue側の検証であり、本テストはWebSocket接続側を検証する。）
   */
  describe("StrictMode二重mount時のWebSocket接続耐性（bd-2re）", () => {
    it("二重mountの初回effectで生成されたソケットはcloseされ、2つ目のソケットのみが生きた状態でjoinを送信する", () => {
      render(
        <StrictMode>
          <RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="owner" />
        </StrictMode>,
      );

      // StrictModeのmount→cleanup→mountにより、WebSocketは2つ生成される。
      expect(MockWebSocket.instances).toHaveLength(2);
      const [firstSocket, secondSocket] = MockWebSocket.instances;

      // 1つ目（無効化されたeffect実行由来）は即座にcloseされ、
      // 一度もopenしないまま終わっている（joinも送信されていない）。
      expect(firstSocket.closed).toBe(true);
      expect(firstSocket.sent).toHaveLength(0);

      // 2つ目（有効なeffect実行由来）が生きたソケットとして機能する。
      expect(secondSocket.closed).toBe(false);

      act(() => {
        secondSocket.dispatchOpen();
      });

      const sentOnSecond = secondSocket.getSentMessages();
      expect(sentOnSecond).toHaveLength(1);
      expect(sentOnSecond[0]).toMatchObject({ type: "join", roomId: "room-abc", role: "owner" });

      // 1つ目は無効化されたままjoinを送っていない。
      expect(firstSocket.sent).toHaveLength(0);
    });

    it("unmountするとStrictModeで生成された全てのソケットがcloseされる", () => {
      const { unmount } = render(
        <StrictMode>
          <RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />
        </StrictMode>,
      );

      expect(MockWebSocket.instances).toHaveLength(2);
      const [firstSocket, secondSocket] = MockWebSocket.instances;

      // 1つ目は既にcleanupでcloseされている。2つ目は生きている。
      expect(firstSocket.closed).toBe(true);
      expect(secondSocket.closed).toBe(false);

      act(() => {
        secondSocket.dispatchOpen();
      });

      unmount();

      expect(firstSocket.closed).toBe(true);
      expect(secondSocket.closed).toBe(true);

      // unmount後にタイマーを進めても再接続（新規ソケット生成）は起きない。
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });
});
