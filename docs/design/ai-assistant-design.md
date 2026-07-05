# AIアシスタント設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [サーバー設計 (server-design.md)](./server-design.md)（idle_hint・終了シーケンス）
- [WebSocketプロトコル設計 (websocket-protocol.md)](./websocket-protocol.md)（idle_hint / summary）
- [DB設計 (db-design.md)](./db-design.md)（messages / summaries）
- [セキュリティ設計 (security-design.md)](./security-design.md)（LLM 認証情報のサーバー限定）
- 要件定義: [docs/requirements.md](../requirements.md)（FR-10 話題提供 / FR-11 要約）

---

## 目的と機能

会話内容を踏まえ、オーナーの体験を補助する2機能を提供する。プロトタイプには無い新規要素（Phase3）。

| 機能 | 概要 | トリガー | 表示先 |
|---|---|---|---|
| 話題提供（FR-10） | 雑談のきっかけ・質問案を提示 | **オーナーのボタン押下（オンデマンド）** | オーナーのみ |
| 終了時要約（FR-11） | 会話全体の要約を生成 | ルーム終了（明示/自動） | 両者に表示、永続はオーナーのみ |

**コスト管理の原則**（要件§11⑤）: 無音で自動的に AI を呼ばない。話題提供は必ずオーナーのボタン押下時のみ LLM を呼ぶ。一定時間発話がない場合はボタンを強調表示して利用を促すだけ（LLM 呼び出しはしない）。要約は終了時に1回のみ。

---

## LLMプロバイダ抽象化（`server/ai/llmProvider.ts`）

Claude / OpenAI を環境変数で切替可能にする（NFR-5.1）。**サーバー側からのみ呼び出す**。認証情報（APIキー）はブラウザに置かない（`NEXT_PUBLIC_` を付けない、[security-design.md](./security-design.md) 参照）。

```ts
// 抽象インターフェース（設計指針）
export interface LlmProvider {
  name: "claude" | "openai";
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
}

// 環境変数で選択
// LLM_PROVIDER = "claude" | "openai"
// ANTHROPIC_API_KEY / OPENAI_API_KEY（サーバー専用）
// LLM_MODEL（プロバイダごとの既定モデル。省略可）
export function getLlmProvider(): LlmProvider { /* LLM_PROVIDER で分岐 */ }
```

- プロバイダ差異（メッセージ形式・モデル名）は各実装に閉じ込め、呼び出し側は `complete()` のみに依存する。
- タイムアウト・リトライ（1回）・失敗時のフォールバックを共通で持つ。
- 生成したテキストはそのまま UI/DB へ渡す（後処理は最小）。

---

## 実行経路

会話中の話題提供と終了時要約で経路が異なる（会話テンポを損なわないため翻訳系と別系統、NFR-2.2）。

| 機能 | 経路 | 認可 | 会話データの取得元 |
|---|---|---|---|
| 話題提供 | **Next.js Route Handler `POST /api/ai/topic`**（Node.js Runtime） | オーナーの Supabase セッション（RLS） | **DB の `messages`**（確定発話は逐次保存済み） |
| 終了時要約 | **WSサーバー `server/ai/llmProvider.ts`**（終了シーケンス内） | 内部処理（service_role） | WS のインメモリ会話 + DB の `messages` |

### なぜ話題提供は Next.js 側か

