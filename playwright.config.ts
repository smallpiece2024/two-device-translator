/**
 * Playwright E2E テスト設定（bd-713: Phase1 翻訳フローの疎通確認）。
 *
 * 実 GCP API は呼ばない。WS サーバーを `GCP_MODE=mock` で起動し、
 * 決定的モック STT/翻訳/TTS（`server/gcp/mockGcp.ts`）で動作させる。
 *
 * ルームIDの衝突（同一ルームに3人目が入る等）による干渉を避けるため、
 * テストは直列実行（`fullyParallel: false`）とする。
 */
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3000;
const WS_PORT = 3001;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        },
      },
    },
  ],
  webServer: [
    {
      command: "npm run dev:web",
      url: `http://127.0.0.1:${WEB_PORT}`,
      // reuseExistingServer は常に false にする（CI/ローカル問わず）。
      // 開発者が `npm run dev`（GCP_MODE 未設定＝実GCP構成）を起動したまま
      // このポートが埋まっていると、true の場合はそのサーバーを誤って
      // 再利用してしまい、モックではなく実GCP（STT/翻訳/TTS）に接続して
      // ハングする・課金される事故につながる（実際にデバッグ中に遭遇した
      // 事象: GCP_MODE=mock を渡したつもりが無反応のまま待ち続けた）。
      // そのため常に新規プロセスを起動し、ポートが既に使用中の場合は
      // fail-fast でエラーにする。`npm run test:e2e` を実行する前に、
      // 開発者は `npm run dev` / `npm run dev:web` / `npm run dev:ws` を
      // 必ず停止しておくこと。
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${WS_PORT}/ws`,
      },
    },
    {
      command: "npx tsx server/index.ts",
      port: WS_PORT,
      // 上記と同じ理由（GCP_MODE=mock の誤バイパス防止）で常に false にする。
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        GCP_MODE: "mock",
        WS_PORT: String(WS_PORT),
        ENABLE_TTS: "true",
      },
    },
  ],
});
