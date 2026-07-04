/**
 * 全ルームのレジストリ（インメモリ）。
 *
 * ルームの取得/生成/破棄、参加者の追加/削除、参加者一覧の保持を担う。
 * 1:N への拡張を見据え `participants` は `Map` で保持し、実装上の人数制約は
 * 設けない。ただし Phase1 は 2参加者運用のため、`maxParticipants`
 * （既定2、コンストラクタで変更可能）で join 時の人数上限を設定できる。
 *
 * GCP連携・翻訳配信ルーティング等は本モジュールの範囲外（別タスクで
 * `roomManager.ts` を拡張する。docs/design/server-design.md 参照）。
 *
 * @see docs/design/server-design.md 「モジュール構成」「状態モデル（インメモリ）」
 */
import type { WebSocket } from "ws";
import { Session, type ParticipantIdentity } from "./session";

/** ルームの状態（Phase1では常に "active"。"ended" はPhase2/3で使用） */
export type RoomStatus = "active" | "ended";

/** ルームのランタイム状態 */
export interface Room {
  readonly roomId: string;
  status: RoomStatus;
  readonly participants: Map<string, Session>;
  readonly createdAt: number;
}

/** `RoomManager.join` の結果 */
export type JoinResult =
  | { ok: true; room: Room; session: Session }
  | { ok: false; reason: string };

export interface RoomManagerOptions {
  /** 1ルームあたりの最大参加者数（既定2。Phase1の運用上限） */
  maxParticipants?: number;
}

const DEFAULT_MAX_PARTICIPANTS = 2;

/**
 * ルーム・参加者管理の中核クラス。
 *
 * サーバープロセス内に単一インスタンスを保持し、`server/index.ts` から
 * 接続ごとに `join` / `leave` を呼び出して使う。
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly maxParticipants: number;

  constructor(options: RoomManagerOptions = {}) {
    this.maxParticipants = options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
  }

  /** 既存ルームを返すか、存在しなければ新規作成して返す */
  getOrCreateRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const room: Room = {
      roomId,
      status: "active",
      participants: new Map(),
      createdAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /** ルームを取得する（存在しなければ undefined） */
  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * 参加者をルームへ加える。
   *
   * - ルームが `ended` の場合は拒否する
   * - 参加者数が `maxParticipants` に達している場合は拒否する
   *
   * 拒否時もルーム自体は（他参加者のために）維持する。
   */
  join(
    roomId: string,
    identity: ParticipantIdentity,
    ws: WebSocket,
    options?: { enableTts?: boolean },
  ): JoinResult {
    const room = this.getOrCreateRoom(roomId);

    if (room.status === "ended") {
      return { ok: false, reason: "room has already ended" };
    }

    if (room.participants.size >= this.maxParticipants) {
      return { ok: false, reason: "room is full" };
    }

    const session = new Session(identity, ws, options);
    room.participants.set(session.participantId, session);

    return { ok: true, room, session };
  }

  /**
   * 参加者をルームから退室させる（接続 close 時に呼ぶ）。
   *
   * Phase1 は再接続復帰（present=false での保持）を行わず、
   * 参加者エントリを削除する（再接続復帰は Phase2 スコープ、
   * docs/design/server-design.md「再接続・不在・終了判定」参照）。
   * 退室後にルームが空になった場合はルーム自体も破棄する。
   */
  leave(roomId: string, participantId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const session = room.participants.get(participantId);
    if (session) {
      session.present = false;
    }
    room.participants.delete(participantId);

    if (room.participants.size === 0) {
      this.destroyRoom(roomId);
    }
  }

  /** ルームを破棄する */
  destroyRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** 現在保持しているルーム数（テスト・監視用） */
  get roomCount(): number {
    return this.rooms.size;
  }
}
