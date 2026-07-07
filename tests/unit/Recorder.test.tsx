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
    const track = { stop: jest.fn(), enabled: true };
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      track, // テストから enabled を検証するための参照
    };
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

  /**
   * two-device-translator-4xi: room_ended 受信時、RoomClient が forceStop=true
   * を渡すことで録音中セッションを即座に強制停止する
   * （docs/design/frontend-design.md room_ended ハンドリング節）。
   */
  describe("forceStop（ルーム終了時の強制停止、two-device-translator-4xi）", () => {
    it("録音中に forceStop=true になると stopメッセージが送信され停止状態に戻る", async () => {
      const user = userEvent.setup();
      const sendMessage = jest.fn();
      const { rerender } = render(
        <Recorder language="ja-JP" sendMessage={sendMessage} forceStop={false} />,
      );

      await user.click(screen.getByRole("button", { name: "開始" }));
      await act(async () => {
        resolveGetUserMedia?.(makeStream());
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
      });
      sendMessage.mockClear();

      rerender(<Recorder language="ja-JP" sendMessage={sendMessage} forceStop={true} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
      });

      const stopMessages = sendMessage.mock.calls
        .map((call) => call[0] as ClientMessage)
        .filter((m) => m.type === "stop");
      expect(stopMessages).toHaveLength(1);
    });

    /**
     * forceStopレース修正（依存配列への status 追加）の回帰テスト。
     *
     * シナリオ: 「開始」クリック直後（getUserMedia許可待ち、status="starting"）に
     * forceStop=true へ切り替わり、その後 getUserMedia が解決して
     * status="recording" に遷移した場合でも、強制停止が効いて stop メッセージが
     * 送信され「開始」ボタン（停止状態）に戻ることを検証する。
     *
     * `useEffect(() => { if (forceStop && status === "recording") handleStop(); },
     * [forceStop, status, handleStop])` の依存配列から `status` を外す退行が
     * 起きると、forceStop=true になった時点（status="starting"）では
     * `handleStop` が no-op で終わり、その後 getUserMedia が解決して
     * status="recording" に遷移しても forceStop 自体は変化していないため
     * effect が再実行されず、stop が送信されないまま録音が継続してしまう
     * （このテストはその退行で失敗する構造になっている）。
     */
    it("開始直後（getUserMedia許可待ち）にforceStop=trueへ切り替わり、その後recording状態に遷移しても強制停止される", async () => {
      const user = userEvent.setup();
      const sendMessage = jest.fn();
      const { rerender } = render(
        <Recorder language="ja-JP" sendMessage={sendMessage} forceStop={false} />,
      );

      // 「開始」クリック → getUserMedia は pending のまま（status="starting"）
      await user.click(screen.getByRole("button", { name: "開始" }));
      await waitFor(() => {
        expect(screen.getByText("状態: 開始中...")).toBeInTheDocument();
      });

      // まだ録音開始前（starting）の時点で forceStop=true に切り替わる
      rerender(<Recorder language="ja-JP" sendMessage={sendMessage} forceStop={true} />);

      // その後 getUserMedia が解決し、status が "recording" に遷移する
      await act(async () => {
        resolveGetUserMedia?.(makeStream());
      });

      // 強制停止が効いて「開始」ボタン（停止状態）に戻り、stopメッセージが送信される
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
      });

      const stopMessages = sendMessage.mock.calls
        .map((call) => call[0] as ClientMessage)
        .filter((m) => m.type === "stop");
      expect(stopMessages).toHaveLength(1);
    });

    it("録音していない状態で forceStop=true になっても stopメッセージは送信されない", async () => {
      const sendMessage = jest.fn();
      const { rerender } = render(
        <Recorder language="ja-JP" sendMessage={sendMessage} forceStop={false} />,
      );

      rerender(<Recorder language="ja-JP" sendMessage={sendMessage} forceStop={true} />);

      const stopMessages = sendMessage.mock.calls
        .map((call) => call[0] as ClientMessage)
        .filter((m) => m.type === "stop");
      expect(stopMessages).toHaveLength(0);
      expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
    });
  });

  describe("muted（半二重のマイクトラック一時ミュート、bd-dnh）", () => {
    it("muted切替でマイクトラックのenabledがトグルされる（録音・送信は継続）", async () => {
      const user = userEvent.setup();
      const sendMessage = jest.fn();
      const { rerender } = render(
        <Recorder language="ja-JP" sendMessage={sendMessage} muted={false} />,
      );

      await user.click(screen.getByRole("button", { name: "開始" }));
      const stream = makeStream();
      await act(async () => {
        resolveGetUserMedia?.(stream);
      });
      await waitFor(() => {
        expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
      });
      expect(stream.track.enabled).toBe(true);

      rerender(<Recorder language="ja-JP" sendMessage={sendMessage} muted={true} />);
      expect(stream.track.enabled).toBe(false);
      // ミュート中も録音状態は継続する（停止しない）
      expect(screen.getByText("状態: 録音中")).toBeInTheDocument();

      rerender(<Recorder language="ja-JP" sendMessage={sendMessage} muted={false} />);
      expect(stream.track.enabled).toBe(true);
    });

    it("muted=trueの間に録音を開始した場合、最初からトラックが無効で開始される", async () => {
      const user = userEvent.setup();
      const sendMessage = jest.fn();
      render(<Recorder language="ja-JP" sendMessage={sendMessage} muted={true} />);

      await user.click(screen.getByRole("button", { name: "開始" }));
      const stream = makeStream();
      await act(async () => {
        resolveGetUserMedia?.(stream);
      });
      await waitFor(() => {
        expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
      });

      expect(stream.track.enabled).toBe(false);
    });
  });
});
