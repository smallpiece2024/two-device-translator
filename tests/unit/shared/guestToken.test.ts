/**
 * shared/auth/guestToken.ts の単体テスト。
 *
 * ゲスト識別JWT（`gtt_guest` クッキー）の発行(signGuestToken)・検証(verifyGuestToken)を対象に、
 * 正常系・期限切れ・改ざん検知・形式不正・alg混同耐性・設定不備（鍵長境界値含む）を検証する。
 *
 * 時刻依存はすべて jose の `exp`/`expSec` 指定で制御し、実時間の sleep は使わない
 * （フレイキー防止）。
 *
 * @see shared/auth/guestToken.ts
 */
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import {
  signGuestToken,
  verifyGuestToken,
  GUEST_COOKIE_NAME,
  DEFAULT_GUEST_TOKEN_TTL_SEC,
} from "@shared/auth/guestToken";

// ---------------------------------------------------------------------------
// テストヘルパー
// ---------------------------------------------------------------------------

/** テストで使う32バイト以上の正規シークレット（境界値ちょうど32バイトのASCII文字列）。 */
const VALID_SECRET_32B = "a".repeat(32);
/** 正規シークレットとは異なる別鍵（改ざん検知テスト用、32バイト以上）。 */
const OTHER_SECRET_32B = "b".repeat(32);
/** 境界値: 31バイト（不足）のシークレット。 */
const SHORT_SECRET_31B = "a".repeat(31);

const ORIGINAL_SECRET = process.env.GUEST_COOKIE_SECRET;

function setSecret(secret: string | undefined): void {
  if (secret === undefined) {
    delete process.env.GUEST_COOKIE_SECRET;
  } else {
    process.env.GUEST_COOKIE_SECRET = secret;
  }
}

beforeEach(() => {
  setSecret(VALID_SECRET_32B);
});

afterEach(() => {
  setSecret(ORIGINAL_SECRET);
});

const VALID_PAYLOAD = { roomId: "room-1", participantId: "participant-1" };

/**
 * base64url文字列（パディング無し）をBufferにデコードする。
 */
function base64UrlToBuffer(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

/**
 * Bufferをbase64url文字列（パディング無し）にエンコードする。
 */
function bufferToBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * base64url文字列の先頭バイトをビット反転（XOR 0xFF）して再エンコードする。
 *
 * 末尾1文字だけを別の文字に置換する方式は、base64が3バイト単位でエンコード
 * されるため flaky になり得る: 署名バイト長が3の倍数でない場合、最終文字は
 * 「パディング用の余剰ビット」を含み、そのビットのみを変化させても
 * デコード結果（実バイト列）が変わらないことがある
 * （例: 32バイトのHMAC-SHA256署名は 10*3+2 バイトで、最終グループの
 * 3文字目は下位2bitが常に0のパディングとしてデコード時に切り捨てられる。
 * そのビットだけをトグルする置換では改ざんが成立せず、偶発的に
 * verify が成功してテストが落ちていた）。
 * 先頭バイトへの操作であれば常に実データビットに対応するため、
 * バイト長や剰余に関わらず決定的にデコード結果を変える。
 */
function tamperFirstByte(base64UrlSignature: string): string {
  const bytes = base64UrlToBuffer(base64UrlSignature);
  if (bytes.length === 0) {
    return "tampered";
  }
  const tampered = Buffer.from(bytes);
  tampered[0] = tampered[0] ^ 0xff;
  return bufferToBase64Url(tampered);
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
describe("定数", () => {
  it("GUEST_COOKIE_NAME は gtt_guest である", () => {
    expect(GUEST_COOKIE_NAME).toBe("gtt_guest");
  });

  it("DEFAULT_GUEST_TOKEN_TTL_SEC は7日（604800秒）である", () => {
    expect(DEFAULT_GUEST_TOKEN_TTL_SEC).toBe(604800);
  });
});

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------
describe("signGuestToken / verifyGuestToken — 正常系", () => {
  it("発行したトークンを検証すると、payload（roomId/participantId）が往復する", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const result = await verifyGuestToken(token);

    expect(result).toEqual(VALID_PAYLOAD);
  });

  it("発行したトークンには exp/iat が付与される", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const decoded = decodeJwt(token);

    expect(typeof decoded.exp).toBe("number");
    expect(typeof decoded.iat).toBe("number");
    expect(decoded.exp as number).toBeGreaterThan(decoded.iat as number);
  });

  it("expSec指定時、exp - iat が指定値と一致する", async () => {
    const expSec = 3600;
    const token = await signGuestToken(VALID_PAYLOAD, { expSec });
    const decoded = decodeJwt(token);

    expect((decoded.exp as number) - (decoded.iat as number)).toBe(expSec);
  });

  it("expSec未指定時、exp - iat が DEFAULT_GUEST_TOKEN_TTL_SEC と一致する", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const decoded = decodeJwt(token);

    expect((decoded.exp as number) - (decoded.iat as number)).toBe(DEFAULT_GUEST_TOKEN_TTL_SEC);
  });

  it("HS256で署名される（ヘッダのalgを確認）", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const header = decodeProtectedHeader(token);

    expect(header.alg).toBe("HS256");
  });
});

