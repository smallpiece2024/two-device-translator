/**
 * 確定発話の翻訳・配信ルーティング（1:N拡張可能）。
 *
 * 話者本人へ原文の `message` を送り、聞き手集合が必要とする言語を集めて
 * 「送信先言語ごとに1回だけ」翻訳し、各聞き手へ翻訳済み `message`（TTS ON なら
 * `audio` も）を配信する。
 *
 * I/O（送信・翻訳・音声合成）はすべて引数で注入し、聞き手のループ実装以外は
 * 純粋ロジックに近い形に保つ（単体テスト容易性のため）。聞き手は配列で
 * 受け取り、人数に関する制約はこのモジュールに一切埋め込まない（1:N拡張）。
 *
 * @see docs/design/server-design.md 「翻訳と配信ルーティング（1:N拡張の中核）」
 */
import { randomUUID } from "node:crypto";
import type { SupportedLanguage, ServerMessage } from "@shared/index";

/**
 * ルーティング対象の1参加者（話者・聞き手の両方をこの形で表す）。
 * `Session` から必要な情報のみを抜き出した最小のインターフェース
 * （`messageRouter.ts` は `Session` に直接依存しない）。
 */
export interface RoutingParticipant {
  participantId: string;
  displayName?: string;
  /** 現在の言語（話者の場合は発話言語、聞き手の場合は受信したい言語） */
  language: SupportedLanguage;
  /** 聞き手として TTS を受け取るか（話者自身には使用しない） */
  enableTts: boolean;
  /** この参加者の接続へメッセージを送信する */
  send: (message: ServerMessage) => void;
}

/** 確定発話の翻訳結果（言語別）。DB書き込み等のフック用に配信後にまとめて渡す */
export interface TranslationResult {
  language: SupportedLanguage;
  text: string;
}

/** `routeUtterance` の入力 */
export interface RouteUtteranceInput {
  roomId: string;
  /** 発話した参加者 */
  speaker: RoutingParticipant;
  /** ルーム内の聞き手一覧（話者を含まない。1:N拡張可能な配列） */
  listeners: RoutingParticipant[];
  /** 発話言語（通常は speaker.language と同一） */
  sourceLanguage: SupportedLanguage;
  /** 確定した発話テキスト（原文） */
  text: string;
}

/** `routeUtterance` が呼び出す I/O 群（テスト時にモック注入する） */
export interface MessageRouterDeps {
  /** テキスト翻訳（`server/gcp/translate.ts` の `translateText` 相当） */
  translate: (
    text: string,
    sourceLanguage: SupportedLanguage,
    targetLanguage: SupportedLanguage,
  ) => Promise<string>;
  /**
   * 音声合成（`server/gcp/textToSpeech.ts` の `synthesizeSpeechToBase64` 相当）。
   * ENABLE_TTS=false 等で合成しない場合は null を返す想定。
   */
  synthesize: (text: string, targetLanguage: SupportedLanguage) => Promise<string | null>;
  /** `message.messageId` / `audio.messageId` の採番（省略時 randomUUID） */
  generateMessageId?: () => string;
  /** `message.createdAt` に使う現在時刻（省略時 `new Date()`。テスト用の時刻固定に使用） */
  now?: () => Date;
  /**
   * 配信完了後に呼ばれるフック（Phase3 の DB 書き込み用）。
   * 配信を遅延させないよう、呼び出し側は結果を待たずに fire-and-forget で扱うこと。
   * 本タスクでは実装せず、フックポイントの提供のみ行う。
   */
  onMessageRouted?: (info: {
    roomId: string;
    messageId: string;
    speakerParticipantId: string;
    sourceLanguage: SupportedLanguage;
    originalText: string;
    translations: TranslationResult[];
    createdAt: string;
  }) => void;
}

/**
 * 確定発話を翻訳し、話者本人・各聞き手へ配信する。
 *
 * - 話者本人へ: message(originalText=text, displayText=text, isOwnMessage=true)
 * - 聞き手が必要とする言語（話者と異なる言語のみ）を集約し、言語ごとに1回だけ翻訳
 * - 各聞き手へ: message(displayText=その言語の翻訳 or 原文, isOwnMessage=false)
 * - enableTts=true の聞き手へ: audio(mp3 base64)
 * - 翻訳失敗時はこの発話のみ `error`（fatal:false）を話者へ送り、以降の配信をスキップする
 */
export async function routeUtterance(
  input: RouteUtteranceInput,
  deps: MessageRouterDeps,
): Promise<void> {
  const { roomId, speaker, listeners, sourceLanguage, text } = input;
  const generateMessageId = deps.generateMessageId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  const messageId = generateMessageId();
  const createdAt = now().toISOString();
  const speakerName = speaker.displayName ?? "";

  // 1. 話者本人へ原文を配信
  speaker.send({
    type: "message",
    messageId,
    roomId,
    speakerParticipantId: speaker.participantId,
    speakerName,
    sourceLanguage,
    originalText: text,
    displayText: text,
    displayLanguage: sourceLanguage,
    isOwnMessage: true,
    createdAt,
  });

  // 2. 聞き手が必要とする言語を収集する（話者と同一言語は翻訳不要）
  const distinctLanguages = Array.from(
    new Set(listeners.map((l) => l.language).filter((lang) => lang !== sourceLanguage)),
  );

  // 3. 言語ごとに1回だけ翻訳する
  const translations = new Map<SupportedLanguage, string>();
  for (const language of distinctLanguages) {
    try {
      const translated = await deps.translate(text, sourceLanguage, language);
      translations.set(language, translated);
    } catch {
      // 翻訳失敗: この発話のみ話者へ error を返し、以降の配信（他の聞き手含む）はスキップする
      speaker.send({
        type: "error",
        message: "Translation failed for this utterance. Please try again.",
        fatal: false,
      });
      return;
    }
  }

  // 4. 各聞き手へ配信（message は必ず、audio は enableTts の聞き手のみ）
  for (const listener of listeners) {
    const displayText =
      listener.language === sourceLanguage ? text : (translations.get(listener.language) ?? text);

    listener.send({
      type: "message",
      messageId,
      roomId,
      speakerParticipantId: speaker.participantId,
      speakerName,
      sourceLanguage,
      originalText: text,
      displayText,
      displayLanguage: listener.language,
      isOwnMessage: false,
      createdAt,
    });

    if (!listener.enableTts) {
      continue;
    }

    try {
      const audioBase64 = await deps.synthesize(displayText, listener.language);
      if (audioBase64 === null) {
        continue;
      }
      listener.send({
        type: "audio",
        messageId,
        mimeType: "audio/mpeg",
        data: audioBase64,
      });
    } catch (err) {
      // TTS失敗: この聞き手の音声のみスキップする（テキスト配信は既に完了しているため継続）。
      // テキスト本文はログに出さず、対象participantId・言語のみ記録する。
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[routeUtterance] TTS synthesis failed for participantId=${listener.participantId} language=${listener.language}:`,
        message,
      );
      speaker.send({
        type: "error",
        message: "Text-to-speech failed for this utterance. Please try again.",
        fatal: false,
      });
    }
  }

  // 5. Phase3 の DB 書き込み用フック（配信を待たせない fire-and-forget 前提）
  if (deps.onMessageRouted) {
    const translationResults: TranslationResult[] = Array.from(translations.entries()).map(
      ([language, translatedText]) => ({ language, text: translatedText }),
    );
    deps.onMessageRouted({
      roomId,
      messageId,
      speakerParticipantId: speaker.participantId,
      sourceLanguage,
      originalText: text,
      translations: translationResults,
      createdAt,
    });
  }
}
