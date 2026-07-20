/**
 * ゲスト識別JWT（`gtt_guest` クッキーの中身）の発行・検証。
 *
 * Next.js（middleware/Server Component/Route Handler、Edge Runtime含む）と
 * 自前WSサーバー（Node.js）の両方から参照される（docs/design/overview.md D-5、
 * docs/design/security-design.md「ゲスト認証（ゲストクッキー）」参照）。
 *
 * 依存は jose のみ（`shared/` の制約。Node組み込み `node:crypto` 等は使わない）。
 * クッキーの読み書き（Set-Cookie / Cookie ヘッダの生成・パース）は呼び出し側の
 * 責務とし、本モジュールでは扱わない（クッキー名の定数のみ export する）。
 */
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { z } from "zod";

/** ゲスト識別クッキーの名前（`sb-*` と衝突しない専用名）。 */
export const GUEST_COOKIE_NAME = "gtt_guest";

/**
 * トークンの有効期限（秒）の既定値。
 * ルームのライフサイクル（作成から24〜48時間程度の利用を想定）に合わせ、
 * 安全側に倒して7日（604800秒）とする
 * （docs/design/security-design.md「有効期限はルームのライフサイクルに合わせる」）。
 */
export const DEFAULT_GUEST_TOKEN_TTL_SEC = 60 * 60 * 24 * 7;

/** HS256 の鍵として推奨される最低バイト数（256bit = 32byte）。 */
const MIN_SECRET_BYTE_LENGTH = 32;

/** ゲストトークンのペイロード形式。 */
export interface GuestTokenPayload {
  roomId: string;
  participantId: string;
}

/** ペイロードのランタイム検証スキーマ（JWT検証後の型保証に使用）。 */
const guestTokenPayloadSchema = z.object({
  roomId: z.string().min(1),
  participantId: z.string().min(1),
});

/**
 * `GUEST_COOKIE_SECRET` を読み込み、HS256 署名鍵としてエンコードする。
 *
 * - 未設定時は明確なエラーを投げる（起動時に気づけるように。実行時に
 *   毎回参照するため、Next.js/WSサーバーどちらでも未設定は即座に検出できる）。
 * - HS256 は鍵長に強度が依存するため、32バイト未満の鍵は拒否する
 *   （RFC 7518 の HS256 推奨最小鍵長 = ハッシュ出力長と同じ256bit）。
 */
function loadSecretKey(): Uint8Array {
  const secret = process.env.GUEST_COOKIE_SECRET;
  if (!secret) {
    throw new Error(
      "GUEST_COOKIE_SECRET が未設定です。ゲストトークンの署名/検証には共有シークレットが必要です。"
    );
  }
  const encoded = new TextEncoder().encode(secret);
  if (encoded.byteLength < MIN_SECRET_BYTE_LENGTH) {
    throw new Error(
      `GUEST_COOKIE_SECRET は最低 ${MIN_SECRET_BYTE_LENGTH} バイト以上にしてください（HS256の推奨鍵長）。`
    );
  }
  return encoded;
}

export interface SignGuestTokenOptions {
  /** 有効期限（秒）。未指定時は `DEFAULT_GUEST_TOKEN_TTL_SEC`。 */
  expSec?: number;
}

/**
 * ゲスト識別JWTを発行する。
 *
 * @throws `GUEST_COOKIE_SECRET` が未設定/鍵長不足の場合（呼び出し側で捕捉しない限り伝播する）。
 */
export async function signGuestToken(
  payload: GuestTokenPayload,
  options: SignGuestTokenOptions = {}
): Promise<string> {
  const secretKey = loadSecretKey();
  const expSec = options.expSec ?? DEFAULT_GUEST_TOKEN_TTL_SEC;

  return new SignJWT({ roomId: payload.roomId, participantId: payload.participantId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expSec}s`)
    .sign(secretKey);
}

/**
 * ゲスト識別JWTを検証する。
 *
 * 期限切れ・署名不正・ペイロード形式不正は**すべて null を返す**（例外を
 * 漏らさない）。呼び出し側は null を「ゲスト未識別」として扱える。
 * 失敗理由はサーバーログに出すが、トークン本文・秘密鍵は含めない。
 *
 * `GUEST_COOKIE_SECRET` 自体が未設定/鍵長不足の場合は設定不備であり、
 * トークンの正当性とは別問題のため例外を再送出する（起動時に気づけるように）。
 */
export async function verifyGuestToken(token: string): Promise<GuestTokenPayload | null> {
  const secretKey = loadSecretKey();

  let payload: JWTPayload;
  try {
    // 受理するアルゴリズムを発行側と同じ HS256 に固定する（alg混同攻撃への多層防御。
    // 未指定だと対称鍵に対して HS384/HS512 も受理される）。
    const result = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    payload = result.payload;
  } catch (err) {
    console.error(
      "[guestToken] verifyGuestToken failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return null;
  }

  const parsed = guestTokenPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("[guestToken] verifyGuestToken failed: invalid payload shape");
    return null;
  }

  return { roomId: parsed.data.roomId, participantId: parsed.data.participantId };
}
