/** @jest-environment jsdom */
/**
 * audioPipeline（bd-1or: WebAudioゲイン方式ミュート＋入力レベル測定）の単体テスト。
 *
 * - WebAudio 利用時: source→gain→destination の録音経路と、ゲイン適用前の
 *   AnalyserNode によるレベル測定（RMS）を検証する
 * - WebAudio 不使用時（factory 未指定かつ window.AudioContext なし / factory が
 *   例外）: 元ストリームへのフォールバックと track.enabled 方式のミュートを検証する
 *
 * @see src/components/Recorder/audioPipeline.ts
 */
import { createAudioPipeline } from "@/components/Recorder/audioPipeline";

// ─────────────────────────────────────────────
// AudioContext モック
// ─────────────────────────────────────────────

class MockAudioNode {
  connections: unknown[] = [];
  connect = jest.fn((target: unknown) => {
    this.connections.push(target);
    return target;
  });
  disconnect = jest.fn();
}

class MockGainNode extends MockAudioNode {
  gain = { value: 1 };
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 2048;
  /** テストから注入する時間領域データ（128=無音中心） */
  timeDomainData: Uint8Array | null = null;
  getByteTimeDomainData = jest.fn((buf: Uint8Array) => {
    const data = this.timeDomainData;
    if (data) {
      buf.set(data.subarray(0, buf.length));
    } else {
      buf.fill(128);
    }
  });
}

class MockMediaStreamDestinationNode extends MockAudioNode {
  stream = { id: "destination-stream" } as unknown as MediaStream;
}

class MockAudioContext {
  state: "suspended" | "running" | "closed" = "running";
  source = new MockAudioNode();
  gainNode = new MockGainNode();
  analyser = new MockAnalyserNode();
  destination = new MockMediaStreamDestinationNode();
  resume = jest.fn(async () => {
    this.state = "running";
  });
  close = jest.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = jest.fn(() => this.source);
  createGain = jest.fn(() => this.gainNode);
  createAnalyser = jest.fn(() => this.analyser);
  createMediaStreamDestination = jest.fn(() => this.destination);
}

function makeStream() {
  const track = { stop: jest.fn(), enabled: true };
  return {
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
    track,
  };
}

