import {
  UtteranceBufferManager,
  UtteranceCommitReason,
  DEFAULT_UTTERANCE_BUFFER_CONFIG,
} from "../../server/utterance/utteranceBuffer";

/**
 * UtteranceBufferManager の単体テスト。
 *
 * 実時間の sleep には依存せず、jest のフェイクタイマーで
 * 決定的にタイマー系の確定判定を検証する（flaky 回避）。
 */
describe("UtteranceBufferManager", () => {
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

  describe("無音タイマーによる確定", () => {
    it("addFinal 後、無音時間(silenceMs)を超過すると silence で確定する", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("こんにちは");
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(999);
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("こんにちは", "silence");
    });

    it("addFinal が連続すると無音タイマーがリセットされ、最後の final から silenceMs 経過しないと確定しない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("あ");
      jest.advanceTimersByTime(700);
      manager.addFinal("い");
      jest.advanceTimersByTime(700);
      // 最初の final から 1400ms 経過しているが、2回目の final から 700ms しか経っていないので未確定
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あい", "silence");
    });

    it("notifyInterim（バッファ非空時）で無音タイマーがリセットされる", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("あ");
      jest.advanceTimersByTime(900);
      manager.notifyInterim();
      jest.advanceTimersByTime(900);
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あ", "silence");
    });

    it("バッファが空の状態で notifyInterim を呼んでも silence 確定は起きない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.notifyInterim();
      jest.advanceTimersByTime(5000);

      expect(onCommit).not.toHaveBeenCalled();
      expect(manager.isEmpty()).toBe(true);
    });
  });

  describe("文字数上限による確定", () => {
    it("累積文字数が maxChars 以上になった時点で即座に maxChars で確定する", () => {
      const { manager, onCommit } = createManager({ maxChars: 5, silenceMs: 1000 });

      manager.addFinal("abc");
      expect(onCommit).not.toHaveBeenCalled();

      manager.addFinal("de");
      // タイマーを進めなくても同期的に確定すること
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("abcde", "maxChars");
    });

    it("maxChars 確定後はバッファがクリアされ、次の発話として独立して蓄積される", () => {
      const { manager, onCommit } = createManager({ maxChars: 3, silenceMs: 1000 });

      manager.addFinal("abc");
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenNthCalledWith(1, "abc", "maxChars");

      manager.addFinal("xy");
      expect(manager.getText()).toBe("xy");
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
  });

  describe("発話秒数上限による確定", () => {
    it("バッファが非空になってから maxDurationMs 経過すると maxSeconds で確定する", () => {
      const { manager, onCommit } = createManager({
        maxDurationMs: 10_000,
        silenceMs: 100_000, // 無音確定が先に発火しないよう十分大きくする
      });

      manager.addFinal("あ");
      jest.advanceTimersByTime(9_999);
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あ", "maxSeconds");
    });

    it("最大発話タイマーはバッファが最初に非空になった時点を起点にする（追加の final で延長されない）", () => {
      const { manager, onCommit } = createManager({
        maxDurationMs: 10_000,
        silenceMs: 100_000,
      });

      manager.addFinal("あ");
      jest.advanceTimersByTime(6_000);
      manager.addFinal("い");
      jest.advanceTimersByTime(3_999);
      expect(onCommit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あい", "maxSeconds");
    });
  });

  describe("手動 commit", () => {
    it("commit() 呼び出しでバッファが非空なら即座に commit で確定する", () => {
      const { manager, onCommit } = createManager();

      manager.addFinal("こんばんは");
      manager.commit();

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("こんばんは", "commit");
    });

    it("バッファが空の状態で commit() を呼んでもコールバックは呼ばれない", () => {
      const { manager, onCommit } = createManager();

      manager.commit();

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("commit() 後は保留中のタイマーがクリアされ、後から自動確定されない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      manager.addFinal("あ");
      manager.commit();
      expect(onCommit).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(10_000);
      // 追加の確定は起きない（バッファは空のまま）
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop によるセッション終了確定", () => {
    it("stop() 呼び出しでバッファが非空なら即座に stop で確定する", () => {
      const { manager, onCommit } = createManager();

      manager.addFinal("さようなら");
      manager.stop();

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("さようなら", "stop");
    });

    it("バッファが空の状態で stop() を呼んでもコールバックは呼ばれない", () => {
      const { manager, onCommit } = createManager();

      manager.stop();

      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  describe("音声チャンク受信相当の入力によるタイマー非リセット（既知仕様）", () => {
    it("音声チャンク受信では addFinal/notifyInterim を呼ばない前提のため、単に時間経過のみでは無音タイマーが動かない", () => {
      // このテストは「音声チャンク受信ハンドラは UtteranceBufferManager の
      // タイマーリセット系メソッドを一切呼び出さない」という利用契約を表現する。
      // バッファ確定判定に影響を与えるのは addFinal / notifyInterim / commit / stop のみであり、
      // 音声チャンクの受信自体（＝何もメソッドを呼ばないこと）はタイマーに影響しない。
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("あ");
      jest.advanceTimersByTime(900);

      // 音声チャンクが継続的に届いている状況をシミュレート：
      // 音声チャンク受信ハンドラはこのクラスの何のメソッドも呼ばない。
      for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(50); // 無音でも一定間隔でチャンクが送出される想定の時間経過のみ
      }

      // 合計 1900ms 経過しているが、無音タイマーはリセットされていないため
      // 900ms 時点から 100ms 後（合計1000ms）で確定済みのはず
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あ", "silence");
    });

    it("notifyInterim を挟まない限り、音声チャンク相当の頻繁な時間経過だけではタイマーが延長されない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 500 });

      manager.addFinal("あ");
      // 100msごとに5回、チャンク受信を模した「何もしない」経過を挟む
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(100);
        expect(onCommit).not.toHaveBeenCalled();
      }
      // 合計400ms経過。ここでさらに100ms進めると500msに到達し確定する
      jest.advanceTimersByTime(100);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("あ", "silence");
    });
  });

  describe("destroy", () => {
    it("destroy() 後にタイマーが発火しても確定コールバックは呼ばれない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("あ");
      manager.destroy();

      jest.advanceTimersByTime(10_000);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("destroy() 後にメソッドを呼び出すとエラーになる", () => {
      const { manager } = createManager();

      manager.destroy();

      expect(() => manager.addFinal("あ")).toThrow();
      expect(() => manager.notifyInterim()).toThrow();
      expect(() => manager.commit()).toThrow();
      expect(() => manager.stop()).toThrow();
    });
  });

  describe("空文字finalのみのタイマーリーク回帰（bd-124.2）", () => {
    // addFinal("") はバッファを非空（finals.length === 1, text は空文字）にするため、
    // 無音タイマー・最大発話タイマーの双方が起動する。commitInternal() は
    // 確定要否に関わらず必ずタイマーをクリアする実装であることを、
    // commit/stop/silence/maxSeconds の全経路で jest.getTimerCount() により検証する。

    it("addFinal('') 直後は無音・最大発話の両タイマーが起動している", () => {
      const { manager } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      expect(jest.getTimerCount()).toBe(0);
      manager.addFinal("");
      expect(jest.getTimerCount()).toBe(2);
    });

    it("addFinal('') の後 commit() しても確定イベントは発火せず、タイマーは残留しない（commit経路）", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      manager.addFinal("");
      manager.commit();

      expect(onCommit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("addFinal('') の後 stop() しても確定イベントは発火せず、タイマーは残留しない（stop経路）", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      manager.addFinal("");
      manager.stop();

      expect(onCommit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("addFinal('') のみで無音タイマーが発火しても確定イベントは発火せず、タイマーは残留しない（silence経路）", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      manager.addFinal("");
      jest.advanceTimersByTime(1000);

      expect(onCommit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("addFinal('') のみで最大発話タイマーが発火しても確定イベントは発火せず、タイマーは残留しない（maxSeconds経路）", () => {
      const { manager, onCommit } = createManager({
        maxDurationMs: 10_000,
        silenceMs: 100_000, // 無音確定が先に発火しないよう十分大きくする
      });

      manager.addFinal("");
      jest.advanceTimersByTime(10_000);

      expect(onCommit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("空文字finalが複数回連続しても、commit後にタイマーが残留しない", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000, maxDurationMs: 5000 });

      manager.addFinal("");
      manager.addFinal("");
      manager.addFinal("");
      expect(jest.getTimerCount()).toBe(2); // 無音タイマーはリセットされ続けるが最大発話タイマーは維持

      manager.commit();

      expect(onCommit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe("getText / isEmpty", () => {
    it("addFinal 前は isEmpty() が true, getText() が空文字", () => {
      const { manager } = createManager();

      expect(manager.isEmpty()).toBe(true);
      expect(manager.getText()).toBe("");
    });

    it("addFinal 後は isEmpty() が false, getText() が蓄積済みテキストを返す（確定はしない）", () => {
      const { manager, onCommit } = createManager({ silenceMs: 1000 });

      manager.addFinal("あ");
      manager.addFinal("い");

      expect(manager.isEmpty()).toBe(false);
      expect(manager.getText()).toBe("あい");
      expect(onCommit).not.toHaveBeenCalled();
    });
  });
});