// ---------------------------------------------------------------------------
// 期限切れ
// ---------------------------------------------------------------------------
describe("verifyGuestToken — 期限切れ", () => {
  it("expSecに負値を指定して発行した（既に期限切れの）トークンはnullになる", async () => {
    const token = await signGuestToken(VALID_PAYLOAD, { expSec: -10 });
    const result = await verifyGuestToken(token);

    expect(result).toBeNull();
  });

  it("expSecに0を指定して発行したトークンはnullになる（jwtVerifyはexp<=nowを拒否）", async () => {
    const token = await signGuestToken(VALID_PAYLOAD, { expSec: 0 });
    const result = await verifyGuestToken(token);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 改ざん検知
// ---------------------------------------------------------------------------
describe("verifyGuestToken — 改ざん検知", () => {
  it("署名部分を書き換えたトークンはnullになる", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const parts = token.split(".");
    // 署名部分（3番目）の生バイト列の先頭バイトをビット反転して再エンコードし、
    // 常にデコード後のバイト列が変わる（=確実に検証が失敗する）ようにする
    // （詳細は tamperFirstByte のコメントを参照）。
    const tamperedSignature = tamperFirstByte(parts[2]);
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

    const result = await verifyGuestToken(tampered);

    expect(result).toBeNull();
  });

  it("別の鍵で署名した正しい形式のトークンはnullになる（鍵不一致）", async () => {
    setSecret(OTHER_SECRET_32B);
    const tokenSignedWithOtherKey = await signGuestToken(VALID_PAYLOAD);
    setSecret(VALID_SECRET_32B);

    const result = await verifyGuestToken(tokenSignedWithOtherKey);

    expect(result).toBeNull();
  });

  it("ペイロードを書き換え署名はそのままにしたトークンはnullになる", async () => {
    const token = await signGuestToken(VALID_PAYLOAD);
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...VALID_PAYLOAD, roomId: "room-hacked" }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const result = await verifyGuestToken(tampered);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 形式不正
// ---------------------------------------------------------------------------
describe("verifyGuestToken — 形式不正", () => {
  it("空文字はnullになる", async () => {
    const result = await verifyGuestToken("");
    expect(result).toBeNull();
  });

  it("JWT形式でないランダム文字列はnullになる", async () => {
    const result = await verifyGuestToken("not-a-jwt-token-at-all");
    expect(result).toBeNull();
  });

  it("ドット区切りが不足したトークンはnullになる", async () => {
    const result = await verifyGuestToken("header.payload");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ペイロード形式不正（zod検証）
// ---------------------------------------------------------------------------
describe("verifyGuestToken — ペイロード形式不正（正しい鍵で署名済み）", () => {
  it("roomIdが欠落したペイロードのトークンはnullになる", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET_32B);
    const token = await new SignJWT({ participantId: "participant-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);

    const result = await verifyGuestToken(token);
    expect(result).toBeNull();
  });

  it("participantIdが欠落したペイロードのトークンはnullになる", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET_32B);
    const token = await new SignJWT({ roomId: "room-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);

    const result = await verifyGuestToken(token);
    expect(result).toBeNull();
  });

  it("roomIdが数値（型不正）のトークンはnullになる", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET_32B);
    const token = await new SignJWT({ roomId: 12345, participantId: "participant-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);

    const result = await verifyGuestToken(token);
    expect(result).toBeNull();
  });

  it("roomIdが空文字（min(1)違反）のトークンはnullになる", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET_32B);
    const token = await new SignJWT({ roomId: "", participantId: "participant-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);

    const result = await verifyGuestToken(token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// alg混同への耐性
// ---------------------------------------------------------------------------
describe("verifyGuestToken — alg混同への耐性", () => {
  it("alg: \"none\" で署名なしのトークンはnullになる（jose/jwtVerifyがalg指定なし時にnoneを拒否する実装であることの確認）", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ ...VALID_PAYLOAD, iat: nowSec, exp: nowSec + 3600 }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const noneToken = `${header}.${payload}.`;

    const result = await verifyGuestToken(noneToken);
    expect(result).toBeNull();
  });

  // algorithms: ["HS256"] 指定の回帰ガード。
  // 同じ鍵で正規に HS384/HS512 署名しても、jwtVerify に algorithms: ["HS256"] を
  // 指定していれば alg 不一致で拒否される。この指定を外すと（対称鍵はどのHS*でも
  // 検証できてしまうため）HS384/HS512 が受理されてこのテストが落ちる。
  it.each([
    ["HS384", 48] as const,
    ["HS512", 64] as const,
  ])(
    "algorithms制約の回帰ガード: 同じ鍵で%sで正規署名したトークンはnullになる（HS256以外は拒否される）",
    async (alg, keyByteLength) => {
      const secret = "k".repeat(keyByteLength);
      setSecret(secret);
      const secretKey = new TextEncoder().encode(secret);

      const token = await new SignJWT(VALID_PAYLOAD)
        .setProtectedHeader({ alg })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secretKey);

      const result = await verifyGuestToken(token);
      expect(result).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// 余剰フィールドの許容（zod非strictの現仕様）
// ---------------------------------------------------------------------------
describe("verifyGuestToken — 余剰フィールドを含むペイロード（zod非strictの現仕様）", () => {
  it("roomId/participantId以外の余剰フィールドがあっても、guestTokenPayloadSchemaは非strictのため許容し、指定した2フィールドのみ返す", async () => {
    const secretKey = new TextEncoder().encode(VALID_SECRET_32B);
    const token = await new SignJWT({ ...VALID_PAYLOAD, role: "guest", extra: 123 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);

    const result = await verifyGuestToken(token);

    expect(result).toEqual(VALID_PAYLOAD);
  });
});

// ---------------------------------------------------------------------------
// 設定不備（GUEST_COOKIE_SECRET）
// ---------------------------------------------------------------------------
describe("signGuestToken / verifyGuestToken — GUEST_COOKIE_SECRET の設定不備", () => {
  it("GUEST_COOKIE_SECRET未設定時、signGuestTokenは例外を投げる", async () => {
    setSecret(undefined);

    await expect(signGuestToken(VALID_PAYLOAD)).rejects.toThrow();
  });

  it("GUEST_COOKIE_SECRET未設定時、verifyGuestTokenは例外を投げる", async () => {
    setSecret(undefined);

    await expect(verifyGuestToken("dummy.token.value")).rejects.toThrow();
  });

  it("境界値: 31バイトの鍵ではsignGuestTokenが例外を投げる", async () => {
    setSecret(SHORT_SECRET_31B);

    await expect(signGuestToken(VALID_PAYLOAD)).rejects.toThrow();
  });

  it("境界値: 31バイトの鍵ではverifyGuestTokenが例外を投げる", async () => {
    setSecret(SHORT_SECRET_31B);

    await expect(verifyGuestToken("dummy.token.value")).rejects.toThrow();
  });

  it("境界値: 32バイトちょうどの鍵ではsignGuestToken/verifyGuestTokenともに成功する", async () => {
    setSecret(VALID_SECRET_32B);

    const token = await signGuestToken(VALID_PAYLOAD);
    const result = await verifyGuestToken(token);

    expect(result).toEqual(VALID_PAYLOAD);
  });
});
