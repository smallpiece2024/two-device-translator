/**
 * Phase1 翻訳フロー E2E テスト（bd-713）。
 *
 * 2つのブラウザコンテキスト（デバイスA/デバイスB相当）が同一ルームに参加し、
 * 一方の発話（フェイクマイク音声 + モックSTT/翻訳）が、もう一方の画面に
 * 「翻訳されたテキスト」として届くことを検証する。
 *
 * モック仕様（server/gcp/mockGcp.ts、GCP_MODE=mock で有効）:
 * - STT: 音声チャンク write() の4回目で final を1回発火。
 *   クライアントのチャンク間隔は250msなので録音開始から約1秒でfinal、
 *   その後の無音タイマー（1秒）で発話確定・翻訳・配信される
 *   （合計で概ね2秒程度）。
 * - final固定フレーズ: ja-JP → "こんにちは、これはテストです" /
 *   en-US → "Hello, this is a test"
 * - 翻訳: `[${targetLanguage}] ${text}` 形式。targetLanguage は
 *   `messageRouter.ts` が渡す聞き手の `SupportedLanguage`（プロトコルコード
 *   そのもの、例 "en-US"/"ja-JP"）であり、Translation API 用の短縮コード
 *   （"en"/"ja"）ではない点に注意（実際の配信ログで確認済み）。
 *
 * 実 GCP API は一切呼ばない（webServer は playwright.config.ts で
 * GCP_MODE=mock 起動）。
 */
import { test, expect, type Page } from "@playwright/test";

// テスト再実行時の干渉（同一ルームへの3人目参加扱い等）を避けるため、
// 実行のたびに一意なルームIDを使う。
const ROOM_ID = `e2e-phase1-${Date.now()}`;

const JA_FINAL_TEXT = "こんにちは、これはテストです";
const EN_FINAL_TEXT = "Hello, this is a test";
const JA_TO_EN_TRANSLATED = `[en-US] ${JA_FINAL_TEXT}`;
const EN_TO_JA_TRANSLATED = `[ja-JP] ${EN_FINAL_TEXT}`;

/** JoinForm に入力して参加させる（表示名は省略、役割は既定のゲストのまま） */
async function joinRoom(page: Page, language: "日本語" | "英語") {
  await page.goto(`/room/${ROOM_ID}`);
  await page.getByLabel("話す言語").selectOption({ label: language });
  await page.getByRole("button", { name: "参加する" }).click();
  // RoomClient がマウントされ WS 接続・joined 応答を受けるまで待つ
  await expect(page.getByText("状態: 接続済み")).toBeVisible({ timeout: 15_000 });
}

/** 参加者数が2人になるまで待つ（もう一方の参加完了を待つ共通処理） */
async function waitForTwoParticipants(page: Page) {
  await expect(page.getByText("参加者: 2人")).toBeVisible({ timeout: 15_000 });
}

test.describe("Phase1: 2デバイス間の翻訳フロー（bd-713）", () => {
  test("Aの発話がBに翻訳されて届き、Bの発話がAに翻訳されて届く", async ({ browser }) => {
    // 2つの独立したブラウザコンテキスト（別デバイス相当）を用意する。
    // フェイクマイク（--use-fake-device-for-media-stream）は
    // playwright.config.ts の launchOptions で全プロジェクト共通設定済み。
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // A=日本語話者、B=英語話者としてそれぞれ同じルームに参加する
      await joinRoom(pageA, "日本語");
      await joinRoom(pageB, "英語");

      // 両画面で相手の参加を検知し、参加者数が2人になることを確認する
      await waitForTwoParticipants(pageA);
      await waitForTwoParticipants(pageB);

      // --- A(ja-JP) が発話 → B(en-US) に翻訳が届くことを検証 ---
      await pageA.getByRole("button", { name: "開始" }).click();
      await expect(pageA.getByText("状態: 録音中").first()).toBeVisible({ timeout: 5_000 });

      // 話者(A)自身のタイムラインには原文がそのまま表示される。
      // <ul>に list-style:none を指定しているためブラウザによって
      // 暗黙の list/listitem ロールが失われる場合があり、role ベースの
      // ロケーターはフレイキーになりうる。そのためテキスト内容ベースで
      // 確実に検証する（`li`タグへの依存は避け、メッセージ一覧の領域内で
      // 完全一致するテキストの可視性を見る）。
      await expect(
        pageA.locator('[aria-label="メッセージ一覧"]').getByText(JA_FINAL_TEXT, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      // 聞き手(B)のタイムラインには翻訳済みテキストが表示される
      await expect(
        pageB.locator('[aria-label="メッセージ一覧"]').getByText(JA_TO_EN_TRANSLATED, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      await pageA.getByRole("button", { name: "停止" }).click();
      await expect(pageA.getByRole("button", { name: "開始" })).toBeVisible({ timeout: 5_000 });

      // --- 逆方向: B(en-US) が発話 → A(ja-JP) に翻訳が届くことを検証 ---
      await pageB.getByRole("button", { name: "開始" }).click();
      await expect(pageB.getByText("状態: 録音中").first()).toBeVisible({ timeout: 5_000 });

      await expect(
        pageB.locator('[aria-label="メッセージ一覧"]').getByText(EN_FINAL_TEXT, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(
        pageA.locator('[aria-label="メッセージ一覧"]').getByText(EN_TO_JA_TRANSLATED, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      await pageB.getByRole("button", { name: "停止" }).click();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