- オーナーのボタン操作という明確な HTTP リクエスト境界があり、Supabase セッションで認可できる。
- 会話中でも確定発話は WSサーバーが DB に逐次書き込んでいる（[server-design.md](./server-design.md#履歴の永続化) 参照）ため、Route Handler は DB から直近の会話を読めばよい（WS を経由しない）。
- LLM 呼び出しを WS のリアルタイム経路から分離し、会話配信の遅延に影響させない。

### なぜ要約は WSサーバー側か

- 終了はサーバー主導のシーケンス（明示終了 or 自動終了）であり、終了時点の会話全体をサーバーが保持している。
- 生成した要約を同じ WS 経路で両者へ即座に配信できる（`summary` メッセージ）。

---

## 話題提供（FR-10）

### フロー

```text
[オーナー] AIAssistantPanel の「話題提供」ボタン押下
  → POST /api/ai/topic { roomId }
     1. Supabase セッションで roomId の所有者確認（RLS）
     2. messages から直近 N 件（例: 直近20発話 or 直近10分）を取得
     3. プロンプト生成 → getLlmProvider().complete()
     4. 提案テキストを返す（DB 保存はしない。都度生成）
  → AIAssistantPanel に提案を表示（オーナーのみ）
```

- 提案は保存しない（オンデマンドの一時的な補助であり永続要件が無い、YAGNI）。
- 会話が空（発話ゼロ）の場合は LLM を呼ばず定型の初期質問案を返してもよい（コスト節約）。

### プロンプト設計（話題提供）

```text
system:
あなたは対面で会話する2人の雑談を手助けするアシスタントです。
これまでの会話を踏まえ、会話が弾む自然な話題・質問案を日本語で2〜3個、簡潔に提案してください。
・相手について新たに分かった事実（出身地・仕事・趣味など）を掘り下げる質問を優先する
・機微な話題（政治・宗教・収入など）は避ける
・提案は箇条書きで短く

user:
これまでの会話（話者と原文）:
{直近の messages を「話者名: 原文」形式で整形}
```

- 出力言語は**オーナーの言語**（`user_profiles.default_language`）に合わせる。
- 会話は原文（`original_text`）を渡す（翻訳のブレを避け、LLM に多言語のまま解釈させる）。

---

## アイドル検出とボタン強調（FR-10.4）

- WSサーバーが最後の確定発話からの経過を監視し、`idleThresholdMs`（設定可能）超過でオーナーへ `idle_hint` を送る（[server-design.md](./server-design.md#アイドル検出fr-104phase3) 参照）。
- クライアントは話題提供ボタンを強調表示する（`--color-idle-hint`、[styling-design.md](./styling-design.md#オーナー専用uiの配置) 参照）。**この時点で LLM は呼ばない**。実際の呼び出しはオーナーがボタンを押したとき（`POST /api/ai/topic`）のみ。
- しきい値はオーナーが SettingsPanel で調整可能（NFR-5.2）。

---

## 終了時要約（FR-11）

### フロー（WSサーバー終了シーケンス内）

```text
ルーム終了トリガー（request_end owner / auto_timeout）
  → status=ended, rooms 更新
  → 会話が空でなければ:
       messages（全件 or 上限内）+ インメモリ会話からプロンプト生成
       → getLlmProvider().complete()
       → summaries に保存（body, provider, room_id UNIQUE）
       → 両参加者へ summary 配信（FR-11.3）
  → room_ended 配信
```

- 要約は `summaries` に永続化し、オーナーは後から `/history/[roomId]` で閲覧（FR-11.2）。ゲストは終了時のその場表示のみ（永続手段なし、FR-11.3）。
- **失敗時**: 要約生成に失敗しても終了処理は止めない。`summary` を送らず（または「要約を生成できませんでした」を送り）、`room_ended` は必ず配信する。DB には要約なしで終了を記録。

### プロンプト設計（要約）

```text
system:
あなたは会話の記録係です。以下の対面会話の内容を、後から振り返れるように
日本語で簡潔に要約してください。話題の流れ・互いについて分かったこと・
次に会うときの手がかりになる情報を含め、5〜8文程度でまとめてください。

user:
会話ログ（話者と原文）:
{messages を「話者名(言語): 原文」形式で整形}
```

- 出力言語はオーナーの言語に合わせる（永続閲覧するのがオーナーのため）。
- 長時間会話で発話数が多い場合は上限件数で打ち切る（MVP は長時間会話を主対象としない）。

---

## コスト管理

| 施策 | 内容 |
|---|---|
| オンデマンド限定 | 話題提供は必ずボタン押下時のみ。自動呼び出しなし（要件§11⑤） |
| 要約は1回 | ルーム終了時のみ。再要約はしない |
| 入力トークン制限 | 話題提供は直近 N 件、要約は上限件数に整形して渡す |
| `maxTokens` 制限 | `complete()` に出力上限を設定 |
| 空会話スキップ | 発話ゼロなら LLM を呼ばない |

---

## フェーズ対応

すべて **Phase 3**。Phase1/2 では AI 機能は無効（`AIAssistantPanel` はプレースホルダ or 非表示）。DB の `messages` 書き込み（Phase3）が前提。

---

## テスト方針（概要）

| 対象 | 種別 | 例 |
|---|---|---|
| `llmProvider`（プロバイダ切替） | 単体（LLM API モック） | `LLM_PROVIDER` による分岐、タイムアウト/リトライ |
| プロンプト整形 | 単体 | messages → プロンプト文字列の整形、上限件数の打ち切り |
| `POST /api/ai/topic` | 結合（LLM/Supabase モック） | 所有者確認、空会話時の挙動 |
| 要約失敗時の終了継続 | 結合 | 生成失敗でも room_ended が配信されること |

CI では実 LLM を呼ばない（抽象化層でモック、CLAUDE.md CI 節）。
