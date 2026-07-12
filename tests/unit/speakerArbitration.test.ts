/**
 * 話者調停（SpeakerArbitrator、bd-6h1: 話者交代制）の単体テスト。
 *
 * 音量差を主・STT到着順を従とする2段判定、保持延長、解放
 * （発話確定・無活動タイムアウト・stop・切断）、レベル鮮度、
 * レベル未受信フォールバックを検証する。
 *
 * @see server/room/speakerArbitration.ts
 */
import {
  SpeakerArbitrator,
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_LEVEL_FRESHNESS_MS,
} from "../../server/room/speakerArbitration";

describe("SpeakerArbitrator", () => {
  let changes: Array<string | null>;

  beforeEach(() => {
    // modern fake timers は Date.now もモックするため、
    // タイマー進行とレベル鮮度（now基準）を一貫して制御できる
    jest.useFakeTimers();
    changes = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeArbitrator(
    overrides: Partial<ConstructorParameters<typeof SpeakerArbitrator>[0]> = {},
  ): SpeakerArbitrator {
    return new SpeakerArbitrator({
      onActiveSpeakerChange: (id) => changes.push(id),
      ...overrides,
    });
  }

  describe("話者の確定（onSpeechActivity）", () => {
    it("話者不在でレベル情報がなければ、最初の発話活動で話者に確定する（到着順フォールバック）", () => {
      const arb = makeArbitrator();
      expect(arb.onSpeechActivity("p1")).toBe(true);
      expect(arb.getActiveSpeakerId()).toBe("p1");
      expect(changes).toEqual(["p1"]);
    });

    it("話者確定中、本人の発話活動は採用され続ける", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      expect(arb.onSpeechActivity("p1")).toBe(true);
      expect(arb.onSpeechActivity("p1")).toBe(true);
      // 通知は確定時の1回のみ（重複なし）
      expect(changes).toEqual(["p1"]);
    });

    it("話者確定中、他参加者の発話活動は破棄される", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      expect(arb.onSpeechActivity("p2")).toBe(false);
      expect(arb.getActiveSpeakerId()).toBe("p1");
      expect(changes).toEqual(["p1"]);
    });
  });

  describe("音量差による判定（主判定）", () => {
    it("他参加者のレベルが明確に大きい（優勢比超）場合、話者不在でも拒否される", () => {
      const arb = makeArbitrator();
      arb.onLevel("p1", 0.5);
      arb.onLevel("p2", 0.1);

      // p2 の端末は p1 の声を拾っただけの可能性が高い → 拒否
      expect(arb.onSpeechActivity("p2")).toBe(false);
      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual([]);

      // レベルの大きい p1 本人の活動は採用される
      expect(arb.onSpeechActivity("p1")).toBe(true);
      expect(changes).toEqual(["p1"]);
    });

    it("優勢比ちょうど（other = own × ratio）では拒否しない（超過のみ拒否）", () => {
      const arb = makeArbitrator({ dominanceRatio: 1.5 });
      arb.onLevel("p1", 0.2);
      arb.onLevel("p2", 0.3); // ちょうど 1.5倍
      expect(arb.onSpeechActivity("p1")).toBe(true);
    });

    it("他参加者のレベルが有意水準未満なら拒否しない（ノイズ床での誤判定防止）", () => {
      const arb = makeArbitrator({ minSignificantLevel: 0.05 });
      arb.onLevel("p1", 0.01);
      arb.onLevel("p2", 0.04); // 4倍だが有意水準未満
      expect(arb.onSpeechActivity("p1")).toBe(true);
    });

    it("本人のレベルが未受信なら比較不能として拒否しない（旧クライアントのフォールバック）", () => {
      const arb = makeArbitrator();
      arb.onLevel("p2", 0.9); // 相手だけレベル送信している
      expect(arb.onSpeechActivity("p1")).toBe(true);
    });

    it("鮮度切れのレベルは判定に使わない", () => {
      const arb = makeArbitrator();
      arb.onLevel("p1", 0.1);
      arb.onLevel("p2", 0.9);

      // 鮮度期限を超えて経過 → 両者のレベルが無効化され、到着順で確定する
      jest.advanceTimersByTime(DEFAULT_LEVEL_FRESHNESS_MS + 1);
      expect(arb.onSpeechActivity("p1")).toBe(true);
    });

    it("鮮度ちょうど（経過 = levelFreshnessMs）のレベルはまだ有効（inclusive判定）", () => {
      const arb = makeArbitrator();
      arb.onLevel("p1", 0.1);
      arb.onLevel("p2", 0.9);

      jest.advanceTimersByTime(DEFAULT_LEVEL_FRESHNESS_MS);
      // レベルはまだ有効 → 音量差で p1 は拒否される
      expect(arb.onSpeechActivity("p1")).toBe(false);
    });

    it("有意水準ちょうど（other = minSignificantLevel）は有意として扱われ、拒否判定に使われる", () => {
      const arb = makeArbitrator({ minSignificantLevel: 0.05 });
      arb.onLevel("p1", 0.01);
      arb.onLevel("p2", 0.05); // ちょうど有意水準（未満のみ除外）
      expect(arb.onSpeechActivity("p1")).toBe(false);
    });
  });

  describe("話者の解放", () => {
    it("発話区切りの確定（onUtteranceCommitted）で解放され、次の話者が確定できる", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      arb.onUtteranceCommitted("p1");

      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual(["p1", null]);

      expect(arb.onSpeechActivity("p2")).toBe(true);
      expect(changes).toEqual(["p1", null, "p2"]);
    });

    it("話者でない参加者の onUtteranceCommitted は解放を起こさない", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      arb.onUtteranceCommitted("p2");
      expect(arb.getActiveSpeakerId()).toBe("p1");
      expect(changes).toEqual(["p1"]);
    });

    it("無活動タイムアウトで解放される", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");

      jest.advanceTimersByTime(DEFAULT_HOLD_TIMEOUT_MS - 1);
      expect(arb.getActiveSpeakerId()).toBe("p1");

      jest.advanceTimersByTime(1);
      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual(["p1", null]);
    });

    it("発話活動が続く間はタイムアウトが延長される", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");

      jest.advanceTimersByTime(DEFAULT_HOLD_TIMEOUT_MS - 100);
      arb.onSpeechActivity("p1"); // 保持延長

      jest.advanceTimersByTime(DEFAULT_HOLD_TIMEOUT_MS - 100);
      expect(arb.getActiveSpeakerId()).toBe("p1"); // 元のタイマーでは切れていたはずの時刻

      jest.advanceTimersByTime(100);
      expect(arb.getActiveSpeakerId()).toBeNull();
    });

    it("onStop で話者なら解放される", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      arb.onStop("p1");
      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual(["p1", null]);
    });

    it("話者でない参加者の onStop / onLeave は解放を起こさない", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");

      arb.onStop("p2");
      expect(arb.getActiveSpeakerId()).toBe("p1");

      arb.onLeave("p2");
      expect(arb.getActiveSpeakerId()).toBe("p1");

      expect(changes).toEqual(["p1"]);
    });

    it("二重解放は無害（2回目は no-op で通知が重複しない）", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");

      // stop 由来の確定と stop 本体で解放経路が2回走るケース
      // （server/index.ts の stop ハンドラ参照）
      arb.onUtteranceCommitted("p1");
      arb.onStop("p1");

      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual(["p1", null]); // null 通知は1回のみ
    });

    it("onLeave で話者なら解放され、レベル記録も破棄される", () => {
      const arb = makeArbitrator();
      arb.onLevel("p1", 0.9);
      arb.onSpeechActivity("p1");
      arb.onLeave("p1");

      expect(arb.getActiveSpeakerId()).toBeNull();
      expect(changes).toEqual(["p1", null]);

      // p1 の高レベル記録が破棄されているため、p2 は拒否されず確定できる
      arb.onLevel("p2", 0.1);
      expect(arb.onSpeechActivity("p2")).toBe(true);
    });
  });

  describe("dispose", () => {
    it("dispose 後の onSpeechActivity は調停なしで採用され、通知もタイマー発火もない", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      arb.dispose();

      expect(arb.onSpeechActivity("p2")).toBe(true);
      jest.advanceTimersByTime(DEFAULT_HOLD_TIMEOUT_MS * 2);
      // dispose 前の確定通知（p1）のみで、以後の通知はない
      expect(changes).toEqual(["p1"]);
    });

    it("dispose は冪等で、dispose 後の各メソッド呼び出しも無害（通知なし）", () => {
      const arb = makeArbitrator();
      arb.onSpeechActivity("p1");
      arb.dispose();
      expect(() => arb.dispose()).not.toThrow();

      expect(() => arb.onLevel("p2", 0.5)).not.toThrow();
      expect(() => arb.onUtteranceCommitted("p1")).not.toThrow();
      expect(() => arb.onStop("p1")).not.toThrow();
      expect(() => arb.onLeave("p1")).not.toThrow();

      jest.advanceTimersByTime(DEFAULT_HOLD_TIMEOUT_MS * 2);
      expect(changes).toEqual(["p1"]);
      expect(arb.getActiveSpeakerId()).toBeNull();
    });
  });
});
