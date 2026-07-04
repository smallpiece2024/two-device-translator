# GCP連携設計

## 関連ドキュメント

- [設計概要 (overview.md)](./overview.md)
- [アプリ全体アーキテクチャ (app-architecture.md)](./app-architecture.md)
- [サーバー設計 (server-design.md)](./server-design.md)
- [WebSocketプロトコル設計 (websocket-protocol.md)](./websocket-protocol.md)
- [インフラ設計 (infra-design.md)](./infra-design.md)
- [セキュリティ設計 (security-design.md)](./security-design.md)
- 要件定義: [docs/requirements.md](../requirements.md)（FR-4 言語 / FR-7 翻訳 / NFR-1.2 認証情報）

---

## 使用する GCP サービス（3つに限定）

| サービス | パッケージ | 用途 |
|---|---|---|
| Cloud Speech-to-Text | `@google-cloud/speech` | ストリーミング音声認識 |
| Cloud Translation | `@google-cloud/translate` | テキスト翻訳（v2 Basic） |
| Cloud Text-to-Speech | `@google-cloud/text-to-speech` | 翻訳結果の音声合成 |

すべて WSサーバー（`server/gcp/`）でのみ使用する。Next.js（`src/`）からは一切 import しない（[security-design.md](./security-design.md#gcpllm-認証情報のサーバー限定) 参照）。プロトタイプ [`simple-translator` の gcp-integration.md](../../../simple-translator/docs/design/gcp-integration.md) の方針をほぼそのまま流用する。**2デバイス化に伴う主な差分は「言語検出モード（複数言語候補STT）」と「翻訳を送信先言語ごとに実行」の2点**（後者は [server-design.md](./server-design.md#翻訳と配信ルーティング1n拡張の中核) 参照）。

---

## 認証（ADC → サービスアカウント）

要件 NFR-1.2 / §5.3 に従い、**開発と本番で認証手段を切り替え可能**にする。client library は引数なしで生成し、実行環境の Application Default Credentials を自動取得させる（コードは環境非依存に保つ）。

| 環境 | 認証手段 |
|---|---|
| 開発（ローカル Windows） | `gcloud auth application-default login` によるユーザー ADC |
| 本番（GCE VM） | VM に**アタッチしたサービスアカウント**の ADC（メタデータサーバー経由。鍵ファイル不要） |

- `GOOGLE_CLOUD_PROJECT` を環境変数で渡す（プロジェクトID）。
- **サービスアカウントキー JSON をリポジトリに置かない・配布しない**。GCE ではインスタンスにサービスアカウントをアタッチする方式を優先（[infra-design.md](./infra-design.md#gcp-サービスアカウント) 参照）。やむを得ず鍵ファイルを使う場合は VM 上の権限限定ディレクトリに置き `GOOGLE_APPLICATION_CREDENTIALS` で指定（コミット禁止）。
- ブラウザ側に認証情報を一切置かない（`NEXT_PUBLIC_` を付けない）。
- サービスアカウントの必要ロール: Speech-to-Text / Translation / Text-to-Speech の各利用ロール（最小権限、[security-design.md](./security-design.md) 参照）。

---

## 言語レジストリ（多言語対応の基盤・`shared/languages.ts`）

**1エントリ＝1言語で各APIの言語コードを一元管理**する共有モジュールを `shared/languages.ts` に置き、フロント（`src/`）・WSサーバー（`server/`）の双方が参照する正本とする。言語追加はレジストリへのデータ追加のみで完結させる（NFR-5.1）。

```ts
// shared/languages.ts （設計指針。zod のみ依存可）
export interface LanguageEntry {
  code: SupportedLanguage;   // protocolコード（BCP-47, 例 "ja-JP"）。WSメッセージの正本
  label: string;             // UI表示名（例 "日本語"）
  sttCode: string;           // Speech-to-Text recognition languageCode
  translationCode: string;   // Translation v2 の from/to コード
  ttsLanguageCode: string;   // Text-to-Speech voice.languageCode
  ttsVoiceName?: string;     // TTS voice.name
  ttsGender: "NEUTRAL" | "MALE" | "FEMALE";
}
export const LanguageEnum = z.enum(["ja-JP", "en-US"]); // MVP。追加時に拡張
```

- `code` がプロトコル上の正本。各API用コードは `code` から導出せず、必ずレジストリの該当フィールドを引く。
- `LanguageEnum`（[websocket-protocol.md](./websocket-protocol.md#バリデーション方針zodsharedws-protocolschemats) の集合）とレジストリのキー集合を一致させる。

### GCPコード対応表（MVP＝ja/en。拡張余地あり）

| protocol | 表示名 | STT (recognition) | Translation v2 | TTS languageCode | TTS voice（要 listVoices 検証） | gender |
|---|---|---|---|---|---|---|
| `ja-JP` | 日本語 | `ja-JP` | `ja` | `ja-JP` | `ja-JP-Neural2-B` | NEUTRAL |
| `en-US` | 英語 | `en-US` | `en` | `en-US` | `en-US-Neural2-C` | NEUTRAL |

> MVP の対応言語は日本語・英語（FR-4.4）。将来の拡張（中国語簡繁の script subtag、`fil`→`tl` フォールバック等）はプロトタイプの対応表を流用してレジストリへ追加する。**Translation では `split("-")[0]` 方式を使わずレジストリの `translationCode` を引く**（拡張時に簡繁を区別するため）。

### TTSボイス名の検証方針

STT/Translation のコードは安定だが、**TTS のボイス名は時期により提供状況が変動**する。レジストリのボイス名は候補であり、**サーバー起動時に `client.listVoices()` で実在を検証**する前提。存在しなければ同一 `ttsLanguageCode` の利用可能ボイスへフォールバックしログに記録する。優先度 Neural2 > WaveNet > Standard。

---

## 音声形式

| 項目 | 値 |
|---|---|
| ブラウザ取得 | MediaRecorder（`audio/webm;codecs=opus`） |
| STT への指定 | `encoding: WEBM_OPUS` |
| サンプルレート | `sampleRateHertz: 48000` |
| PCM変換 | 行わない（MediaRecorder 標準出力をそのまま使用） |

Chrome/Edge/Safari の最新版を想定（NFR-4.1）。`audio/webm;codecs=opus` が使えないブラウザのフォールバックは MVP 対象外。

### STT ストリーム維持（重要）

- WebM/Opus のコンテナヘッダは MediaRecorder の**最初のチャンクのみ**に含まれる。ストリームを途中で切ると後続チャンクがデコード不能になる。
- したがって**STTストリームはセッション中切り直さない**。発話区切りの「確定」は STTストリームを切る操作ではなく、サーバー内の発話バッファを論理的に確定・クリアする操作とする（[server-design.md](./server-design.md#発話バッファと発話区切り判定プロトタイプ流用) 参照）。
- ストリーム時間上限に到達したら `error`（`fatal:false`）でクライアントへ再接続を促す（自動再ストリーミングは作り込まない）。

---

## Cloud Speech-to-Text（Streaming）

### リクエスト設定（設計例）

```ts
// server/gcp/speechStream.ts （設計指針）
const streamingConfig = {
  config: {
    encoding: "WEBM_OPUS",
    sampleRateHertz: 48000,
    languageCode: entry.sttCode,                 // レジストリの sttCode
    enableAutomaticPunctuation: true,
    // 言語検出モード時のみ付与（FR-4.3）:
    alternativeLanguageCodes: detectLanguage ? otherSttCodes : undefined,
  },
  interimResults: true,                          // interim 表示のため必須
};
const recognizeStream = speechClient.streamingRecognize(streamingConfig)
  .on("error", onError).on("data", onData);      // data.results[0].isFinal で分岐、languageCode も参照
```

### 言語検出モード（FR-4.3 の実装差分・Phase2）

- `detectLanguage=true` のとき `alternativeLanguageCodes` に対応言語（現在言語以外）の `sttCode` を渡す。
- 最初の final の `results[0].languageCode` を判定結果として採用し、参加者の言語を更新（[server-design.md](./server-design.md#言語検出モードfr-43phase2) 参照）。以後は固定。
- 通常モード（既定）は `alternativeLanguageCodes` を付けず、選択言語で固定。

### 結果の扱い

| 結果 | 判定 | 処理 |
|---|---|---|
| interim | `results[0].isFinal === false` | 話者へ `transcript_interim`（表示のみ） |
| final | `results[0].isFinal === true` | バッファ追加 → 話者へ `transcript_final` → 区切り判定 |

音声チャンクは base64 → `Buffer.from(data,"base64")` → `recognizeStream.write(buffer)`。チャンク間隔は `chunkMs`（既定250ms）。

---

## Cloud Translation（v2 Basic）

```ts
// server/gcp/translate.ts （設計指針）
import { v2 } from "@google-cloud/translate";
const translate = new v2.Translate({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
async function translateText(text: string, target: string): Promise<string> {
  const [translated] = await translate.translate(text, target); // target はレジストリの translationCode
  return translated;
}
```

- target は**レジストリの `translationCode`**（`split("-")[0]` は使わない）。source は自動判定でも可。
- **配信ルーティングと連携**: 1発話につき「送信先言語ごとに1回」翻訳する。同一言語の聞き手が複数いても翻訳呼び出しは1回に共有（[server-design.md](./server-design.md#翻訳と配信ルーティング1n拡張の中核) 参照）。MVP は聞き手1人。
- 将来、用語集・モデル選択が必要になれば v3（`TranslationServiceClient`）への移行を検討。現時点は v2 で十分。

---

## Cloud Text-to-Speech

```ts
// server/gcp/textToSpeech.ts （設計指針）
const request = {
  input: { text: translatedText },
  voice: {
    languageCode: entry.ttsLanguageCode,
    name: entry.ttsVoiceName,        // listVoices で検証済み。無ければフォールバック
    ssmlGender: entry.ttsGender,
  },
  audioConfig: { audioEncoding: "MP3" },
};
const [response] = await ttsClient.synthesizeSpeech(request);
const base64 = Buffer.from(response.audioContent).toString("base64");
```

| 項目 | 値 |
|---|---|
| エンコード | MP3（`audio/mpeg`） |
| 対象 | 確定発話の翻訳結果のみ・`enableTts` の聞き手のみ（FR-6.1 / FR-7.4） |
| 合成方式 | 同期合成（`synthesizeSpeech`）。MVP はストリーミングTTS不要 |

`voice` の各値はレジストリを引く。クライアントは base64 を `decodeAudioData` で FIFO 再生（[frontend-design.md](./frontend-design.md#音声再生) 参照）。

---

## クライアント生成方針

- 各 client（`SpeechClient` / `v2.Translate` / `TextToSpeechClient`）は**サーバープロセス起動時に1度だけ生成**して使い回す（接続ごとに作らない）。
- STT の `streamingRecognize` ストリームのみ録音セッション単位で生成する。

---

## フェーズ対応

| フェーズ | 対象 |
|---|---|
| Phase 1 | STT/Translation/TTS の基本連携（ja/en 固定）、レジストリ、listVoices 検証 |
| Phase 2 | 言語検出モード（複数言語候補STT）、サービスアカウント運用への切替 |
| Phase 3 | （AI/要約の LLM は [ai-assistant-design.md](./ai-assistant-design.md)。GCP 範囲では追加なし） |

---

## テスト方針（GCP連携）

実APIには接続しない。`speechStream.ts` / `translate.ts` / `textToSpeech.ts` をモック化して結合テスト。ラッパーの入出力（言語コード変換、base64 化、`isFinal` 分岐、言語検出時の `alternativeLanguageCodes` 付与）は単体テストで検証する（[server-design.md](./server-design.md#テスト方針概要) 参照）。
