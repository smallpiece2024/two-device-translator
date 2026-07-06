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
 * bd-gz1 で以下を追加した（FR-12.3、docs/design/server-design.md
 * 「実装確定事項（bd-gz1 で追加: endedルームの再開）」参照）:
 * - ended ルームの再開: 検証済みオーナーが ended ルームへ再 join した場合、
 *   `reopenRoom()` でルームを active に戻す（追加のプロトコルメッセージは
 *   作らない。guest の ended ルームへの join は従来どおり拒否する）
 * - ended ルームの TTL クリーンアップ: 再 join 案内・オーナー再開のために
 *   ended ルームをレジストリに残し続けると無期限に溜まるため、
 *   `endedRoomTtlMs`（既定30分）経過で `destroyRoom()` する
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

/** ルームの状態（"ended" になったルームへの再joinは、オーナーであれば再開する） */
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
   * `reopenRoom()`（bd-gz1）実行時に null へ戻す。
   */
  endedReason: RoomEndedReason | null;
  /**
   * ended ルームの TTL クリーンアップ用タイマー（bd-gz1）。`endRoom()` 実行時に
   * 起動し、`endedRoomTtlMs`（既定30分）経過でレジストリから `destroyRoom()`
   * する。オーナーの再joinで再開（`reopenRoom()`）した場合、または
   * `destroyRoom()` 実行時にクリアする。null は非稼働中
   * （active ルーム、または再開済みルーム）。
   */
  endedRoomTtlTimer: ReturnType<typeof setTimeout> | null;
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
      /**
       * このjoinによって ended 状態から再開された場合 true（bd-gz1、FR-12.3）。
       * 検証済みオーナーの ended ルームへの再joinのみで起こりうる
       * （guest は ended ルームへの join を拒否されるため対象外）。
       * `server/index.ts` はこれが true のとき DB `rooms.status` を
       * `'active'` に戻す（`markRoomActive`、fire-and-forget）。
       */
      reopened: boolean;
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
  /**
   * ended ルームの TTL（ms）。既定30分（`DEFAULT_ENDED_ROOM_TTL_MS`）。
   * ended ルームは「再join案内・オーナー再開」のためレジストリに残すが、
   * 無期限に溜めないよう、この時間経過後にレジストリから破棄する
   * （bd-gz1、docs/design/server-design.md
   * 「実装確定事項（bd-gz1 で追加: endedルームの再開）」参照）。
   * 環境変数での上書きは `server/index.ts` 側で解決する。
   */
  endedRoomTtlMs?: number;
}

const DEFAULT_MAX_PARTICIPANTS = 2;

/** 不在自動終了の既定しきい値（10分）。根拠は `RoomManagerOptions.autoEndThresholdMs` 参照 */
export const DEFAULT_AUTO_END_THRESHOLD_MS = 10 * 60 * 1000;

