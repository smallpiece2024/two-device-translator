/**
 * shared/ は src/（Next.js）と server/（自前WSサーバー）の両方から参照される共通レイヤ。
 * 依存は zod・jose のみに限定する（Node組み込みAPI・Next.js専用APIに依存させない）。
 *
 * このファイルは雛形段階のプレースホルダ。実装が進むにつれて
 * ws-protocol/schema.ts, ws-protocol/types.ts, auth/guestToken.ts, languages.ts 等に分割する。
 * `@shared/*` パスエイリアス経由で import できることを確認するためのエクスポート。
 */

export const SHARED_PLACEHOLDER = "shared" as const;
