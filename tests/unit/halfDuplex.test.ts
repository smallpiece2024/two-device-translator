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

  describe("相手端末の再生状態（peer_playback_state、bd-rwi）", () => {
    it("相手の再生開始で抑止状態になり、停止で猶予後に解除される", () => {
      const gate = createHalfDuplexGate();
      gate.onPeerPlaybackStateChange("peer-1", true);
      expect(gate.shouldSuppressAudio()).toBe(true);

      gate.onPeerPlaybackStateChange("peer-1", false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS - 1);
      expect(gate.shouldSuppressAudio()).toBe(true);
      jest.advanceTimersByTime(1);
      expect(gate.shouldSuppressAudio()).toBe(false);
    });

    it("自分の再生が止まっても相手が再生中なら抑止が継続する（複数ソースのOR）", () => {
      const gate = createHalfDuplexGate();
      gate.onPlaybackStateChange(true);
      gate.onPeerPlaybackStateChange("peer-1", true);

      gate.onPlaybackStateChange(false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS * 2);
      expect(gate.shouldSuppressAudio()).toBe(true);

      gate.onPeerPlaybackStateChange("peer-1", false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS);
      expect(gate.shouldSuppressAudio()).toBe(false);
    });

    it("複数の相手が再生中の場合、全員が停止するまで抑止が継続する", () => {
      const gate = createHalfDuplexGate();
      gate.onPeerPlaybackStateChange("peer-1", true);
      gate.onPeerPlaybackStateChange("peer-2", true);

      gate.onPeerPlaybackStateChange("peer-1", false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS * 2);
      expect(gate.shouldSuppressAudio()).toBe(true);

      gate.onPeerPlaybackStateChange("peer-2", false);
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS);
      expect(gate.shouldSuppressAudio()).toBe(false);
    });

    it("clearPeer で退室者の再生中記録が消え、抑止が解除される（false通知の受信漏れ対策）", () => {
      const gate = createHalfDuplexGate();
      gate.onPeerPlaybackStateChange("peer-1", true);
      expect(gate.shouldSuppressAudio()).toBe(true);

      gate.clearPeer("peer-1");
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS);
      expect(gate.shouldSuppressAudio()).toBe(false);
    });

    it("clearPeers で全記録が消える（自分の再接続時のリセット）", () => {
      const gate = createHalfDuplexGate();
      gate.onPeerPlaybackStateChange("peer-1", true);
      gate.onPeerPlaybackStateChange("peer-2", true);

      gate.clearPeers();
      jest.advanceTimersByTime(TTS_ECHO_GRACE_MS);
      expect(gate.shouldSuppressAudio()).toBe(false);
    });

    it("記録のない参加者の clearPeer は何も起こさない（抑止状態を変えない）", () => {
      const gate = createHalfDuplexGate();
      gate.onPlaybackStateChange(true);

      gate.clearPeer("unknown-peer");
      expect(gate.shouldSuppressAudio()).toBe(true);
    });
  });
});