/** ended ルームの既定 TTL（30分）。根拠は `RoomManagerOptions.endedRoomTtlMs` 参照 */
export const DEFAULT_ENDED_ROOM_TTL_MS = 30 * 60 * 1000;

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
  private readonly endedRoomTtlMs: number;

  constructor(options: RoomManagerOptions = {}) {
    this.maxParticipants = options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    this.autoEndThresholdMs = options.autoEndThresholdMs ?? DEFAULT_AUTO_END_THRESHOLD_MS;
    this.onAutoEnd = options.onAutoEnd;
    this.endedRoomTtlMs = options.endedRoomTtlMs ?? DEFAULT_ENDED_ROOM_TTL_MS;
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
      endedRoomTtlTimer: null,
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
   * - ルームが `ended` の場合:
   *   - `identity.role === "owner"` なら `reopenRoom()` でルームを active に
   *     戻したうえで、以下の通常の join 処理を続行する（FR-12.3・bd-gz1。
   *     「オーナーが再入室し再度QRで招待すると再開できる」に対応する。
   *     追加のプロトコルメッセージは作らず、検証済みオーナーによる ended
   *     ルームへの再 join そのものを再開トリガーとする）
   *   - guest なら従来どおり拒否する（endedReason を返し、呼び出し側が
   *     `room_ended` 案内＋close する）
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
    let reopened = false;

    if (room.status === "ended") {
      if (identity.role !== "owner") {
        // endedReason は endRoom() 実行時に必ず設定されるが、万一 null の場合に
        // 備え防御的にフォールバックする（型上 non-null を強制しないための保険）。
        return {
          ok: false,
          reason: "room has already ended",
          endedReason: room.endedReason ?? "auto_timeout",
        };
      }

      // オーナーの ended ルームへの再join → 再開（FR-12.3、bd-gz1）。
      // 以降は通常の join 処理（既存参加者の再接続 or 新規参加）に合流する。
      this.reopenRoom(room);
      reopened = true;
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

      return { ok: true, room, session: existing, reconnected: true, previousSocket, reopened };
    }

    if (room.participants.size >= this.maxParticipants) {
      return { ok: false, reason: "room is full" };
    }

    const session = new Session(identity, ws, options);
    room.participants.set(session.participantId, session);

    this.refreshAutoEndTimer(room);

    return { ok: true, room, session, reconnected: false, previousSocket: null, reopened };
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
   * ただし無期限には残さず、`endedRoomTtlMs`（既定30分、bd-gz1）経過後に
   * `destroyRoom()` する（下記タイマー起動）。
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
    this.startEndedRoomTtlTimer(room);

    return room;
  }

  /** ルームを破棄する（レジストリから完全に削除する。主にテスト・明示的なクリーンアップ用） */
  destroyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      this.clearAutoEndTimer(room);
      this.clearEndedRoomTtlTimer(room);
    }
    this.rooms.delete(roomId);
  }

  /** 現在保持しているルーム数（テスト・監視用） */
  get roomCount(): number {
    return this.rooms.size;
  }

  // ----------------------------------------------------------
  // プライベート: ended ルームの再開・TTLクリーンアップ（bd-gz1）
  // ----------------------------------------------------------

  /**
   * ended ルームをオーナーの再joinにより再開する（FR-12.3、bd-gz1）。
   * `status` を `"active"` に戻し `endedReason` をクリアし、ended-room TTL
   * タイマーを解除する。呼び出し後は通常の join 処理（既存参加者の
   * 再接続 or 新規参加）を続行する（`join()` 内から呼ぶ想定）。
   *
   * サーバー再起動後（メモリにルームが存在しない）のオーナー再joinは、
   * `getOrCreateRoom()` が新規 Room（status="active"）を作るため、この
   * メソッドを経由せず自然に「新規作成」扱いになる。その場合の DB 側の
   * 再開（`rooms.status` を `'active'` に戻す）は `server/index.ts` が
   * join 成功パス（オーナーのみ）で毎回 `markRoomActive` を呼ぶことで
   * 整合させる（DBが `ended` のときのみ更新が意味を持つが、条件分岐の
   * ためだけに読み取りを増やすコストを避け、無条件の UPSERT 的更新で
   * 対応する。既に `active` な行への同一更新は無害）。
   */
  private reopenRoom(room: Room): void {
    room.status = "active";
    room.endedReason = null;
    this.clearEndedRoomTtlTimer(room);

    // 旧参加者エントリを全クリアする（コードレビュー指摘 should-fix1）。
    //
    // 背景: ended ルームは `finalizeRoomEnd()`（`server/index.ts`）が全参加者へ
    // `room_ended` を配信しソケットを close 済みの状態であり、それに伴う
    // `ws.on("close")` → `RoomManager.leave()` により、この時点で全参加者は
    // 既に `present=false`（`AUTH_MODE=insecure` では Map から削除済み）に
    // なっている。すなわち participants Map に残っているのは「不在中の旧参加者
    // エントリ」のみであり、クリアしても在室者を追い出すことにはならない。
    //
    // クリアしない場合の不具合: 「終了→再開→**別の新しいゲスト**を招待」という
    // FR-12.3 のユースケースで、旧ゲストの present=false エントリが
    // `maxParticipants`（既定2）の枠を占有し続け、新ゲストの join が
    // "room is full" で拒否されてしまう。
    //
    // クリアしても安全な理由: `participantId` は owner/guest とも DB 行由来の
    // 安定ID（owner は `participants.id`（room_id+user_id+role='owner'）、guest は
    // ゲストクッキーJWTの payload 由来。`server/auth/verifyParticipant.ts` 参照）
    // であり、接続のたびに再生成されるものではない。そのため旧ゲスト（同じ
    // クッキーを保持）が再 join した場合も、クリア後の「新規参加」として
    // 同一 participantId で復帰でき、履歴上の話者同一性は保たれる
    // （オーナー自身の再 join も同様に「新規参加」として扱われる）。
    room.participants.clear();
  }

  /**
   * ended ルームの TTL クリーンアップタイマーを起動する（`endRoom()` から呼ぶ）。
   * `endedRoomTtlMs` 経過でレジストリから `destroyRoom()` する。
   * TTL 経過後にオーナーが join した場合は「メモリにルームなし」の新規作成
   * パスに乗り、DB 側の `markRoomActive` により再開が成立する
   * （`reopenRoom()` のコメント参照）。
   */
  private startEndedRoomTtlTimer(room: Room): void {
    room.endedRoomTtlTimer = setTimeout(() => {
      room.endedRoomTtlTimer = null;
      this.destroyRoom(room.roomId);
    }, this.endedRoomTtlMs);
    // 既定30分のタイマーがプロセス終了（テストのjest workerや通常のシャットダウン）を
    // ブロックしないようにする（既存の autoEndTimer と同じ流儀）。
    room.endedRoomTtlTimer.unref?.();
  }

  private clearEndedRoomTtlTimer(room: Room): void {
    if (room.endedRoomTtlTimer) {
      clearTimeout(room.endedRoomTtlTimer);
      room.endedRoomTtlTimer = null;
    }
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
