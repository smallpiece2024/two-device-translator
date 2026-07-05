/**
 * 全ルームのレジストリ（インメモリ）。
 *
 * ルームの取得/生成/破棄、参加者の追加/削除、参加者一覧の保持を担う。
 * 1:N への拡張を見据え `participants` は `Map` で保持し、実装上の人数制約は
 * 設けない。ただし Phase1 は 2参加者運用のため、`maxParticipants`
 * （既定2、コンストラクタで変更可能）で join 時の人数上限を設定できる。
 *
 * bd-e3p で以下を追加した（docs/design/server-design.md
 * 「再接続・不在・終了判定」参照）:
 * - 再接続復帰: 同一 `participantId` での join を「新規参加」ではなく
 *   「既存セッションへのソケット差し替え」として扱う
 * - 不在検出: 接続 close は参加者を Map から削除せず `present=false` にする
 *   のみとし、present な参加者が1人以下の状態が続くとルームを自動終了する
 * - 明示終了: `endRoom()`（`request_end` / 自動終了の両方から呼ばれる）
 *
 * GCP連携・翻訳配信ルーティング・実際のソケット送信/クローズ・DB書き込みは
 * 本モジュールの範囲外（`server/index.ts` の責務。本モジュールは状態管理の
 * みに専念し、終了時の通知等は `onAutoEnd` コールバック経由で委譲する）。
 *
 * @see docs/design/server-design.md 「モジュール構成」「状態モデル（インメモリ）」「再接続・不在・終了判定」
 */
import type { WebSocket } from "ws";
import type { RoomEndedReason } from "@shared/index";
import { Session, type ParticipantIdentity } from "./session";
import { isInsecureAuthMode } from "../auth/verifyParticipant";

/** ルームの状態（"ended" になったルームへの再joinは拒否される） */
export type RoomStatus = "active" | "ended";

/** ルームのランタイム状態 */
export interface Room {
  readonly roomId: string;
  status: RoomStatus;
  readonly participants: Map<string, Session>;
  readonly createdAt: number;
  /**
   * 不在自動終了用のタイマー（内部実装詳細）。present な参加者が1人以下に
   * なった時点で起動し、2人以上に戻ると解除される。null は非稼働中。
   */
  autoEndTimer: ReturnType<typeof setTimeout> | null;
  /**
   * present な参加者が1人以下になった時刻（監視・テスト用に公開。
   * 2人以上に戻ると null に戻る）。
   */
  soloSinceAt: number | null;
  /**
   * ルーム終了理由（`endRoom()` 実行時に設定。`status==="ended"` のとき必ず
   * 非 null）。ended ルームへの再 join 時、この理由を `room_ended` として
   * 案内するために保持する（コードレビュー指摘 must-fix1、
   * docs/design/server-design.md「再接続復帰」の
   * 「ルームが既に ended の場合は room_ended を返して接続を閉じる」参照）。
   */
  endedReason: RoomEndedReason | null;
}

/** `RoomManager.join` の結果 */
export type JoinResult =
  | {
      ok: true;
      room: Room;
      session: Session;
      /** 既存 participantId への再接続復帰なら true（新規参加なら false） */
      reconnected: boolean;
      /**
       * 再接続時、差し替え前に使われていたソケット（呼び出し側が開いていれば
       * 閉じる判断に使う）。新規参加時は null。
       */
      previousSocket: WebSocket | null;
    }
  | {
      ok: false;
      reason: string;
      /**
       * ルームが既に終了済みだった場合のみ設定される（must-fix1）。
       * 呼び出し側（`server/index.ts`）はこれが設定されていれば
       * `error` ではなく `room_ended` を送ってから接続を閉じる。
       */
      endedReason?: RoomEndedReason;
    };

export interface RoomManagerOptions {
  /** 1ルームあたりの最大参加者数（既定2。Phase1の運用上限） */
  maxParticipants?: number;
  /**
   * 不在自動終了のしきい値（ms）。present な参加者が1人以下の状態が
   * この時間継続するとルームを自動終了する（FR-12.2）。
   * 既定10分: 一時的な回線切断からの再接続を妨げない範囲で、放置ルームを
   * 妥当な時間で解放するための暫定値（要件に具体的な秒数の指定なし）。
   * 環境変数での上書きは `server/index.ts` 側で解決する。
   */
  autoEndThresholdMs?: number;
  /**
   * 自動終了しきい値に到達した際に呼ばれる（endRoom 実行後、該当 Room を渡す）。
   * 実際の `room_ended` 配信・ソケットクローズ・DB更新は `server/index.ts` の責務。
   */
  onAutoEnd?: (room: Room) => void;
}

