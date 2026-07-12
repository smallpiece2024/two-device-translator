/** @jest-environment jsdom */
/**
 * Recorder × audioPipeline の結合テスト（bd-1or）。
 *
 * audioPipeline モジュールをモックし、Recorder が
 * - パイプラインの recordingStream を MediaRecorder に渡すこと
 * - muted をパイプラインの setMuted に委譲すること（構築直後の適用を含む）
 * - 録音中に getLevel を定期取得して onAudioLevel へ通知すること
 * - 停止時に interval 解除と dispose を行うこと
 * を検証する。実際の WebAudio 動作（ゲイン・RMS）は audioPipeline.test.ts が担う。
 * jsdom フォールバック経路（track.enabled 方式）は Recorder.test.tsx の
 * muted テストが引き続きカバーする。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  AUDIO_LEVEL_INTERVAL_MS,
  Recorder,
} from "@/components/Recorder/Recorder";
import { createAudioPipeline, type AudioPipeline } from "@/components/Recorder/audioPipeline";

jest.mock("@/components/Recorder/audioPipeline", () => ({
  createAudioPipeline: jest.fn(),
}));

const createAudioPipelineMock = createAudioPipeline as jest.MockedFunction<
  typeof createAudioPipeline
>;

class MockMediaRecorder {
  static isTypeSupported(): boolean {
    return false;
  }
  static lastConstructedStream: unknown = null;
  /** 構築失敗経路（資源解放）のテスト用フラグ */
  static throwOnConstruct = false;
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: unknown) => void) | null = null;
  constructor(stream: unknown) {
    if (MockMediaRecorder.throwOnConstruct) {
      throw new Error("MediaRecorder construction failed");
    }
    MockMediaRecorder.lastConstructedStream = stream;
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
  }
}

function makeStream() {
  const track = { stop: jest.fn(), enabled: true };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    track, // テストから stop 呼び出しを検証するための参照
  };
}

function makePipelineMock(overrides: Partial<AudioPipeline> = {}): AudioPipeline {
  return {
    recordingStream: { id: "pipeline-stream" } as unknown as MediaStream,
    usingWebAudio: true,
    setMuted: jest.fn(),
    getLevel: jest.fn(() => 0.42),
    dispose: jest.fn(),
    ...overrides,
  };
}

