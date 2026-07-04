# Chrome拡張機能 E2Eテスト ガイド

**この文書は2026年4月時点の知見に基づく。**
**Playwright, Puppeteer, Chrome Extensions API は進化が速いため、実装時には各ツールの最新ドキュメントを必ず確認すること。**
**特に以下の点は将来解消される可能性がある:**
- **tabCapture APIのユーザージェスチャー要件** — Chrome APIの仕様変更で緩和される可能性
- **Playwrightの拡張機能サポート** — 新バージョンでアイコンクリック対応が追加される可能性
- **headlessモードでの拡張機能動作** — Chrome/Playwrightの進化で対応される可能性

---

**推奨**: Playwright + テスト用manifest.json（セクション A）
**代替**: Puppeteer + リモートデバッグポート（セクション B）

---

## A. Playwright を使う方法（推奨）

Playwrightの `launchPersistentContext` で拡張機能を読み込み、テストする方法。Puppeteerと比較して以下の利点がある：

- Service Workerへの接続が `context.serviceWorkers()` で簡単
- 公式ドキュメントにChrome拡張テストのガイドあり（https://playwright.dev/docs/chrome-extensions）
- Service Worker内で `evaluate()` を使って直接コードを実行可能

### A.1 前提条件

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

### A.2 テスト用 manifest.json

Chrome拡張の `activeTab` 権限はユーザーがアイコンをクリックした時のみ付与される。Puppeteer/Playwrightからはアイコンクリックをシミュレートできないため、テスト時は `activeTab` を外し、代わりに明示的なホスト権限を使う。

```json
// manifest.test.json（テスト用）
{
  "manifest_version": 3,
  "name": "My Extension",
  "permissions": ["storage", "tabs", "scripting", "tabCapture", "offscreen", "alarms"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "service-worker.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{ "matches": ["https://www.example.com/*"], "js": ["content.js"] }]
}
```

本番用との差分：

| 項目 | 本番 | テスト |
|---|---|---|
| `activeTab` | あり | **なし** |
| `tabs` | なし or あり | **あり**（URLフィルタ検索に必要） |
| `host_permissions` | 特定URL | **`<all_urls>`** |

ビルド後に `dist/manifest.json` をテスト用に差し替える：

```javascript
// build-test.js
const fs = require("fs");
fs.copyFileSync("manifest.test.json", "dist/manifest.json");
```

### A.2.1 tabCapture の制約（重要）

**`tabCapture` は `<all_urls>` ホスト権限では動作しない。** 検証の結果、`tabCapture` API は以下のユーザージェスチャーでのみ利用可能であることが判明した：

- 拡張機能のアイコンクリック
- `commands` API で定義したキーボードショートカット
- コンテキストメニュー項目の実行

これらはいずれもPuppeteer/Playwrightからシミュレートできない。したがって、**tabCaptureを使うフロー（音声取得、フレーム抽出）は自動テストでは検証不可能**であり、手動テストが必要。

自動テストで検証可能な範囲：

- Popup UI表示・画面遷移
- Content Script によるDOM情報取得
- chrome.storage の読み書き
- Service Worker のロジック（`sw.evaluate()` で直接実行）
- tabCaptureが失敗した場合の部分成功フロー（DOM情報のみ保存）

tabCaptureが失敗した場合にもフローが止まらず部分成功として保存されるよう、`handleStartAnalysis` で `.catch()` を実装しておくことが重要：

```typescript
const captureResult = await captureController.startCapture(tab.id, session)
  .then(() => ({ success: true }))
  .catch((err) => {
    logger.error("Tab capture failed", { error: err.message });
    session.errors.push(`Tab capture failed: ${err.message}`);
    return { success: false };
  });

if (!captureResult.success) {
  // キャプチャ失敗時はDOM情報のみで保存
  await handleStopAnalysis();
}
```

### A.3 ログイン済みプロファイルの利用

InstagramなどログインIDが必要なサイトのテストでは、ログイン済みのChromeプロファイルを再利用する。

1. テスト用プロファイルディレクトリを用意（例: `tmp_chrome_user-data-dir/`）
2. 初回のみ手動でChromeを起動してログインする：
   ```bash
   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
     --user-data-dir="path/to/tmp_chrome_user-data-dir"
   ```
3. ログイン後、Chromeを閉じる
4. テストスクリプトで同じプロファイルを指定する

**注意**: プロファイルディレクトリは同時に1つのChromeインスタンスしか使えない。テスト実行前に他のChromeを閉じること。

### A.4 テストスクリプトの基本構造

