/** @jest-environment jsdom */
/**
 * RoomClient の参加者イベント連携・TTS設定送信に関する結線テスト（TDD Red）。
 *
 * bd-two-device-translator-124.3 で発見された以下の不具合を再現する:
 *   1. サーバーから `participant_joined` / `participant_left` が届いても
 *      RoomClient がディスパッチしないため、参加者一覧・表示人数が更新されない。
 *   2. TTSトグル変更時にサーバーへ何も送信されない（`update_settings` 未実装）。
 *   3. `join` 送信ペイロードに現在のTTSトグル状態（`enableTts`）が含まれない。
 *
 * `participant_joined` / `participant_left` / `update_settings` は
 * `shared/ws-protocol/schema.ts` に未定義（Phase2/3 で追加予定）のメッセージ
 * 種別のため、`serverMessageSchema`/`ClientMessage` 型を経由せず、
 * 生のJSON文字列でモックWebSocketの `message` イベントを手動発火し、
 * また送信検証も `sent`（生文字列）を直接 `JSON.parse` して行う。
 *
 * `tests/unit/RoomClient.test.tsx` の MockWebSocket パターンを流用している。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RoomClient } from "@/app/(public)/room/[roomId]/RoomClient";
import { createAudioPlaybackQueue } from "@/lib/audioPlaybackQueue";
import type { ServerMessage } from "@shared/index";

jest.mock("@/lib/audioPlaybackQueue", () => ({
  createAudioPlaybackQueue: jest.fn(),
  primeHtmlAudioPlayback: jest.fn(),
}));

const createAudioPlaybackQueueMock = createAudioPlaybackQueue as jest.MockedFunction<
  typeof createAudioPlaybackQueue
>;

function createQueueMock() {
  return {
    enqueue: jest.fn(),
    setEnabled: jest.fn(),
    dispose: jest.fn(),
  };
}

/**
 * jsdom に存在しない WebSocket のテスト用モック。
 * `dispatchRawMessage` で、schema未定義の新メッセージ種別でも生JSON文字列で
 * `message` イベントを発火できるようにしている点が
 * `tests/unit/RoomClient.test.tsx` の既存モックとの違い。
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

  dispatchOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open.forEach((listener) => listener({}));
  }

  /** 既存 serverMessageSchema に定義済みのメッセージ用（型安全） */
  dispatchMessage(message: ServerMessage): void {
    this.listeners.message.forEach((listener) =>
      listener({ data: JSON.stringify(message) }),
    );
  }

  /** schema未定義の新メッセージ種別を生JSONで発火するためのヘルパー */
  dispatchRawMessage(raw: unknown): void {
    this.listeners.message.forEach((listener) =>
      listener({ data: JSON.stringify(raw) }),
    );
  }

  dispatchClose(): void {
    this.listeners.close.forEach((listener) => listener({}));
  }

  /** 送信された生メッセージを type を問わず JSON として取得するテストヘルパー */
  getSentRawMessages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

describe("RoomClient 参加者イベント・TTS設定送信 (TDD Red: bd-124.3)", () => {
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

  /** join直後（参加者1人）の共通セットアップ */
  function setupJoined(): MockWebSocket {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
      socket.dispatchMessage({
        type: "joined",
        participantId: "p1",
        room: { id: "room-abc", status: "active" },
        participants: [{ participantId: "p1", role: "guest", language: "ja-JP", present: true }],
        recentMessages: [],
      });
    });

    return socket;
  }

  it("participant_joined受信で参加者一覧に追加され、参加者表示人数が増える", () => {
    const socket = setupJoined();

    expect(screen.getByText("参加者: 1人")).toBeInTheDocument();

    act(() => {
      socket.dispatchRawMessage({
        type: "participant_joined",
        participant: { participantId: "p2", role: "owner", language: "en-US", present: true },
      });
    });

    expect(screen.getByText("参加者: 2人")).toBeInTheDocument();
  });

  it("participant_left受信で退出した参加者が反映され、表示人数が減る", () => {
    const socket = setupJoined();

    act(() => {
      socket.dispatchRawMessage({
        type: "participant_joined",
        participant: { participantId: "p2", role: "owner", language: "en-US", present: true },
      });
    });
    expect(screen.getByText("参加者: 2人")).toBeInTheDocument();

    act(() => {
      socket.dispatchRawMessage({
        type: "participant_left",
        participantId: "p2",
      });
    });

    // p2 が離脱したので、join直後(p1のみ)と同じ表示人数に戻る
    expect(screen.getByText("参加者: 1人")).toBeInTheDocument();
  });

  it("join送信ペイロードに現在のTTSトグル状態(enableTts: true)が含まれる", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" />);
    const socket = latestSocket();

    act(() => {
      socket.dispatchOpen();
    });

    const sent = socket.getSentRawMessages();
    const joinMessage = sent.find((m) => m.type === "join");
    expect(joinMessage).toBeDefined();
    expect(joinMessage).toMatchObject({ enableTts: true });
  });

  it("TTSトグルをOFFに操作するとupdate_settingsメッセージ(enableTts: false)がWS送信される", async () => {
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    setupJoined();
    const socket = latestSocket();

    const toggle = screen.getByRole("switch", { name: "読み上げ(TTS)" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");

    const sent = socket.getSentRawMessages();
    const updateSettingsMessage = sent.find((m) => m.type === "update_settings");
    expect(updateSettingsMessage).toBeDefined();
    expect(updateSettingsMessage).toMatchObject({ type: "update_settings", enableTts: false });
  });
});
