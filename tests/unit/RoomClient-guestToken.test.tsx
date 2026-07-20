/** @jest-environment jsdom */
/**
 * RoomClient の `guestToken` prop（`gtt_guest` クッキー連携）に関する単体テスト。
 *
 * `guestToken` があれば `join` メッセージの `token` にそのまま使用し、
 * 無ければ Phase1 互換の仮トークン（UUID形式）にフォールバックすることを
 * 検証する。jsdom には WebSocket が存在しないため、既存の
 * `tests/unit/RoomClient.test.tsx` と同様のモッククラスに差し替える
 * （既存ファイルは変更せず、本ファイル内に再定義する）。
 */
import { act, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RoomClient } from "@/app/(public)/room/[roomId]/RoomClient";
import { createAudioPlaybackQueue } from "@/lib/audioPlaybackQueue";
import type { ClientMessage } from "@shared/index";

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
    this.listeners.close.forEach((listener) => listener({}));
  }

  dispatchOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open.forEach((listener) => listener({}));
  }

  getSentMessages(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage);
  }
}

describe("RoomClient (guestToken)", () => {
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

  it("guestToken指定時はjoinメッセージのtokenにguestTokenがそのまま使われる", () => {
    render(
      <RoomClient
        roomId="room-abc"
        wsUrl="ws://localhost:3001/ws"
        role="guest"
        guestToken="guest-jwt-token-value"
      />,
    );

    const socket = latestSocket();
    act(() => {
      socket.dispatchOpen();
    });

    const sent = socket.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "join",
      roomId: "room-abc",
      token: "guest-jwt-token-value",
    });
  });

  it("guestToken未指定時は仮トークン（UUID形式）がjoinメッセージのtokenに使われる", () => {
    render(<RoomClient roomId="room-abc" wsUrl="ws://localhost:3001/ws" role="guest" />);

    const socket = latestSocket();
    act(() => {
      socket.dispatchOpen();
    });

    const sent = socket.getSentMessages();
    expect(sent).toHaveLength(1);
    const message = sent[0] as ClientMessage & { token: string };
    expect(message.token).not.toBe("guest-jwt-token-value");
    expect(typeof message.token).toBe("string");
    expect(message.token.length).toBeGreaterThan(0);
    // Phase1仮トークンはcrypto.randomUUID()形式（jsdom+Node環境ではcryptoが利用可能）
    expect(message.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
