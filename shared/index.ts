/**
 * shared/ は src/（Next.js）と server/（自前WSサーバー）の両方から参照される共通レイヤ。
 * 依存は zod・jose のみに限定する（Node組み込みAPI・Next.js専用APIに依存させない）。
 *
 * `@shared/*` パスエイリアス経由で import できることを確認するためのエクスポート。
 */

export * from "./ws-protocol/schema";
export * from "./ws-protocol/types";
export * from "./languages/registry";

/** @deprecated 雛形段階のプレースホルダ。`@shared/index` の解決確認用に残置。 */
export const SHARED_PLACEHOLDER = "shared" as const;