```javascript
const { chromium } = require("@playwright/test");
const path = require("path");

async function main() {
  const extensionPath = path.resolve(__dirname, "dist");
  const userDataDir = path.resolve(__dirname, "tmp_chrome_user-data-dir");

  // 拡張機能を読み込んで起動
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,  // 拡張機能はheadlessでは動作しない
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // Service Worker取得 → 拡張機能ID取得
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }
  const extId = serviceWorker.url().split("/")[2];

  // テスト対象ページを開く
  const page = await context.newPage();
  await page.goto("https://www.example.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Popupを開く
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await popupPage.waitForTimeout(2000);

  // Popup内の要素を操作
  await popupPage.locator("button", { hasText: "開始" }).click();

  // Service Worker内でコードを実行
  const result = await serviceWorker.evaluate(async () => {
    const data = await chrome.storage.local.get("my_key");
    return data;
  });

  // chrome.storage にPopupコンテキストからアクセス
  const storageData = await popupPage.evaluate(async () => {
    return await chrome.storage.local.get("my_key");
  });

  await context.close();
}
```

### A.5 Playwright の利点（Puppeteerとの比較）

| 機能 | Playwright | Puppeteer |
|---|---|---|
| Service Worker取得 | `context.serviceWorkers()` で即取得 | `browser.waitForTarget()` で検出困難 |
| Service Worker evaluate | `serviceWorker.evaluate()` | ターゲット接続が複雑 |
| 拡張機能の読み込み | `launchPersistentContext` | `--load-extension` + `connect()` |
| 公式拡張テストガイド | あり | なし |
| アイコンクリック | 不可 | 不可 |
| activeTab付与 | 不可（テスト用manifestで回避） | 不可（同左） |

### A.6 Popup内の `chrome.tabs.query` のフォールバック

Popup URLをタブとして直接開くと、`chrome.tabs.query({ active: true })` がPopupタブ自身を返す。テスト・本番の両方で正しく動作するよう、Popupコードにフォールバックを入れる：

```typescript
// popup.ts
let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// タブとして開かれた場合のフォールバック
if (!tab?.url || tab.url.startsWith("chrome-extension://")) {
  const targetTabs = await chrome.tabs.query({ url: "https://www.example.com/*" });
  if (targetTabs.length > 0) {
    tab = targetTabs[0];
  }
}
```

Service Worker側にも同様のフォールバックが必要：

```typescript
// service-worker.ts の handleStartAnalysis 内
let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
if (!tab?.url || !isTargetUrl(tab.url)) {
  const targetTabs = await chrome.tabs.query({ url: "https://www.example.com/*" });
  const found = targetTabs.find(t => t.url && isTargetUrl(t.url));
  if (found) tab = found;
}
```

このフォールバックには `tabs` 権限が必要（テスト用manifest.jsonには含める）。

### A.7 Service Worker の `evaluate()` を使った直接テスト

Playwrightでは `serviceWorker.evaluate()` で Service Worker 内のコードを直接実行できる。これにより、メッセージング経由では検証しにくい内部ロジックのテストが可能。

```javascript
// Service Worker 取得
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });

// chrome.storage に直接アクセス
const records = await sw.evaluate(async () => {
  const { reel_analysis_records = [] } = await chrome.storage.local.get("reel_analysis_records");
  return reel_analysis_records;
});

// chrome.tabs.query をService Workerから実行
const tabs = await sw.evaluate(async () => {
  return await chrome.tabs.query({ url: "https://www.instagram.com/*" });
});

// tabCapture の動作確認（ユーザージェスチャーなしでは失敗する）
const captureResult = await sw.evaluate(async (tabId) => {
  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
    return { success: true, streamId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}, tabId);
// → { success: false, error: "Extension has not been invoked..." }
```

**注意**: `sw.on("console")` で Service Worker の全ログをキャプチャできるとは限らない。確実にログを取得したい場合は `sw.evaluate()` で直接値を返す方法を使う。

### A.8 拡張機能のリロード

Playwrightのテスト中に拡張機能を最新のビルドでリロードする方法：

```javascript
const reloadPage = await context.newPage();
await reloadPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
await reloadPage.waitForTimeout(2000);
await reloadPage.evaluate((extId) => {
  const manager = document.querySelector("extensions-manager");
  const itemList = manager?.shadowRoot?.querySelector("extensions-item-list");
  const items = itemList?.shadowRoot?.querySelectorAll("extensions-item");
  for (const item of items || []) {
    const idEl = item?.shadowRoot?.querySelector("#extension-id")?.textContent?.trim();
    if (idEl?.includes(extId)) {
      item?.shadowRoot?.querySelector("#dev-reload-button")?.click();
    }
  }
}, extId);
await reloadPage.waitForTimeout(3000);
await reloadPage.close();

// Service Worker を再取得（リロード後は新しいインスタンスになる）
sw = context.serviceWorkers().find(w => w.url().includes(extId));
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
```

