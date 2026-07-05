/** @jest-environment jsdom */
/**
 * Recorder コンポーネントの単体テスト。
 *
 * 6fl申し送り事項の回帰テスト: 開始ボタン連打時に getUserMedia が1回しか
 * 呼ばれないこと（`isStartingRef` による同期ガード）を検証する。
 * あわせて 開始→start送信 / 停止→stop送信 の基本フローも検証する。
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Recorder } from "@/components/Recorder/Recorder";
import type { ClientMessage } from "@shared/index";

class MockMediaRecorder {
  static isTypeSupported(): boolean {
    return false;
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: unknown) => void) | null = null;
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
  }
}

describe("Recorder", () => {
  let getUserMediaMock: jest.Mock;
  let resolveGetUserMedia: ((stream: unknown) => void) | null;

  beforeEach(() => {
    resolveGetUserMedia = null;
    getUserMediaMock = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });
    // @ts-expect-error jsdom には MediaRecorder が存在しないためモックで上書きする
    globalThis.MediaRecorder = MockMediaRecorder;
  });

  function makeStream() {
    return { getTracks: () => [{ stop: jest.fn() }] };
  }

  it("開始ボタンを連打してもgetUserMediaは1回しか呼ばれない", async () => {
    const user = userEvent.setup();
    const sendMessage = jest.fn();
    render(<Recorder language="ja-JP" sendMessage={sendMessage} />);

    const startButton = screen.getByRole("button", { name: "開始" });

    // getUserMedia が pending のまま連打する（isStartingRef の同期ガードを検証）
    await user.click(startButton);
    await user.click(startButton);
    await user.click(startButton);

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveGetUserMedia?.(makeStream());
    });

    await waitFor(() => {
      expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("開始するとstartメッセージが送信される", async () => {
    const user = userEvent.setup();
    const sendMessage = jest.fn();
    render(
      <Recorder language="en-US" sendMessage={sendMessage} enableTts={false} />,
    );

    await user.click(screen.getByRole("button", { name: "開始" }));
    await act(async () => {
      resolveGetUserMedia?.(makeStream());
    });

    await waitFor(() => {
      expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
    });

    const startMessages = sendMessage.mock.calls
      .map((call) => call[0] as ClientMessage)
      .filter((m) => m.type === "start");
    expect(startMessages).toHaveLength(1);
    expect(startMessages[0]).toMatchObject({
      type: "start",
      sourceLanguage: "en-US",
      enableTts: false,
      detectLanguage: false,
    });
  });

  it("停止するとstopメッセージが送信される", async () => {
    const user = userEvent.setup();
    const sendMessage = jest.fn();
    render(<Recorder language="ja-JP" sendMessage={sendMessage} />);

    await user.click(screen.getByRole("button", { name: "開始" }));
    await act(async () => {
      resolveGetUserMedia?.(makeStream());
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "停止" }));

    const stopMessages = sendMessage.mock.calls
      .map((call) => call[0] as ClientMessage)
      .filter((m) => m.type === "stop");
    expect(stopMessages).toHaveLength(1);
    expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
  });
});
