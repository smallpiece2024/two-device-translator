/**
 * RoomManager の単体テスト。
 *
 * bd-e3p で以下を追加した:
 * - leave() は参加者を削除せず present=false にするのみ（再接続復帰の前提）
 * - join() の再接続復帰（同一 participantId での join）
 * - endRoom() による明示終了（request_end / 自動終了の共通処理）
 * - 不在自動終了タイマー（autoEndThresholdMs / onAutoEnd）
 *
 * @see server/room/roomManager.ts
 * @see docs/design/server-design.md 「再接続・不在・終了判定」
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { RoomManager, DEFAULT_AUTO_END_THRESHOLD_MS } from "../../server/room/roomManager";
import type { ParticipantIdentity } from "../../server/room/session";

/** Session が参照する WebSocket の最小限のフェイク */
function createFakeWs(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    send: jest.fn(),
    close: jest.fn(),
  } as unknown as WebSocket;
}

function makeIdentity(overrides: Partial<ParticipantIdentity> = {}): ParticipantIdentity {
  return {
    participantId: overrides.participantId ?? randomUUID(),
    role: overrides.role ?? "owner",
    displayName: overrides.displayName,
    language: overrides.language ?? "ja-JP",
  };
}

describe("RoomManager", () => {
  describe("getOrCreateRoom / getRoom", () => {
    it("存在しないルームは新規作成され、active状態・空のparticipantsを持つ", () => {
      const manager = new RoomManager();
      const room = manager.getOrCreateRoom("room-1");

      expect(room.roomId).toBe("room-1");
      expect(room.status).toBe("active");
      expect(room.participants.size).toBe(0);
      expect(typeof room.createdAt).toBe("number");
    });

    it("既存ルームに対しては同一のオブジェクトを返す", () => {
      const manager = new RoomManager();
      const first = manager.getOrCreateRoom("room-1");
      const second = manager.getOrCreateRoom("room-1");

      expect(second).toBe(first);
    });

    it("getRoomは未作成のルームIDに対してundefinedを返す", () => {
      const manager = new RoomManager();
      expect(manager.getRoom("unknown")).toBeUndefined();
    });
  });

  describe("join", () => {
    it("参加者をルームに追加し、ok:trueとroom/sessionを返す（reconnected:false）", () => {
      const manager = new RoomManager();
      const identity = makeIdentity({ role: "owner" });
      const ws = createFakeWs();

      const result = manager.join("room-1", identity, ws);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.room.roomId).toBe("room-1");
      expect(result.session.participantId).toBe(identity.participantId);
      expect(result.room.participants.get(identity.participantId)).toBe(result.session);
      expect(result.room.participants.size).toBe(1);
      expect(result.reconnected).toBe(false);
      expect(result.previousSocket).toBeNull();
    });

    it("maxParticipantsに達している場合はok:falseで拒否し、既存参加者は維持される", () => {
      const manager = new RoomManager({ maxParticipants: 2 });
      const ws1 = createFakeWs();
      const ws2 = createFakeWs();
      const ws3 = createFakeWs();

      manager.join("room-1", makeIdentity({ role: "owner" }), ws1);
      manager.join("room-1", makeIdentity({ role: "guest" }), ws2);
      const result = manager.join("room-1", makeIdentity({ role: "guest" }), ws3);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/full/i);

      const room = manager.getRoom("room-1");
      expect(room?.participants.size).toBe(2);
    });

    it("既定のmaxParticipantsは2である", () => {
      const manager = new RoomManager();
      manager.join("room-1", makeIdentity(), createFakeWs());
      manager.join("room-1", makeIdentity(), createFakeWs());
      const result = manager.join("room-1", makeIdentity(), createFakeWs());

      expect(result.ok).toBe(false);
    });

    it("statusがendedのルームへのjoinはok:falseで拒否される", () => {
      const manager = new RoomManager();
      const room = manager.getOrCreateRoom("room-1");
      room.status = "ended";

      const result = manager.join("room-1", makeIdentity(), createFakeWs());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/ended/i);
    });

    describe("再接続復帰（同一participantIdでのjoin）", () => {
      it("present中の参加者が同一participantIdで再joinすると、ok:true・reconnected:trueで既存sessionを返し、previousSocketを含む", () => {
        const manager = new RoomManager();
        const identity = makeIdentity({ role: "owner" });
        const ws1 = createFakeWs();
        const first = manager.join("room-1", identity, ws1);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const ws2 = createFakeWs();
        const result = manager.join("room-1", identity, ws2);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.reconnected).toBe(true);
        expect(result.session).toBe(first.session);
        expect(result.previousSocket).toBe(ws1);
        expect(result.room.participants.size).toBe(1);
      });

      it("不在（present:false）の参加者が同一participantIdで再joinすると present が true に復帰する", () => {
        const manager = new RoomManager();
        const identity = makeIdentity({ role: "guest" });
        manager.join("room-1", identity, createFakeWs());
        manager.leave("room-1", identity.participantId);
        expect(manager.getRoom("room-1")?.participants.get(identity.participantId)?.present).toBe(
          false,
        );

        const result = manager.join("room-1", identity, createFakeWs());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.reconnected).toBe(true);
        expect(result.session.present).toBe(true);
      });

      it("再接続復帰はmaxParticipantsの対象外（既に部屋が満員でも同一IDなら成功する）", () => {
        const manager = new RoomManager({ maxParticipants: 1 });
        const identity = makeIdentity({ role: "owner" });
        manager.join("room-1", identity, createFakeWs());

        const result = manager.join("room-1", identity, createFakeWs());

        expect(result.ok).toBe(true);
      });

      it("再接続時、表示名・言語が最新のjoinメッセージ由来の値に更新される", () => {
        const manager = new RoomManager();
        const identity = makeIdentity({ role: "owner", displayName: "旧名前", language: "ja-JP" });
        manager.join("room-1", identity, createFakeWs());

        const result = manager.join(
          "room-1",
          { ...identity, displayName: "新名前", language: "en-US" },
          createFakeWs(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.session.displayName).toBe("新名前");
        expect(result.session.language).toBe("en-US");
      });
    });
  });

  describe("leave（present=falseへの変更のみ・削除しない）", () => {
    it("参加者を退室させても参加者一覧からは削除されず、present:falseになる", () => {
      const manager = new RoomManager();
      const identity1 = makeIdentity({ role: "owner" });
      const identity2 = makeIdentity({ role: "guest" });
      manager.join("room-1", identity1, createFakeWs());
      manager.join("room-1", identity2, createFakeWs());

      manager.leave("room-1", identity1.participantId);

      const room = manager.getRoom("room-1");
      expect(room).toBeDefined();
      expect(room?.participants.size).toBe(2);
      expect(room?.participants.get(identity1.participantId)?.present).toBe(false);
      expect(room?.participants.get(identity2.participantId)?.present).toBe(true);
    });

    it("参加者0人（全員leave）になってもルームは自動的に破棄されない（endRoom経由でのみ破棄される）", () => {
      const manager = new RoomManager();
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      manager.leave("room-1", identity.participantId);

      const room = manager.getRoom("room-1");
      expect(room).toBeDefined();
      expect(room?.status).toBe("active");
      expect(room?.participants.size).toBe(1);
      expect(room?.participants.get(identity.participantId)?.present).toBe(false);
      expect(manager.roomCount).toBe(1);
    });

    it("存在しないルームに対するleaveは何もせず例外も投げない", () => {
      const manager = new RoomManager();
      expect(() => manager.leave("no-such-room", "no-such-participant")).not.toThrow();
    });

    it("存在しない参加者IDに対するleaveは何もせず例外も投げない", () => {
      const manager = new RoomManager();
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      expect(() => manager.leave("room-1", "unknown-participant-id")).not.toThrow();
      expect(manager.getRoom("room-1")?.participants.size).toBe(1);
    });
  });

  describe("leave — AUTH_MODEによる分岐（insecure: 削除してmaxParticipants枠を解放 / strict: present=falseで席を保持）", () => {
    let originalAuthMode: string | undefined;

    beforeEach(() => {
      originalAuthMode = process.env.AUTH_MODE;
    });

    afterEach(() => {
      if (originalAuthMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalAuthMode;
      }
    });

    it(
      "AUTH_MODE=insecureのとき、leaveで参加者エントリが削除されmaxParticipantsの枠が" +
        "解放される（別IDでの再joinが成功することで確認）",
      () => {
        process.env.AUTH_MODE = "insecure";
        const manager = new RoomManager({ maxParticipants: 2 });
        const identity1 = makeIdentity({ role: "owner" });
        const identity2 = makeIdentity({ role: "guest" });
        manager.join("room-1", identity1, createFakeWs());
        manager.join("room-1", identity2, createFakeWs());
        expect(manager.getRoom("room-1")?.participants.size).toBe(2);

        manager.leave("room-1", identity1.participantId);

        const room = manager.getRoom("room-1");
        expect(room?.participants.size).toBe(1);
        expect(room?.participants.has(identity1.participantId)).toBe(false);

        // 枠が解放されているため、別IDでの新規参加が成功する（maxParticipants=2の2人目扱い）
        const newIdentity = makeIdentity({ role: "guest" });
        const result = manager.join("room-1", newIdentity, createFakeWs());
        expect(result.ok).toBe(true);
        expect(manager.getRoom("room-1")?.participants.size).toBe(2);
      },
    );

    it(
      "AUTH_MODE未設定（strict）のとき、leaveではエントリが削除されずpresent:falseで" +
        "席が保持される（別IDでの新規参加はmaxParticipants超過で拒否される）",
      () => {
        delete process.env.AUTH_MODE;
        const manager = new RoomManager({ maxParticipants: 2 });
        const identity1 = makeIdentity({ role: "owner" });
        const identity2 = makeIdentity({ role: "guest" });
        manager.join("room-1", identity1, createFakeWs());
        manager.join("room-1", identity2, createFakeWs());

        manager.leave("room-1", identity1.participantId);

        const room = manager.getRoom("room-1");
        expect(room?.participants.size).toBe(2);
        expect(room?.participants.get(identity1.participantId)?.present).toBe(false);

        // 席が保持されたままのため、別IDでの新規参加はmaxParticipants超過で拒否される
        const newIdentity = makeIdentity({ role: "guest" });
        const result = manager.join("room-1", newIdentity, createFakeWs());
        expect(result.ok).toBe(false);
        expect(manager.getRoom("room-1")?.participants.size).toBe(2);
      },
    );

    it("AUTH_MODEが'insecure'以外の値（例:'strict'）のときもエントリは削除されずpresent:falseになる", () => {
      process.env.AUTH_MODE = "strict";
      const manager = new RoomManager();
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      manager.leave("room-1", identity.participantId);

      const room = manager.getRoom("room-1");
      expect(room?.participants.has(identity.participantId)).toBe(true);
      expect(room?.participants.get(identity.participantId)?.present).toBe(false);
    });
  });

  describe("endRoom（明示終了）", () => {
    it("activeなルームをendedにし、Roomを返す", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");

      const ended = manager.endRoom("room-1");

      expect(ended).toBeDefined();
      expect(ended?.status).toBe("ended");
      expect(manager.getRoom("room-1")?.status).toBe("ended");
    });

    it("ルームはレジストリから削除されない（endRoom後もgetRoomで取得できる）", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");

      manager.endRoom("room-1");

      expect(manager.getRoom("room-1")).toBeDefined();
      expect(manager.roomCount).toBe(1);
    });

    it("既にendedのルームへの再度のendRoomはundefinedを返す（二重終了防止）", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");
      manager.endRoom("room-1");

      const second = manager.endRoom("room-1");

      expect(second).toBeUndefined();
    });

    it("存在しないルームへのendRoomはundefinedを返し例外を投げない", () => {
      const manager = new RoomManager();
      expect(() => manager.endRoom("no-such-room")).not.toThrow();
      expect(manager.endRoom("no-such-room")).toBeUndefined();
    });

    it("endした後は稼働中のautoEndTimerが解除される", () => {
      jest.useFakeTimers();
      try {
        const onAutoEnd = jest.fn();
        const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
        const identity = makeIdentity();
        manager.join("room-1", identity, createFakeWs());
        // present 1人のためタイマーが起動している
        expect(manager.getRoom("room-1")?.autoEndTimer).not.toBeNull();

        manager.endRoom("room-1");

        expect(manager.getRoom("room-1")?.autoEndTimer).toBeNull();
        jest.advanceTimersByTime(2000);
        expect(onAutoEnd).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("ended状態のルームへのjoinは拒否される", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");
      manager.endRoom("room-1");

      const result = manager.join("room-1", makeIdentity(), createFakeWs());

      expect(result.ok).toBe(false);
    });
  });

  describe("destroyRoom", () => {
    it("ルームを明示的に破棄する", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");
      expect(manager.roomCount).toBe(1);

      manager.destroyRoom("room-1");

      expect(manager.getRoom("room-1")).toBeUndefined();
      expect(manager.roomCount).toBe(0);
    });

    it("稼働中のautoEndTimerを解除してから破棄する（破棄後にタイマーが発火してもonAutoEndは呼ばれない）", () => {
      jest.useFakeTimers();
      try {
        const onAutoEnd = jest.fn();
        const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
        manager.join("room-1", makeIdentity(), createFakeWs());

        manager.destroyRoom("room-1");
        jest.advanceTimersByTime(2000);

        expect(onAutoEnd).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("roomCount", () => {
    it("保持しているルーム数を返す", () => {
      const manager = new RoomManager();
      expect(manager.roomCount).toBe(0);

      manager.getOrCreateRoom("room-1");
      manager.getOrCreateRoom("room-2");

      expect(manager.roomCount).toBe(2);
    });
  });

  describe("不在自動終了タイマー（autoEndThresholdMs / onAutoEnd）", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("既定のしきい値は10分（DEFAULT_AUTO_END_THRESHOLD_MS）である", () => {
      expect(DEFAULT_AUTO_END_THRESHOLD_MS).toBe(10 * 60 * 1000);
    });

    it("present participantsが2人以上の間はタイマーが起動しない", () => {
      jest.useFakeTimers();
      const onAutoEnd = jest.fn();
      const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
      manager.join("room-1", makeIdentity({ role: "owner" }), createFakeWs());
      manager.join("room-1", makeIdentity({ role: "guest" }), createFakeWs());

      expect(manager.getRoom("room-1")?.autoEndTimer).toBeNull();
      jest.advanceTimersByTime(5000);
      expect(onAutoEnd).not.toHaveBeenCalled();
    });

    it("presentが1人以下の状態がしきい値時間継続すると自動終了し、onAutoEndが呼ばれる", () => {
      jest.useFakeTimers();
      const onAutoEnd = jest.fn();
      const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      expect(manager.getRoom("room-1")?.autoEndTimer).not.toBeNull();
      expect(manager.getRoom("room-1")?.soloSinceAt).not.toBeNull();

      jest.advanceTimersByTime(1000);

      expect(onAutoEnd).toHaveBeenCalledTimes(1);
      const endedRoom = onAutoEnd.mock.calls[0][0];
      expect(endedRoom.roomId).toBe("room-1");
      expect(endedRoom.status).toBe("ended");
      expect(manager.getRoom("room-1")?.status).toBe("ended");
      expect(manager.getRoom("room-1")?.autoEndTimer).toBeNull();
    });

    it("2人目が参加してpresentが2人に戻るとタイマーが解除され、しきい値経過してもonAutoEndは呼ばれない", () => {
      jest.useFakeTimers();
      const onAutoEnd = jest.fn();
      const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
      manager.join("room-1", makeIdentity({ role: "owner" }), createFakeWs());
      expect(manager.getRoom("room-1")?.autoEndTimer).not.toBeNull();

      manager.join("room-1", makeIdentity({ role: "guest" }), createFakeWs());
      expect(manager.getRoom("room-1")?.autoEndTimer).toBeNull();
      expect(manager.getRoom("room-1")?.soloSinceAt).toBeNull();

      jest.advanceTimersByTime(1000);
      expect(onAutoEnd).not.toHaveBeenCalled();
    });

    it("leaveで1人以下になった後、しきい値経過前に再接続（reconnect）するとタイマーが解除される", () => {
      jest.useFakeTimers();
      const onAutoEnd = jest.fn();
      const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
      const identity1 = makeIdentity({ role: "owner" });
      const identity2 = makeIdentity({ role: "guest" });
      manager.join("room-1", identity1, createFakeWs());
      manager.join("room-1", identity2, createFakeWs());

      manager.leave("room-1", identity2.participantId);
      expect(manager.getRoom("room-1")?.autoEndTimer).not.toBeNull();

      jest.advanceTimersByTime(500);
      manager.join("room-1", identity2, createFakeWs()); // 再接続
      expect(manager.getRoom("room-1")?.autoEndTimer).toBeNull();

      jest.advanceTimersByTime(1000);
      expect(onAutoEnd).not.toHaveBeenCalled();
    });

    it("しきい値到達で自動終了した後、endedなルームへの再joinは拒否される", () => {
      jest.useFakeTimers();
      const onAutoEnd = jest.fn();
      const manager = new RoomManager({ autoEndThresholdMs: 1000, onAutoEnd });
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      jest.advanceTimersByTime(1000);
      expect(onAutoEnd).toHaveBeenCalledTimes(1);

      const result = manager.join("room-1", makeIdentity(), createFakeWs());
      expect(result.ok).toBe(false);
    });

    it("onAutoEndが未指定でも例外を投げずに自動終了する", () => {
      jest.useFakeTimers();
      const manager = new RoomManager({ autoEndThresholdMs: 1000 });
      manager.join("room-1", makeIdentity(), createFakeWs());

      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
      expect(manager.getRoom("room-1")?.status).toBe("ended");
    });
  });
});
