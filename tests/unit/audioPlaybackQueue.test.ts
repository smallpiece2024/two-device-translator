import {
  createAudioPlaybackQueue,
  createHtmlAudioPlayer,
  primeHtmlAudioPlayback,
  resetHtmlAudioPlaybackForTest,
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

  describe("再生状態変化通知（onPlaybackStateChange、bd-0ee）", () => {
    it("再生開始でtrue、キューが空になって停止するとfalseが通知される", () => {
      const playedOrder: string[] = [];
      const mock = createMockPlayerFactory(playedOrder);
      const states: boolean[] = [];
      const queue = createAudioPlaybackQueue(mock.factory, (playing) => states.push(playing));

      queue.enqueue("audio-1");
      expect(states).toEqual([true]);

      mock.finish(0);
      expect(states).toEqual([true, false]);
    });

    it("連続再生中（キューに次がある間）はfalseが通知されない（true/falseは各1回のみ）", () => {
      const playedOrder: string[] = [];
      const mock = createMockPlayerFactory(playedOrder);
      const states: boolean[] = [];
      const queue = createAudioPlaybackQueue(mock.factory, (playing) => states.push(playing));

      queue.enqueue("audio-1");
      queue.enqueue("audio-2");
      expect(states).toEqual([true]);

      mock.finish(0); // 次のaudio-2再生へ（再生中は継続）
      expect(states).toEqual([true]);

      mock.finish(1); // キューが空に
      expect(states).toEqual([true, false]);
    });

    it("再生中にdispose()するとfalseが通知される", () => {
      const playedOrder: string[] = [];
      const mock = createMockPlayerFactory(playedOrder);
      const states: boolean[] = [];
      const queue = createAudioPlaybackQueue(mock.factory, (playing) => states.push(playing));

      queue.enqueue("audio-1");
      queue.dispose();

      expect(states).toEqual([true, false]);
    });

    it("再生エラーでキューが空になった場合もfalseが通知される", () => {
      const playedOrder: string[] = [];
      const mock = createMockPlayerFactory(playedOrder);
      const states: boolean[] = [];
      const queue = createAudioPlaybackQueue(mock.factory, (playing) => states.push(playing));

      queue.enqueue("audio-1");
      mock.fail(0);

      expect(states).toEqual([true, false]);
    });
  });
});

/**
 * テスト用フェイク Audio 要素。play() の成否を制御できる。
 * jsdom の HTMLMediaElement.play は未実装のため、注入で差し替える。
 */
function createFakeAudioElement(playBehavior: "resolve" | "reject") {
  const element = {
    src: "",
    playCalls: 0,
    pauseCalls: 0,
    play(): Promise<void> {
      element.playCalls += 1;
      return playBehavior === "resolve"
        ? Promise.resolve()
        : Promise.reject(new Error("NotAllowedError (autoplay blocked)"));
    },
    pause(): void {
      element.pauseCalls += 1;
    },
  };
  return element;
}

describe("primeHtmlAudioPlayback（自動再生制限のアンロック、bd-8bd）", () => {
  beforeEach(() => {
    resetHtmlAudioPlaybackForTest();
  });

  afterAll(() => {
    resetHtmlAudioPlaybackForTest();
  });

  it("初回呼び出しで無音データをplayし、成功したらpauseしてアンロック済みになる", async () => {
    const element = createFakeAudioElement("resolve");
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);

    await Promise.resolve(); // play() の then を消化

    expect(element.playCalls).toBe(1);
    expect(element.pauseCalls).toBe(1);
    expect(element.src.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("アンロック成功後の再呼び出しはno-op（playが再実行されない）", async () => {
    const element = createFakeAudioElement("resolve");
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();

    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();

    expect(element.playCalls).toBe(1);
  });

  it("play()が拒否された場合はアンロック済みにならず、次の呼び出しで再試行する", async () => {
    const element = createFakeAudioElement("reject");
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();
    await Promise.resolve(); // reject の catch を消化

    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();
    await Promise.resolve();

    // 2回とも play が試行される（1回目の失敗で primed 扱いにしない）
    expect(element.playCalls).toBe(2);
    // 同じ共有要素が使い回される（ファクトリは初回のみ呼ばれるため
    // playCalls が同一要素上で加算されていることが証左）
  });

  it("アンロック後、createHtmlAudioPlayerが共有要素を使い回す（srcをmp3へ差し替えてplay）", async () => {
    const element = createFakeAudioElement("resolve");
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();
    expect(element.playCalls).toBe(1);

    const player = createHtmlAudioPlayer("dGVzdA==");
    expect(element.src).toBe("data:audio/mpeg;base64,dGVzdA==");

    player.play();
    await Promise.resolve();
    expect(element.playCalls).toBe(2);
  });

  it("共有要素で実再生中はprimeがスキップされる（src書き換え・pauseで再生を中断しない）", async () => {
    // 未アンロック（play拒否）の状態を作る
    const element = createFakeAudioElement("reject");
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    await Promise.resolve();
    await Promise.resolve();
    expect(element.playCalls).toBe(1);

    // 実再生を開始（共有要素が使用中になる）
    const player = createHtmlAudioPlayer("dGVzdA==");
    player.play();
    expect(element.playCalls).toBe(2);
    const srcDuringPlayback = element.src;

    // 再生中の prime は no-op（src を無音WAVに書き換えない・play しない）
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    expect(element.playCalls).toBe(2);
    expect(element.src).toBe(srcDuringPlayback);

    // 再生完了（onended）で使用中が解除され、次の prime は再試行される
    (element as unknown as { onended: () => void }).onended();
    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    expect(element.playCalls).toBe(3);
  });

  it("primeのplay解決前に実再生がsrcを差し替えていた場合、pauseしない（TTSを止めない）", async () => {
    // play() の解決タイミングを手動制御できるフェイク
    let resolvePlay: (() => void) | null = null;
    const element = {
      src: "",
      playCalls: 0,
      pauseCalls: 0,
      onended: null as (() => void) | null,
      onerror: null as ((e: unknown) => void) | null,
      play(): Promise<void> {
        element.playCalls += 1;
        return new Promise<void>((resolve) => {
          resolvePlay = resolve;
        });
      },
      pause(): void {
        element.pauseCalls += 1;
      },
    };

    primeHtmlAudioPlayback(() => element as unknown as HTMLAudioElement);
    expect(element.playCalls).toBe(1);

    // prime の play が解決する前に、実再生が src を差し替えた状況を再現
    element.src = "data:audio/mpeg;base64,dGVzdA==";
    resolvePlay?.();
    await Promise.resolve();

    // src が無音WAVでないため pause は呼ばれない（TTS再生を中断しない）
    expect(element.pauseCalls).toBe(0);
  });
});