describe("Recorder × audioPipeline（bd-1or）", () => {
  let resolveGetUserMedia: ((stream: unknown) => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    resolveGetUserMedia = null;
    const getUserMediaMock = jest.fn().mockImplementation(
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
    MockMediaRecorder.lastConstructedStream = null;
    MockMediaRecorder.throwOnConstruct = false;
    createAudioPipelineMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** 開始ボタン押下 → getUserMedia 解決 → 録音中、まで進める共通処理 */
  async function startRecording(pipeline: AudioPipeline, ui: React.ReactElement) {
    createAudioPipelineMock.mockReturnValue(pipeline);
    const view = render(ui);

    fireEvent.click(screen.getByRole("button", { name: "開始" }));
    await act(async () => {
      resolveGetUserMedia?.(makeStream());
    });
    expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
    return view;
  }

  it("パイプラインの recordingStream が MediaRecorder に渡される", async () => {
    const pipeline = makePipelineMock();
    await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} />,
    );

    expect(createAudioPipelineMock).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.lastConstructedStream).toBe(pipeline.recordingStream);
  });

  it("構築直後に現在の muted 状態が適用され、以後の muted 切替も setMuted へ委譲される", async () => {
    const pipeline = makePipelineMock();
    const { rerender } = await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} muted={true} />,
    );

    // 構築直後の適用（TTS再生中に録音開始したケース）
    expect(pipeline.setMuted).toHaveBeenCalledWith(true);

    rerender(<Recorder language="ja-JP" sendMessage={jest.fn()} muted={false} />);
    expect(pipeline.setMuted).toHaveBeenLastCalledWith(false);

    rerender(<Recorder language="ja-JP" sendMessage={jest.fn()} muted={true} />);
    expect(pipeline.setMuted).toHaveBeenLastCalledWith(true);
  });

  it("録音中、AUDIO_LEVEL_INTERVAL_MS 間隔で onAudioLevel にレベルが通知される", async () => {
    const pipeline = makePipelineMock({ getLevel: jest.fn(() => 0.7) });
    const onAudioLevel = jest.fn();
    await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} onAudioLevel={onAudioLevel} />,
    );

    expect(onAudioLevel).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(AUDIO_LEVEL_INTERVAL_MS);
    });
    expect(onAudioLevel).toHaveBeenCalledTimes(1);
    expect(onAudioLevel).toHaveBeenCalledWith(0.7);

    act(() => {
      jest.advanceTimersByTime(AUDIO_LEVEL_INTERVAL_MS * 3);
    });
    expect(onAudioLevel).toHaveBeenCalledTimes(4);
  });

  it("getLevel が null（WebAudio不可）の場合は onAudioLevel を呼ばない", async () => {
    const pipeline = makePipelineMock({ getLevel: jest.fn(() => null) });
    const onAudioLevel = jest.fn();
    await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} onAudioLevel={onAudioLevel} />,
    );

    act(() => {
      jest.advanceTimersByTime(AUDIO_LEVEL_INTERVAL_MS * 5);
    });
    expect(onAudioLevel).not.toHaveBeenCalled();
  });

  it("停止でレベル通知が止まり、パイプラインが dispose される", async () => {
    const pipeline = makePipelineMock();
    const onAudioLevel = jest.fn();
    await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} onAudioLevel={onAudioLevel} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(AUDIO_LEVEL_INTERVAL_MS * 5);
    });
    expect(onAudioLevel).not.toHaveBeenCalled();
  });

  it("getUserMedia 完了待ち中の muted 変更が、パイプライン構築直後に反映される（mutedRef の回帰テスト）", async () => {
    const pipeline = makePipelineMock();
    createAudioPipelineMock.mockReturnValue(pipeline);
    const { rerender } = render(
      <Recorder language="ja-JP" sendMessage={jest.fn()} muted={false} />,
    );

    // 開始クリック → getUserMedia は pending のまま
    fireEvent.click(screen.getByRole("button", { name: "開始" }));
    expect(screen.getByText("状態: 開始中...")).toBeInTheDocument();

    // 許可待ちの間に muted=true へ変化（TTS再生開始など）
    rerender(<Recorder language="ja-JP" sendMessage={jest.fn()} muted={true} />);

    // その後 getUserMedia が解決 → 構築直後の適用は現在値（true）であること
    await act(async () => {
      resolveGetUserMedia?.(makeStream());
    });
    expect(screen.getByText("状態: 録音中")).toBeInTheDocument();
    expect(pipeline.setMuted).toHaveBeenCalled();
    expect((pipeline.setMuted as jest.Mock).mock.calls[0][0]).toBe(true);
  });

  it("getUserMedia 解決前にアンマウントされた場合、パイプラインを構築せずトラックを停止する", async () => {
    const pipeline = makePipelineMock();
    createAudioPipelineMock.mockReturnValue(pipeline);
    const { unmount } = render(<Recorder language="ja-JP" sendMessage={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "開始" }));
    unmount();

    const stream = makeStream();
    await act(async () => {
      resolveGetUserMedia?.(stream);
    });

    expect(createAudioPipelineMock).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalled();
  });

  it("MediaRecorder の構築が失敗した場合、パイプラインとトラックを解放してエラー状態になる", async () => {
    MockMediaRecorder.throwOnConstruct = true;
    const pipeline = makePipelineMock();
    createAudioPipelineMock.mockReturnValue(pipeline);
    render(<Recorder language="ja-JP" sendMessage={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "開始" }));
    const stream = makeStream();
    await act(async () => {
      resolveGetUserMedia?.(stream);
    });

    expect(pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(screen.getByText("状態: エラー")).toBeInTheDocument();
    // エラー状態からは再度「開始」を試せる
    expect(screen.getByRole("button", { name: "開始" })).toBeInTheDocument();
  });

  it("アンマウントでもレベル通知が止まり、パイプラインが dispose される", async () => {
    const pipeline = makePipelineMock();
    const onAudioLevel = jest.fn();
    const { unmount } = await startRecording(
      pipeline,
      <Recorder language="ja-JP" sendMessage={jest.fn()} onAudioLevel={onAudioLevel} />,
    );

    unmount();
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(AUDIO_LEVEL_INTERVAL_MS * 5);
    });
    expect(onAudioLevel).not.toHaveBeenCalled();
  });
});
