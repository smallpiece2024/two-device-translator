---
description: Next.js middleware.tsとEdge Runtimeの制約。middleware.tsではNode.js専用ライブラリが使えない。joseライブラリを使用し、E2Eテストで検証すること。
paths:
  - "**/middleware.ts"
  - "**/middleware.js"
---

# Next.js middleware.ts と Edge Runtime の制約

## 適用条件
- Next.js（App Router）を使用している
- `middleware.ts` でJWT検証やセッション管理などを行う

## 制約・注意点

### middleware.ts では Node.js 専用ライブラリを使用できない
- `middleware.ts` は **Edge Runtime** で実行される（Node.jsランタイムではない）
- Edge Runtime では Node.js の `crypto`, `buffer`, `fs` 等のモジュールが使えない
- 以下のライブラリは middleware.ts で使用禁止:
  - `jsonwebtoken`（内部で `crypto` を使用）
  - `bcrypt` / `bcryptjs`
  - その他 Node.js API に依存するライブラリ

### 使い分けの原則
```
middleware.ts  = Edge Runtime = Web標準APIのみ使用可
route.ts       = Node.js      = Node.js専用ライブラリも使用可
```

### エラーがサイレントに握りつぶされる危険
- `try-catch` で例外を握りつぶすと、Edge Runtime 非互換のエラーが一切ログに出ない
- 結果として「なぜか認証が通らない」等の原因不明な症状になる
- catch 節では最低限 `console.error` でエラー内容を出力すること

## 対策

### JWT検証はjoseライブラリを使用する
- `jose` は Web Crypto API ベースのため Edge Runtime で動作する
- `npm install jose`
- middleware.ts では `jwtVerify`（jose）、route.ts では `jwt.verify`（jsonwebtoken）と使い分ける

### テスト戦略
- ミドルウェアの動作確認はモックテストだけでは不十分
- 実際に Next.js サーバーを起動し、HTTP リクエストを送る E2E テスト（Playwright等）で検証すること
- 特に「認証済み状態で保護ページにアクセスしてリダイレクトされないこと」を実サーバー経由で検証する

## 背景
middleware.ts で `jsonwebtoken` を使ったところ、Edge Runtime で `crypto` モジュールが存在せず例外が発生した。しかし `verifyToken` 関数の catch 節が例外を握りつぶして null を返していたため、全てのJWT検証が常に失敗し、ログイン後も必ず /login にリダイレクトされるという症状が発生した。ユニットテストではモックを使っていたためこの問題を検出できず、Playwright によるブラウザ検証で初めてサーバー側の問題と切り分けできた。
