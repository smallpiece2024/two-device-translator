# スタイリング設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [フロントエンド設計 (frontend-design.md)](./frontend-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-8 LINE風UI / NFR-4 対応環境）

---

## 方針

- **CSS Modules + CSS Custom Properties（CSS変数）** を使用する。
- **Tailwind CSS は禁止**（`@apply`・ユーティリティクラスも使わない）。デザイントークンを CSS変数に集約し、CSS Modules でコンポーネント単位にスコープする。
- 見た目は **LINE風チャット**（FR-8）。自分=右・相手=左のバブル、話者名・時刻付き。プロトタイプの「1ページ縦積み・最小装飾」から、チャット体験に必要な範囲へUIを引き上げる。
- **ゲストはスマホ前提**（QR で参加、NFR-4.1 iOS Safari 確認対象）。モバイルファーストでレイアウトを組み、PC は中央寄せの単一カラムに収める。

---

## ファイル構成

```text
src/app/globals.css                        # デザイントークン・リセット・base タイポグラフィ
src/components/chat/ChatTimeline.module.css
src/components/chat/MessageBubble.module.css
src/components/room/RoomClient.module.css
src/components/room/Recorder.module.css
src/components/room/LanguageSelector.module.css
src/components/room/TTSToggle.module.css
src/components/room/QRDisplay.module.css
src/components/room/AIAssistantPanel.module.css
src/components/room/SettingsPanel.module.css
src/components/ui/Button.module.css        # プリミティブ
```

- グローバルに置くのは「デザイントークン」「最小リセット」「body 基本タイポグラフィ」のみ。各コンポーネントの見た目は対応する `*.module.css` に閉じる。

---

## デザイントークン（`globals.css` の `:root`）

```css
:root {
  /* color */
  --color-bg: #eef1f4;            /* チャット背景（LINE風の淡いグレー） */
  --color-surface: #ffffff;
  --color-border: #d9d9e0;
  --color-text: #1c1c20;
  --color-text-muted: #6b6b75;
  --color-accent: #2563eb;        /* オーナー主要操作 */
  --color-accent-text: #ffffff;
  --color-bubble-self: #9be36b;   /* 自分の発話バブル（右） */
  --color-bubble-other: #ffffff;  /* 相手の発話バブル（左） */
  --color-interim: #8a8a93;       /* 途中認識は淡色（未確定） */
  --color-error: #c0392b;
  --color-success: #15803d;
  --color-idle-hint: #f59e0b;     /* 話題提供ボタン強調 */

  /* spacing */
  --space-xs: 4px; --space-sm: 8px; --space-md: 16px; --space-lg: 24px;

  /* radius / font */
  --radius-sm: 4px; --radius-md: 8px; --radius-bubble: 16px;
  --font-base: system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
  --fs-sm: 0.85rem; --fs-md: 1rem; --fs-lg: 1.25rem;

  /* layout */
  --room-max-width: 640px;        /* PC 時の中央寄せ最大幅 */
  --header-height: 56px;
  --composer-height: 96px;        /* 下部の録音コントロール領域 */
}
```

すべてのコンポーネントは色・余白・角丸・フォントをこれらの変数経由で参照する（直値の色指定を避ける）。

---

## トークルームのレイアウト

チャットアプリの標準的な3層構成（固定ヘッダ・スクロールするタイムライン・固定コンポーザ）。

```text
┌─────────────────────────────┐  ← RoomHeader（固定, --header-height）
│ 相手名 / 在室状態 / 終了(owner) │
├─────────────────────────────┤
│                             │  ← ChatTimeline（縦スクロール, flex:1）
│  [相手] 翻訳テキスト          │     自分=右寄せ, 相手=左寄せ
│              自分の原文 [自分] │     最新が下、自動スクロール
│  ...（interim は最下部淡色）   │
├─────────────────────────────┤
│ 言語 / TTS / 開始・停止・区切り │  ← Recorder+コントロール（固定, --composer-height）
└─────────────────────────────┘
   QRDisplay / AIAssistantPanel / SettingsPanel はオーナー画面で
   ヘッダのメニューまたは折りたたみパネルとして表示（画面を圧迫しない）
```

- 全体は `100dvh`（モバイルのアドレスバー考慮に `dvh` を使用）を高さの基準にし、タイムラインのみスクロールさせる。
- PC は `--room-max-width` で中央寄せ。左右に余白。
- 新着メッセージで最下部へ自動スクロール（ユーザーが上方向にスクロール中は抑制）。

### メッセージバブル

- 自分: 右寄せ・`--color-bubble-self`・角丸 `--radius-bubble`（右下のみ小さく）。
- 相手: 左寄せ・`--color-bubble-other`・境界線。
- 話者名（相手のみ表示）・時刻を `--fs-sm` `--color-text-muted` で添える。
- interim は `--color-interim`＋斜体で「未確定」を視覚化（FR-7.5）。確定でバブル化。

---

## オーナー専用UIの配置

QR招待・AIアシスタント・設定はチャット領域を圧迫しないよう配置する。

- **QRDisplay**: ゲスト未参加時はタイムライン中央にプレースホルダとして大きく表示、参加後はヘッダのメニューへ格納。
- **AIAssistantPanel**: タイムライン下部または右サイド（PC）／下部シート（モバイル）。`idle_hint` 時は話題提供ボタンを `--color-idle-hint` で強調（アニメーションは控えめ、FR-10.4）。
- **SettingsPanel**: ヘッダのメニューから開く折りたたみ。会話中は最小化。
- 終了時要約（`summary`）はモーダル/ボトムシートで両者に表示（FR-11.3）。

---

## ログイン・一覧・履歴画面

- トークルームより装飾を抑えた標準フォーム/リスト。中央寄せ単一カラム（`--room-max-width` 前後）。
- 履歴詳細（`HistoryTimeline`）はトークルームのバブルレイアウトを流用（読み取り専用、音声再生なし）。

---

## レスポンシブ

- **モバイルファースト**。基準はスマホ縦（〜480px）。ゲストは QR 参加のためスマホ利用が主（NFR-4.1）。
- ブレークポイントは最小限（例: `min-width: 641px` で PC 中央寄せ、サイドパネル表示）。
- タッチ操作を考慮し、録音/開始/停止ボタンは十分な当たり判定（44px 以上）を確保。
- iOS Safari の `100vh` 問題回避に `100dvh` を使用。オートプレイ制限対策は [frontend-design.md](./frontend-design.md#useaudioqueue) の AudioContext 遅延生成と合わせる。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | デザイントークン、トークルーム3層レイアウト、メッセージバブル（自分/相手）、Recorder コントロール |
| Phase 2 | ログイン/一覧/join 画面、QRDisplay 配置、SettingsPanel |
| Phase 3 | AIAssistantPanel（idle_hint 強調）、要約モーダル、履歴タイムライン |

---

## テスト方針（概要）

- レイアウト崩れ検出: スナップショット＋スクリーンショット（Playwright）。特にモバイル幅とバブル左右。
- interim/確定/エラー/idle_hint の状態差が視覚的に区別されることを確認。
- 過度なビジュアルリグレッションは設定しない（要件の範囲で最小限）。
