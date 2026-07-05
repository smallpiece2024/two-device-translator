---
name: dev-task
description: 単一のBeadsタスクに対して、ブランチ作成→実装→コードレビュー→テスト→マージの開発パイプラインを実行する。
argument-hint: "<beads-task-id>"
user-invocable: true
---

# タスク開発パイプライン

引数で受け取ったBeadsタスクID: $ARGUMENTS に対して、以下のパイプラインを順番に実行する。

> **⚠️ 絶対厳守: テストステップ(4〜7)の省略禁止**
> - ステップ4〜7は**いかなる理由があっても省略してはならない**
> - 「簡単な変更」「UIだけ」「設定変更だけ」であっても必ずテストを実施する
> - 「`npm run dev`で確認してください」等、ユーザーへの手動テスト委任は禁止
> - テストジャッジがOKを出すまでステップ8には絶対に進まない

## ステップ1: 準備
1. Agent(`git-manager`): devからfeatureブランチを作成 (`feature/bd-{id}`)
2. Agent(`beads-manager`): タスクをオープンし、開始を宣言

## ステップ2: 実装
Agent(`beads-manager`) にタスクの要件を取得させ、タスク内容に応じた実装エンジニアを呼び出す:
- フロントエンド → Agent(`frontend-engineer`)
- バックエンド → Agent(`backend-engineer`)
- DB設計 → Agent(`db-designer`)
- Supabase実装 → Agent(`supabase-specialist`)
- スタイリング → Agent(`web-designer`)
- インフラ → Agent(`infra-engineer`)
- セキュリティ → Agent(`security-specialist`)

フレームワーク固有の判断が必要な場合は、Agent(`nextjs-specialist`) or Agent(`react-vite-specialist`) に相談する。

## ステップ3: コードレビュー
タスク内容に応じたコードレビュアーを呼び出す:
- フロントエンド → Agent(`frontend-code-reviewer`)
- バックエンド → Agent(`backend-code-reviewer`)

レビュアーにはBeadsタスクの要件を渡し、git logベースで変更内容を照合させる。

### レビュー結果の処理
- **OK** → ステップ4へ
- **NG** →
  1. Agent(`beads-manager`): NG理由とNG回数を記録
  2. 2回目のNGまで → ステップ2に戻り再実装
  3. 3回目以降のNG → `/dev-rollback {id}` を実行

## ステップ4: テスト実装 【省略禁止】
タスク内容に応じたテストエンジニアを**必ず**呼び出す:
- フロントエンド → Agent(`frontend-test-engineer`)
- バックエンド → Agent(`backend-test-engineer`)

テストエンジニアには以下を指示する:
- Beadsタスクの要件をカバーする単体テスト・結合テストを作成
- UIを含む場合はコンポーネントテスト（React Testing Library）も作成
- ページ遷移やフォーム送信を含む場合はE2Eテスト（Playwright）も作成
- 正常系と異常系（バリデーションエラー、未認証、空データ等）の両方をカバー

## ステップ5: テストレビュー 【省略禁止】
タスク内容に応じたテストレビュアーを**必ず**呼び出す:
- フロントエンド → Agent(`frontend-test-reviewer`)
- バックエンド → Agent(`backend-test-reviewer`)

- **NG** → ステップ4に戻る

## ステップ6: テスト実行 【省略禁止】
ステップ4と同じテストエンジニアにテスト実行を指示する。テストは実際に`npm test`や`npx playwright test`等で実行し、結果を取得する。「後で実行してください」は禁止。

## ステップ7: テスト結果判定 【省略禁止】
タスク内容に応じたテストジャッジを**必ず**呼び出す:
- フロントエンド → Agent(`frontend-test-judge`)
- バックエンド → Agent(`backend-test-judge`)

### 判定結果の処理
- **OK** → ステップ8へ
- **NG** →
  1. Agent(`beads-manager`): NG理由とNG回数を記録
  2. 2回目のNGまで → ステップ2に戻り再実装
  3. 3回目以降のNG → `/dev-rollback {id}` を実行

## ステップ8: 完了 【テストOK必須】
**ステップ7のテストジャッジがOKを出していない場合、このステップに進んではならない。**

1. Agent(`beads-manager`): タスクをクローズし、終了を宣言
2. Agent(`git-manager`): featureブランチにコミットし、devブランチへマージ
