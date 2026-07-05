/**
 * Jest グローバルセットアップ。
 *
 * `jest-environment-jsdom` は `TextEncoder`/`TextDecoder` をグローバルに
 * 提供しないため、jose（`shared/auth/guestToken.ts` が使用）を jsdom
 * 環境のテストで import すると `TextEncoder is not defined` で失敗する。
 * Node の `node:util` 実装をポリフィルとして注入する（testEnvironment: "node"
 * では既にグローバルに存在するため上書きしない）。
 */
const { TextEncoder, TextDecoder } = require("node:util");

if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecoder;
}
