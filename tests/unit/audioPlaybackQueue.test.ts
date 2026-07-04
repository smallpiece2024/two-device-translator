import {
  createAudioPlaybackQueue,
  type AudioPlayer,
  type AudioPlayerFactory,
} from "@/lib/audioPlaybackQueue";

/**
 * テスト用モック AudioPlayer。
 * play() は即座に完了せず、finish() を明示的に呼ぶまで再生中とみなす。
 * これにより「再生中に enqueue しても割り込まない」ことを検証できる。
 */
function createMockPlayerFactory(playedOrder: string[]): {
  factory: AudioPlayerFactory;
  finish: (index: number) => void;
  fail: (index: number) => void;
  playCallCount: () => number;
  stopCallCount: () => number;
} {
  const players: {
    endedCallback: (() => void) | null;
    errorCallback: ((error: unknown) => void) | null;
    playCalled: boolean;
    stopCalled: boolean;
  }[] = [];

  const factory: AudioPlayerFactory = (base64Mp3: string): AudioPlayer => {
    const state = { endedCallback: null, errorCallback: null, playCalled: false, stopCalled: false } as {
      endedCallback: (() => void) | null;
      errorCallback: ((error: unknown) => void) | null;
      playCalled: boolean;
      stopCalled: boolean;
    };
    players.push(state);

    return {
      play(): void {
        state.playCalled = true;
        playedOrder.push(base64Mp3);
      },
      stop(): void {
        state.stopCalled = true;
      },
      onEnded(callback: () => void): void {
        state.endedCallback = callback;
      },
      onError(callback: (error: unknown) => void): void {
        state.errorCallback = callback;
      },
    };
  };

  return {
    factory,
    finish: (index: number) => {
      players[index]?.endedCallback?.();
    },
    fail: (index: number) => {
      players[index]?.errorCallback?.(new Error("mock error"));
    },
    playCallCount: () => players.filter((p) => p.playCalled).length,
    stopCallCount: () => players.filter((p) => p.stopCalled).length,
  };
}

describe("audioPlaybackQueue", () => {
  it("2件連続でenqueueすると1件目→2件目の順に再生される", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.enqueue("audio-1");
    queue.enqueue("audio-2");

    // 1件目のみ再生開始されており、2件目はまだ再生されていない
    expect(playedOrder).toEqual(["audio-1"]);

    // 1件目の再生完了 → 2件目が再生開始される
    mock.finish(0);

    expect(playedOrder).toEqual(["audio-1", "audio-2"]);
  });

  it("再生中のenqueueは割り込まず、現在の再生完了後に開始される", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.enqueue("audio-1");
    expect(mock.playCallCount()).toBe(1);

    // 再生中に追加
    queue.enqueue("audio-2");
    queue.enqueue("audio-3");

    // まだ1件目のみが再生されている（割り込みなし）
    expect(mock.playCallCount()).toBe(1);
    expect(playedOrder).toEqual(["audio-1"]);

    mock.finish(0);
    expect(playedOrder).toEqual(["audio-1", "audio-2"]);
    expect(mock.playCallCount()).toBe(2);

    mock.finish(1);
    expect(playedOrder).toEqual(["audio-1", "audio-2", "audio-3"]);
    expect(mock.playCallCount()).toBe(3);
  });

  it("再生エラー時も次のキューへ進む", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.enqueue("audio-1");
    queue.enqueue("audio-2");

    mock.fail(0);

    expect(playedOrder).toEqual(["audio-1", "audio-2"]);
  });

  it("setEnabled(false)の間はenqueueが無視され再生されない", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.setEnabled(false);
    queue.enqueue("audio-1");
    queue.enqueue("audio-2");

    expect(playedOrder).toEqual([]);
    expect(mock.playCallCount()).toBe(0);
  });

  it("setEnabled(false)にすると再生中のものは最後まで再生され、未再生分は破棄される", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.enqueue("audio-1");
    queue.enqueue("audio-2"); // キュー待ち

    queue.setEnabled(false); // 未再生の audio-2 を破棄

    mock.finish(0); // audio-1 の再生完了

    // audio-2 は破棄されているため再生されない
    expect(playedOrder).toEqual(["audio-1"]);
    expect(mock.playCallCount()).toBe(1);

    // OFF中の追加も無視される
    queue.enqueue("audio-3");
    expect(playedOrder).toEqual(["audio-1"]);

    // 再度ONにすれば以降のenqueueは受け付けられる
    queue.setEnabled(true);
    queue.enqueue("audio-4");
    expect(playedOrder).toEqual(["audio-1", "audio-4"]);
  });

  it("dispose()後はenqueueしても何も再生されず、再生中のものは停止する", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    queue.enqueue("audio-1");
    expect(mock.playCallCount()).toBe(1);

    queue.dispose();
    expect(mock.stopCallCount()).toBe(1);

    queue.enqueue("audio-2");
    expect(playedOrder).toEqual(["audio-1"]);
    expect(mock.playCallCount()).toBe(1);

    // dispose後の再度のdispose呼び出しも安全（例外を投げない）
    expect(() => queue.dispose()).not.toThrow();

    // dispose後のenqueue/setEnabledも安全（例外を投げない）
    expect(() => queue.setEnabled(true)).not.toThrow();
    expect(() => queue.enqueue("audio-3")).not.toThrow();
  });

  it("dispose()は再生中でない場合も安全に呼べる", () => {
    const playedOrder: string[] = [];
    const mock = createMockPlayerFactory(playedOrder);
    const queue = createAudioPlaybackQueue(mock.factory);

    expect(() => queue.dispose()).not.toThrow();
    expect(mock.stopCallCount()).toBe(0);
  });
});
