/**
 * 半二重ゲート（bd-0ee: 音響フィードバックループ対策）の単体テスト。
 *
 * @see src/app/(public)/room/[roomId]/halfDuplex.ts
 */
import {
  createHalfDuplexGate,
  TTS_ECHO_GRACE_MS,
} from "@/app/(public)/room/[roomId]/halfDuplex";

describe("createHalfDuplexGate", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("初期状態では抑止しない", () => {
    const gate = createHalfDuplexGate();
    expect(gate.shouldSuppressAudio()).toBe(false);
  });

  it("再生開始で抑止状態になる", () => {
    const gate = createHalfDuplexGate();
    gate.onPlaybackStateChange(true);
    expect(gate.shouldSuppressAudio()).toBe(true);
  });

  it("再生停止後、猶予時間が経過するまで抑止を維持し、経過後に解除する", () => {
    const gate = createHalfDuplexGate();
    gate.onPlaybackStateChange(true);
    gate.onPlaybackStateChange(false);

    // 猶予中はまだ抑止
    jest.advanceTimersByTime(TTS_ECHO_GRACE_MS - 1);
    expect(gate.shouldSuppressAudio()).toBe(true);

    // 猶予経過で解除
    jest.advanceTimersByTime(1);
    expect(gate.shouldSuppressAudio()).toBe(false);
  });

  it("猶予中に次の再生が始まった場合、猶予タイマーは取り消され抑止が継続する", () => {
    const gate = createHalfDuplexGate();
    gate.onPlaybackStateChange(true);
    gate.onPlaybackStateChange(false);

    jest.advanceTimersByTime(TTS_ECHO_GRACE_MS - 50);
    gate.onPlaybackStateChange(true); // 猶予中に再生再開

    // 元の猶予タイマーの残り時間が経過しても抑止は継続する
    jest.advanceTimersByTime(1000);
    expect(gate.shouldSuppressAudio()).toBe(true);
  });

  it("dispose で抑止状態とタイマーがリセットされる", () => {
    const gate = createHalfDuplexGate();
    gate.onPlaybackStateChange(true);
    gate.dispose();

    expect(gate.shouldSuppressAudio()).toBe(false);

    // dispose 後にタイマーが残っていても例外なく無害
    jest.advanceTimersByTime(TTS_ECHO_GRACE_MS * 2);
    expect(gate.shouldSuppressAudio()).toBe(false);
  });

  it("猶予時間はカスタマイズできる", () => {
    const gate = createHalfDuplexGate(1000);
    gate.onPlaybackStateChange(true);
    gate.onPlaybackStateChange(false);

    jest.advanceTimersByTime(999);
    expect(gate.shouldSuppressAudio()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(gate.shouldSuppressAudio()).toBe(false);
  });
});
