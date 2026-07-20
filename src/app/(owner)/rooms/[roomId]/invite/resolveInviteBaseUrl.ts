/**
 * 招待URL（`https://{host}/join/{token}`）のベースURL（オリジン）を解決する。
 *
 * **サーバー専用環境変数 `APP_BASE_URL` を最優先で使用する。**
 * `next/headers` の `host` / `x-forwarded-proto` ヘッダは、リバースプロキシ
 * （Caddy/nginx、`docs/design/infra-design.md`）が正規化する前提はあるものの、
 * プロキシ設定の不備やヘッダ偽装（Host Header ポイズニング）が起きた場合、
 * 招待URLに攻撃者の指定したドメインが混入し、招待QR/URLを共有した相手が
 * 偽サイトへ誘導されるおそれがある（招待URLは信頼して他者に共有される値の
 * ため、通常のオープンリダイレクト対策以上に汚染の影響が大きい）。
 * そのため、ヘッダを無条件には信頼せず、`APP_BASE_URL`（サーバー専用、
 * `NEXT_PUBLIC_` を付けない）が設定されていれば常にそちらを正とする。
 *
 * `APP_BASE_URL` が未設定の場合のみ、フォールバックとしてヘッダから
 * 組み立てる（ローカル開発等、環境変数を都度設定しない運用を許容するため）。
 * フォールバック発生時は設定不備に気づけるよう、モジュール読み込み後
 * 最初の1回だけ `console.warn` を出す（リクエストのたびに警告ログが
 * 大量発生することを避ける）。
 */
import { headers } from "next/headers";

let hasWarnedFallback = false;

export async function resolveInviteBaseUrl(): Promise<string> {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (appBaseUrl) {
    return appBaseUrl.replace(/\/+$/, "");
  }

  if (!hasWarnedFallback) {
    hasWarnedFallback = true;
    console.warn(
      "[resolveInviteBaseUrl] APP_BASE_URL が未設定のため、リクエストヘッダ（host / x-forwarded-proto）から招待URLのベースURLを組み立てます。" +
        "本番環境ではリバースプロキシの設定不備やヘッダ偽装により招待URLが汚染されるおそれがあるため、APP_BASE_URL の設定を推奨します。"
    );
  }

  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}
