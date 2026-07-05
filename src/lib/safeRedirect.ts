/**
 * ログイン/OAuthコールバック後のリダイレクト先として安全なパスかどうかを
 * 検証し、安全なパス文字列を返す。
 *
 * オープンリダイレクト対策として、`redirect` クエリパラメータ由来の文字列を
 * そのまま `router.push` / `NextResponse.redirect` へ渡さないために使用する。
 *
 * 検証は**ホワイトリスト方式**（許可する文字・形式のみを正規表現で列挙し、
 * 一致しないものはすべて拒否）で行う。禁止プレフィックスの列挙
 * （ブラックリスト方式、例: `startsWith("//")` の否定）は採用しない。
 * 理由: WHATWGのURLパーサはタブ・CR・LF等の制御文字を位置に関わらず
 * 除去してから解釈するため、`"/\t/evil.com"` のような文字列は
 * `startsWith("//")` チェックをすり抜けた後、`new URL()` に渡された時点で
 * `//evil.com`（プロトコル相対URL）へ正規化され外部ドメインへの
 * オープンリダイレクトを許してしまう
 * （実証: `new URL("/\t/evil.com", "https://example.com")` → `https://evil.com/`）。
 * ホワイトリストでは制御文字・空白・バックスラッシュ自体を許可文字集合に
 * 含めないため、この種のパーサ正規化を利用したバイパスが構造的に発生しない。
 *
 * 許可する形式（正規表現）:
 * `^\/(?!\/|\\)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$`
 * - 先頭が `/` であること
 * - 2文字目が `/` または `\` でないこと（プロトコル相対URL化を防ぐ）
 * - 残りの文字は RFC 3986 の pchar 相当（英数字・`-._~!$&'()*+,;=:@%/?`）
 *   のみで構成されること（制御文字・空白・タブ・改行・バックスラッシュ・
 *   全角文字等は一切許可しない）
 *
 * 拒否される例: `https://evil.com`, `//evil.com`, `/\evil.com`,
 * `"/\t/evil.com"`（タブを含む）, `"/foo\nbar"`（改行を含む）, `""`, `null`
 *
 * 条件を満たさない場合は `fallback`（デフォルト `/rooms`）を返す。
 *
 * @see docs/design/security-design.md
 */
const SAFE_REDIRECT_PATTERN = /^\/(?!\/|\\)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

export function resolveSafeRedirect(
  redirect: string | null | undefined,
  fallback = "/rooms"
): string {
  if (!redirect) {
    return fallback;
  }

  if (!SAFE_REDIRECT_PATTERN.test(redirect)) {
    return fallback;
  }

  return redirect;
}
