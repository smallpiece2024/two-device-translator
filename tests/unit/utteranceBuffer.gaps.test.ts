import {
  UtteranceBufferManager,
  UtteranceCommitReason,
  DEFAULT_UTTERANCE_BUFFER_CONFIG,
} from "../../server/utterance/utteranceBuffer";

/**
 * UtteranceBufferManager の追加テスト（既存 utteranceBuffer.test.ts の補強）。
 *
 * 独立レビューにより特定した未カバーの境界値・二重確定・
 * 確定後のタイマー再起動シナリオを対象とする。
 */
describe("UtteranceBufferManager（補強テスト）", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createManager = (
    overrides: Partial<typeof DEFAULT_UTTERANCE_BUFFER_CONFIG> = {},
  ) => {
    const onCommit = jest.fn<void, [string, UtteranceCommitReason]>();
    const manager = new UtteranceBufferManager(
      { ...DEFAULT_UTTERANCE_BUFFER_CONFIG, ...overrides },
      onCommit,
    );
    return { manager, onCommit };
  };

  describe("デフォルト設定値", () => {
    it("DEFAULT_UTTERANCE_BUFFER_CONFIG が仕様どおりの値を持つ（無音1000ms/80文字/10000ms）", () => {
      expect(DEFAULT_UTTERANCE_BUFFER_CONFIG).toEqual({
        silenceMs: 1000,
        maxChars: 80,
        maxDurationMs: 10_000,
      });
    });
  });

  describe("maxChars 境界値", () => {
    it("累積文字数が maxChars 未満(79文字)では確定しない", () => {
      const { manager, onCommit } = createManager({ maxChars: 80, silenceMs: 100_000 });

      manager.addFinal("a".repeat(79));

      expect(onCommit).not.toHaveBeenCalled();
      expect(manager.getText().length).toBe(79);
    });

    it("累積文字数がちょうど maxChars(80文字)で maxChars 確定する", () => {
      const { manager, onCommit } = createManager({ maxChars: 80, silenceMs: 100_000 });

      manager.addFinal("a".repeat(79));
      manager.addFinal("a"); // 80文字目

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("a".repeat(80), "maxChars");
    });

    it("1回の addFinal で maxChars を超過(81文字)しても、蓄積済み全文で maxChars 確定する", () => {
      const { manager, onCommit } = createManager({ maxChars: 80, silenceMs: 100_000 });

      manager.addFinal("a".repeat(81));

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("a".repeat(81), "maxChars");
    });
  });

  describe("確定後のタイマー再起動", () => {
    it("commit 確定後、次の addFinal で最大発話タイマーが新規発話の追加時点から再起動する（前回の起点を引き継がない）", () => {
      const { manager, onCommit } = createManager({
        silenceMs: 100_000, // 無音確定が先に発火しないよう十分大きくする
        maxDurationMs: 10_000,
      });

      // 1発話目: 6000ms 蓄積後、無音で確定
      manager.addFinal("あ");
      jest.advanceTimersByTime(6_000);
      manager.commit();
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenNthCalledWith(1, "あ", "commit");

      // 2発話目: もし maxDuration の起点が引き継がれていれば
      // 4000ms 経過時点で maxSeconds 確定してしまうはずだが、
      // 新規カウントであれば 9999ms ではまだ確定しないはず
      manager.addFinal("い");
      jest.advanceTimersByTime(9_999);
      expect(onCommit).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      expect(onCommit).toHaveBeenCalledTimes(2);
      expect(onCommit).toHaveBeenNthCalledWith(2, "い", "maxSeconds");
    });

    it("maxChars 確定直後に積んだ次の発話は、独立した無音タイマーで確定する", () => {
      const { manager, onCommit } = createManager({ maxChars: 3, silenceMs: 1000 });

      manager.addFinal("abc");
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenNthCalledWith(1, "abc", "maxChars");

      manager.addFinal("xy");
      jest.advanceTimersByTime(999);
      expect(onCommit).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      expect(onCommit).toHaveBeenCalledTimes(2);
      expect(onCommit).toHaveBeenNthCalledWith(2, "xy", "silence");
    });
  });

  describe("二重確定の防止", () => {
    it("commit() を連続で2回呼んでもコールバックは1回しか呼ばれない", () => {
      const { manager, onCommit } = createManager();

      manager.addFinal("こんにちは");
      manager.commit();
      manager.commit();

      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it("commit() で確定済みの状態で stop() を呼んでも追加の確定は起きない", () => {
      const { manager, onCommit } = createManager();

      manager.addFinal("こんにちは");
      manager.commit();
      manager.stop();

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("こんにちは", "commit");
    });

    it("silence 確定後、保留していたはずの maxDuration タイマーが残っていても二重確定しない", () => {
      const { manager, onCommit } = createManager({
        silenceMs: 1000,
        maxDurationMs: 1_000_000,
      });

      manager.addFinal("あ");
      jest.advanceTimersByTime(1_000); // silence 確定
      expect(onCommit).toHaveBeenCalledTimes(1);

      // maxDuration タイマーが誤ってクリアされずに残っていれば
      // ここでさらに commit されてしまうはず
      jest.advanceTimersByTime(1_000_000);
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
  });

  describe("destroy() の冪等性・安全性", () => {
    it("保留中のタイマーが無い状態で destroy() を呼んでも例外にならない", () => {
      const { manager } = createManager();

      expect(() => manager.destroy()).not.toThrow();
    });

    it("destroy() を2回呼んでも例外にならない", () => {
      const { manager } = createManager();

      manager.addFinal("あ");
      manager.destroy();

      expect(() => manager.destroy()).not.toThrow();
    });
  });

  describe("interim のみで final がないケース", () => {
    it("final を一度も追加せず notifyInterim を繰り返しても、いつまでも確定しない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 100 });

      for (let i = 0; i < 10; i++) {
        manager.notifyInterim();
        jest.advanceTimersByTime(50);
      }

      expect(onCommit).not.toHaveBeenCalled();
      expect(manager.isEmpty()).toBe(true);
      expect(manager.getText()).toBe("");
    });
  });
});