const DEFAULT_MAX_PARTICIPANTS = 2;

/** 不在自動終了の既定しきい値（10分）。根拠は `RoomManagerOptions.autoEndThresholdMs` 参照 */
export const DEFAULT_AUTO_END_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * ルーム・参加者管理の中核クラス。
 *
 * サーバープロセス内に単一インスタンスを保持し、`server/index.ts` から
 * 接続ごとに `join` / `leave` を呼び出して使う。
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly maxParticipants: number;
  private readonly autoEndThresholdMs: number;
  private readonly onAutoEnd?: (room: Room) => void;

  constructor(options: RoomManagerOptions = {}) {
    this.maxParticipants = options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    this.autoEndThresholdMs = options.autoEndThresholdMs ?? DEFAULT_AUTO_END_THRESHOLD_MS;
    this.onAutoEnd = options.onAutoEnd;
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
      autoEndTimer: null,
      soloSinceAt: null,
      endedReason: null,
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
   * - 同一 `participantId` が既にルームに存在する場合は「再接続」として扱い、
   *   既存セッションのソケットを差し替える（`maxParticipants` の対象外。
   *   present/absent を問わず同一IDなら再接続扱いにする）
   * - 上記に該当しない新規参加で、参加者数が `maxParticipants` に達している
   *   場合は拒否する
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
      // endedReason は endRoom() 実行時に必ず設定されるが、万一 null の場合に
      // 備え防御的にフォールバックする（型上 non-null を強制しないための保険）。
      return {
        ok: false,
        reason: "room has already ended",
        endedReason: room.endedReason ?? "auto_timeout",
      };
    }

    const existing = room.participants.get(identity.participantId);
    if (existing) {
      // 再接続復帰: 同一 participantId が既に在室情報として存在する
      // （present=false の不在中、あるいは稀に present=true のままの
      // 二重接続）。いずれの場合も新しい接続を正として扱う
      // （二重接続時は古い接続を閉じる設計判断。実際の close は
      // `server/index.ts` が `previousSocket` を使って行う）。
      const previousSocket = existing.attachSocket(ws);
      // 表示名・言語は最新の join メッセージ由来の値で更新する
      // （接続のたびに変更されうる値。verifyParticipant.ts と同じ方針）。
      existing.displayName = identity.displayName;
      existing.language = identity.language;
      if (options?.enableTts !== undefined) {
        existing.enableTts = options.enableTts;
      }

      this.refreshAutoEndTimer(room);

      return { ok: true, room, session: existing, reconnected: true, previousSocket };
    }

    if (room.participants.size >= this.maxParticipants) {
      return { ok: false, reason: "room is full" };
    }

    const session = new Session(identity, ws, options);
    room.participants.set(session.participantId, session);

    this.refreshAutoEndTimer(room);

    return { ok: true, room, session, reconnected: false, previousSocket: null };
  }

  /**
   * 参加者を不在にする（接続 close 時に呼ぶ）。
   *
   * bd-e3p: 再接続復帰のため、参加者エントリは削除せず `present=false` に
   * するのみとする（Phase1 の「削除して0人ならルーム破棄」からの変更。
   * ルームの破棄は `endRoom()`（明示終了・自動終了）でのみ行う、
   * docs/design/server-design.md「再接続・不在・終了判定」参照）。
   *
   * ## 例外: `AUTH_MODE=insecure`（コードレビュー指摘 should-fix1）
   *
   * insecure モード（E2E・開発専用、`server/auth/verifyParticipant.ts` 参照）は
   * `participantId` が接続のたびに `randomUUID()` で新規発行され、原理的に
   * 「同一IDでの再接続」が起こらない。そのため `present=false` のまま保持すると
   * 誰も再接続しない空き枠が永久に残り、`maxParticipants`（既定2）の小さい
   * ルームで新規参加が事実上不可能になる（再接続機能が逆に自壊を招く）。
   * このモードに限り Phase1 と同じ「削除」動作を維持する
   * （strict モード＝本番相当は安定 participantId のため対象外）。
   */
  leave(roomId: string, participantId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const session = room.participants.get(participantId);
    if (!session) {
      return;
    }

    if (isInsecureAuthMode()) {
      room.participants.delete(participantId);
    } else {
      session.present = false;
    }

    this.refreshAutoEndTimer(room);
  }

  /**
   * ルームを明示的に終了する（`request_end` / 自動終了の両方から呼ぶ）。
   * 既に `ended` またはルームが存在しない場合は `undefined` を返す
   * （二重終了を防ぐ）。
   *
   * ルームは `rooms` レジストリから削除しない。再接続してきたクライアントに
   * 「ルームは既に終了している」ことを案内できるようにするため
   * （docs/design/server-design.md「再接続復帰」の
   * 「ルームが既に ended の場合は room_ended を返して接続を閉じる」参照）。
   *
   * 参加者への `room_ended` 配信・ソケットクローズ・DB更新は呼び出し側
   * （`server/index.ts`）の責務。戻り値の `Room`（終了直前の participants を
   * 保持した状態）をそのために使う。
   *
   * @param reason 終了理由（`"owner_ended"` | `"auto_timeout"`）。`room.endedReason`
   *   に保持し、ended ルームへの再 join 時に `room_ended` として案内する
   *   （must-fix1、コードレビュー指摘対応）。省略時は `"owner_ended"`
   *   （呼び出し側で理由を問わない明示終了を想定した既定値。自動終了
   *   タイマー内部の呼び出しは常に明示的に `"auto_timeout"` を渡す）。
   */
  endRoom(roomId: string, reason: RoomEndedReason = "owner_ended"): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room || room.status === "ended") {
      return undefined;
    }

    room.status = "ended";
    room.endedReason = reason;
    this.clearAutoEndTimer(room);

    return room;
  }

  /** ルームを破棄する（レジストリから完全に削除する。主にテスト・明示的なクリーンアップ用） */
  destroyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      this.clearAutoEndTimer(room);
    }
    this.rooms.delete(roomId);
  }

  /** 現在保持しているルーム数（テスト・監視用） */
  get roomCount(): number {
    return this.rooms.size;
  }

  // ----------------------------------------------------------
  // プライベート: 不在自動終了タイマー管理
  // ----------------------------------------------------------

  private countPresent(room: Room): number {
    let count = 0;
    for (const session of room.participants.values()) {
      if (session.present) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * join/leave のたびに呼び、present な参加者数に応じてタイマーを
   * 起動・解除する。
   *
   * - 2人以上 present: タイマーが動いていれば解除する（不在状態の解消）
   * - 1人以下 present: タイマーが未起動なら起動する（継続時間はリセットしない。
   *   「1人以下の状態が続いた時間」を計測するため、既に起動中なら何もしない）
   */
  private refreshAutoEndTimer(room: Room): void {
    if (room.status === "ended") {
      return;
    }

    const presentCount = this.countPresent(room);

    if (presentCount > 1) {
      this.clearAutoEndTimer(room);
      return;
    }

    if (room.autoEndTimer) {
      return;
    }

    room.soloSinceAt = Date.now();
    room.autoEndTimer = setTimeout(() => {
      room.autoEndTimer = null;
      const ended = this.endRoom(room.roomId, "auto_timeout");
      if (ended) {
        this.onAutoEnd?.(ended);
      }
    }, this.autoEndThresholdMs);
    // 既定10分のタイマーがプロセス終了（テストのjest workerや通常のシャットダウン）を
    // ブロックしないようにする（utteranceBuffer.ts のタイマーは短命だが、こちらは
    // 不在復帰まで長時間張られうるため明示的に unref する）。
    room.autoEndTimer.unref?.();
  }

  private clearAutoEndTimer(room: Room): void {
    if (room.autoEndTimer) {
      clearTimeout(room.autoEndTimer);
      room.autoEndTimer = null;
    }
    room.soloSinceAt = null;
  }
}
