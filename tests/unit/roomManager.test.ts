/**
 * RoomManager の単体テスト。
 * @see server/room/roomManager.ts
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { RoomManager } from "../../server/room/roomManager";
import type { ParticipantIdentity } from "../../server/room/session";

/** Session が参照する WebSocket の最小限のフェイク */
function createFakeWs(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    send: jest.fn(),
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
    it("参加者をルームに追加し、ok:trueとroom/sessionを返す", () => {
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
  });

  describe("leave", () => {
    it("参加者を退室させ、参加者一覧から削除する", () => {
      const manager = new RoomManager();
      const identity1 = makeIdentity({ role: "owner" });
      const identity2 = makeIdentity({ role: "guest" });
      manager.join("room-1", identity1, createFakeWs());
      manager.join("room-1", identity2, createFakeWs());

      manager.leave("room-1", identity1.participantId);

      const room = manager.getRoom("room-1");
      expect(room).toBeDefined();
      expect(room?.participants.size).toBe(1);
      expect(room?.participants.has(identity1.participantId)).toBe(false);
      expect(room?.participants.has(identity2.participantId)).toBe(true);
    });

    it("参加者0になったルームは自動的に破棄される", () => {
      const manager = new RoomManager();
      const identity = makeIdentity();
      manager.join("room-1", identity, createFakeWs());

      manager.leave("room-1", identity.participantId);

      expect(manager.getRoom("room-1")).toBeUndefined();
      expect(manager.roomCount).toBe(0);
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

  describe("destroyRoom", () => {
    it("ルームを明示的に破棄する", () => {
      const manager = new RoomManager();
      manager.getOrCreateRoom("room-1");
      expect(manager.roomCount).toBe(1);

      manager.destroyRoom("room-1");

      expect(manager.getRoom("room-1")).toBeUndefined();
      expect(manager.roomCount).toBe(0);
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
});
