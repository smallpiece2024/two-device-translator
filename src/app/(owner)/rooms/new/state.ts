/**
 * ルーム作成 Server Action の状態型と初期値。
 *
 * `actions.ts` は `"use server"` ファイルであり、Next.js の本番ランタイムは
 * 「async 関数以外の export」を禁止する（違反するとモジュール読込時に
 * ページ全体がクラッシュする。bd-2el で本番実機にて発覚）。そのため
 * `useActionState` に渡す初期値オブジェクトと型は、この別モジュールに置く。
 *
 * @see tests/unit/use-server-exports.test.ts（静的ガード）
 * @see docs/design/app-architecture.md（Server Action の設計制約）
 */
export interface CreateRoomState {
  error: string | null;
}

export const initialCreateRoomState: CreateRoomState = { error: null };