**注意**: `--load-extension` で読み込んだ拡張機能はpersistent contextのキャッシュを使うため、ビルドを更新しても自動的には反映されない。テスト開始時にリロードを行うことで最新のコードを使用できる。

---

## B. Puppeteer を使う方法（代替）

Puppeteer + Chrome リモートデバッグポートを使う方法。既存のChromeインスタンスに接続する。

### B.1 前提条件

- Node.js がインストール済み
- Google Chrome がインストール済み
- テスト対象の拡張機能が `dist/` 等にビルド済み

### 必要なnpmパッケージ

```bash
npm install --save-dev puppeteer-core ws
```

`puppeteer-core` はChromiumをバンドルしない軽量版。既存のChromeに接続して使う。

---

## 2. Chromeの起動方法

### 基本コマンド

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir="C:\path\to\test-profile" ^
  --load-extension="C:\path\to\extension\dist"
```

### 各オプションの説明

| オプション | 説明 |
|---|---|
| `--remote-debugging-port=9222` | CDP（Chrome DevTools Protocol）のポート。Puppeteerがここに接続する |
| `--remote-debugging-address=127.0.0.1` | デバッグポートのバインドアドレス。省略するとポートが開かない場合がある（Chrome 146+で確認） |
| `--user-data-dir="..."` | Chromeプロファイルのディレクトリ。通常のプロファイルと分離するため専用ディレクトリを指定する。Instagramなどにログインが必要な場合は、通常のプロファイルを指定することも可能 |
| `--load-extension="..."` | テスト対象の拡張機能のディレクトリ（`manifest.json`が存在するディレクトリ）を指定。デベロッパーモードで自動読み込みされる |

### 重要な注意点

1. **Chromeのプロセスを完全に終了してから起動する**。バックグラウンドプロセスが残っていると `--remote-debugging-port` が無視される
2. `--user-data-dir` を指定しないと通常のプロファイルが使われ、既存のChromeウィンドウと競合する可能性がある
3. `--user-data-dir` で指定したディレクトリにChromeのプロファイルデータ（数百MB）が生成されるため、`.gitignore` に追加すること

### 接続確認

```bash
curl -s http://127.0.0.1:9222/json/version
```

正常なら以下のようなJSONが返る：

```json
{
  "Browser": "Chrome/146.0.7680.178",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

---

## テスト可能な範囲と制限

### Playwright + テスト用manifest（推奨）

| テスト対象 | 自動テスト | 備考 |
|---|---|---|
| Popup UI表示 | OK | `chrome-extension://ID/popup.html` に直接アクセス |
| 画面遷移 | OK | ボタンクリックで遷移、テキスト内容を検証 |
| 設定フォーム | OK | 入力値のデフォルト値、変更を検証 |
| chrome.storage 読み書き | OK | Popupコンテキストまたは`serviceWorker.evaluate()`からアクセス |
| Content Script | OK | `chrome.tabs.sendMessage` で通信。ページ読み込み後に注入される |
| Service Worker ロジック | OK | `context.serviceWorkers()` で即取得、`evaluate()` で直接実行 |
| tabCapture（音声/映像取得） | **NG** | `<all_urls>` ホスト権限でも動作しない。アイコンクリック/ショートカットのユーザージェスチャーが必須 |
| ブラウザUIの操作 | **NG** | ツールバーアイコンのクリック、ショートカットキー等はプログラムから不可 |

---

## トラブルシューティング

### ポートに接続できない
- Chromeのプロセスが完全に終了しているか確認（タスクマネージャー）
- `--remote-debugging-address=127.0.0.1` を追加して起動し直す

### Service Workerが見つからない
Manifest V3のService Workerはアイドル時に停止するため検出できないことがある。Popup操作でメッセージを送るとService Workerが起動する。

### tabCapture が動作しない
`tabCapture` API はホスト権限では許可されない。ユーザージェスチャーが必須。自動テストではtabCapture失敗時の部分成功フローをテストする。

### `chrome.runtime.sendMessage` がService Workerで横取りされる
Service Worker のリスナーの先頭で、Offscreen Document宛のメッセージを除外する：
```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const offscreenMessages = ["RUN_TRANSCRIPTION", "RUN_OCR", "START_CAPTURE", "STOP_CAPTURE"];
  if (offscreenMessages.includes(message.type)) {
    return false; // Offscreen Documentに処理を委ねる
  }
});
```

### 拡張機能のリロード後もService Workerが古いコードで動く
テスト開始時に `chrome://extensions/` のリロードボタンをプログラムでクリックするか、テストごとに新しい `userDataDir` を使う。
