---
description: Chrome拡張機能（Manifest V3）のE2Eテストにおける重要な制約と落とし穴。自動テスト不可能な領域が存在する。
paths:
  - "**/manifest.json"
  - "**/manifest.test.json"
  - "**/service-worker.ts"
  - "**/service-worker.js"
  - "**/popup.html"
  - "**/popup.ts"
  - "**/popup.tsx"
  - "**/content.ts"
  - "**/content.js"
  - "**/*.e2e.ts"
  - "**/*.e2e.js"
---

# Chrome拡張機能 E2Eテスト — 重要な制約

**注意: この知見は2026年4月時点のもの。Playwright/Puppeteer/Chrome APIは進化が速いため、最新バージョンでは解消されている制約がある可能性がある。実装時にはツールの最新ドキュメントも確認すること。**

## 自動テスト不可能な領域

1. **tabCapture API** — ユーザージェスチャー（アイコンクリック、ショートカット）でのみ動作。Playwright/Puppeteerからシミュレート不可
2. **ブラウザUIの操作** — ツールバーアイコンのクリック、ショートカットキーはプログラムから不可
3. **activeTab権限** — PopupをURL直接アクセスで開くと付与されない

## 設計・実装上の必須対策

- **テスト用manifest.json** を用意し、`activeTab` → `host_permissions: ["<all_urls>"]` に差し替える
- **chrome.tabs.queryのフォールバック** — Popupをタブとして開くとactiveTabが自分自身を返す。URLフィルタで対象タブを検索するフォールバック必須
- **tabCapture失敗時の部分成功フロー** — tabCaptureが失敗してもフローが止まらないよう `.catch()` で部分成功パスを実装
- **Service Workerのメッセージ振り分け** — Offscreen Document宛メッセージがService Workerで横取りされる問題に注意

## テストツール推奨

- **Playwright** を推奨（Puppeteerより優位）
  - `context.serviceWorkers()` でService Worker即取得
  - `serviceWorker.evaluate()` で直接コード実行可能
  - 公式に拡張機能テストガイドあり

## 詳細手順

具体的な実装手順・コード例は `references/chrome-extension-e2e-test-guide.md` を参照。