describe("createAudioPipeline", () => {
  describe("WebAudio パイプライン", () => {
    it("source→gain→destination / source→analyser のグラフを構築し、destination のストリームを録音用として返す", () => {
      const ctx = new MockAudioContext();
      const { stream } = makeStream();
      const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      expect(pipeline.usingWebAudio).toBe(true);
      expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
      // 録音経路: source → gain → destination
      expect(ctx.source.connections).toContain(ctx.gainNode);
      expect(ctx.gainNode.connections).toContain(ctx.destination);
      // レベル測定はゲイン適用前（source → analyser）
      expect(ctx.source.connections).toContain(ctx.analyser);
      expect(ctx.gainNode.connections).not.toContain(ctx.analyser);
      expect(pipeline.recordingStream).toBe(ctx.destination.stream);
    });

    it("setMuted でゲイン値が 0/1 に切り替わる（トラックは無効化しない）", () => {
      const ctx = new MockAudioContext();
      const { stream, track } = makeStream();
      const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      pipeline.setMuted(true);
      expect(ctx.gainNode.gain.value).toBe(0);
      // ゲイン方式ではトラックを無効化しない（無効化はモバイルでチャンク供給が
      // 止まり STT Audio Timeout を招くため。bd-1or の趣旨）
      expect(track.enabled).toBe(true);

      pipeline.setMuted(false);
      expect(ctx.gainNode.gain.value).toBe(1);
    });

    it("getLevel が時間領域データの RMS（0..1）を返す", () => {
      const ctx = new MockAudioContext();
      const { stream } = makeStream();
      const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      // 無音（全サンプル128）→ 0
      ctx.analyser.timeDomainData = new Uint8Array(ctx.analyser.fftSize).fill(128);
      expect(pipeline.getLevel()).toBe(0);

      // フルスケール矩形波（0と255の交互）→ RMS ≈ 1
      const full = new Uint8Array(ctx.analyser.fftSize);
      for (let i = 0; i < full.length; i++) {
        full[i] = i % 2 === 0 ? 0 : 255;
      }
      ctx.analyser.timeDomainData = full;
      const level = pipeline.getLevel();
      expect(level).not.toBeNull();
      expect(level as number).toBeGreaterThan(0.9);
      expect(level as number).toBeLessThanOrEqual(1);
    });

    it("suspended 状態の AudioContext は resume される（モバイルの自動再生制限対策）", () => {
      const ctx = new MockAudioContext();
      ctx.state = "suspended";
      const { stream } = makeStream();
      createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      expect(ctx.resume).toHaveBeenCalled();
    });

    it("resume が reject しても構築は成功し、警告ログを残して setMuted/getLevel は動作する", async () => {
      const ctx = new MockAudioContext();
      ctx.state = "suspended";
      ctx.resume = jest.fn(() => Promise.reject(new Error("autoplay policy")));
      const { stream } = makeStream();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

        // reject の catch（警告ログ）が走るまでマイクロタスクを流す
        await Promise.resolve();
        await Promise.resolve();

        expect(pipeline.usingWebAudio).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("resume() failed"),
          "autoplay policy",
        );

        // 構築は完了しているためミュート・レベル測定は引き続き動作する
        pipeline.setMuted(true);
        expect(ctx.gainNode.gain.value).toBe(0);
        ctx.analyser.timeDomainData = new Uint8Array(ctx.analyser.fftSize).fill(128);
        expect(pipeline.getLevel()).toBe(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("dispose で AudioContext が close される（マイクトラックの停止は行わない=呼び出し側の責務）", () => {
      const ctx = new MockAudioContext();
      const { stream, track } = makeStream();
      const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      pipeline.dispose();
      expect(ctx.close).toHaveBeenCalled();
      // トラック停止は呼び出し側（Recorder の stopInternal）の責務（JSDoc 契約）
      expect(track.stop).not.toHaveBeenCalled();
    });

    it("dispose 後の setMuted / getLevel は例外を投げない", () => {
      const ctx = new MockAudioContext();
      const { stream } = makeStream();
      const pipeline = createAudioPipeline(stream, () => ctx as unknown as AudioContext);

      pipeline.dispose();
      expect(() => pipeline.setMuted(true)).not.toThrow();
      expect(() => pipeline.getLevel()).not.toThrow();
    });
  });

  describe("フォールバック（WebAudio 不使用）", () => {
    it("window.AudioContext がない環境では元ストリームを返し、track.enabled 方式でミュートする", () => {
      // jsdom には AudioContext がない（factory 未指定 → フォールバック）
      const { stream, track } = makeStream();
      const pipeline = createAudioPipeline(stream);

      expect(pipeline.usingWebAudio).toBe(false);
      expect(pipeline.recordingStream).toBe(stream);

      pipeline.setMuted(true);
      expect(track.enabled).toBe(false);
      pipeline.setMuted(false);
      expect(track.enabled).toBe(true);
    });

    it("フォールバック時の getLevel は null を返す（レベル測定不可）", () => {
      const { stream } = makeStream();
      const pipeline = createAudioPipeline(stream);
      expect(pipeline.getLevel()).toBeNull();
    });

    it("factory が例外を投げた場合もフォールバックする（構築失敗でも録音は継続可能）", () => {
      const { stream, track } = makeStream();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const pipeline = createAudioPipeline(stream, () => {
          throw new Error("AudioContext construction failed");
        });

        expect(pipeline.usingWebAudio).toBe(false);
        expect(pipeline.recordingStream).toBe(stream);
        pipeline.setMuted(true);
        expect(track.enabled).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("フォールバック時の dispose は例外を投げない", () => {
      const { stream } = makeStream();
      const pipeline = createAudioPipeline(stream);
      expect(() => pipeline.dispose()).not.toThrow();
    });
  });
});
