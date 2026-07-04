"use client";

/**
 * LINE風チャットタイムライン表示コンポーネント。
 *
 * `docs/design/frontend-design.md`（ChatTimeline / MessageBubble節）・
 * `docs/design/styling-design.md`（メッセージバブル節）に従う。
 *
 * RoomClient への結線は行わず、props でメッセージ一覧・認識途中結果・
 * 自分の participantId を受け取る自己完結コンポーネントとする
 * （`reducer.ts` の `MessageView` と整合、reducer.ts 自体は変更しない）。
 */
import { useEffect, useRef } from "react";
import type { MessageView } from "@/app/(public)/room/[roomId]/reducer";
import styles from "./ChatTimeline.module.css";

export interface ChatTimelineProps {
  /** 表示するメッセージ一覧（時系列順） */
  messages: MessageView[];
  /** 自分の認識途中結果（表示専用）。未認識中は null */
  interim: string | null;
  /**
   * 自分の participantId。
   * 自分/相手の左右振り分けは各メッセージの `isOwnMessage`（サーバー確定値）を
   * 直接参照するため表示ロジックには使わないが、将来の拡張（自分の発言のみ
   * ハイライトする等）に備えて呼び出し側の意図を明示する目的で受け取る。
   */
  ownParticipantId: string;
}

/** 時刻表示用フォーマット（HH:MM、24時間表記） */
function formatTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function ChatTimeline(props: ChatTimelineProps) {
  const { messages, interim } = props;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = bottomRef.current;
    // jsdom（テスト環境）は scrollIntoView を実装していないため存在チェックする
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "end" });
    }
  }, [messages, interim]);

  const isEmpty = messages.length === 0 && !interim;

  return (
    <section className={styles.timeline} aria-label="メッセージ一覧">
      {isEmpty ? (
        <p className={styles.empty}>まだメッセージがありません</p>
      ) : (
        <ul className={styles.messageList}>
          {messages.map((message) => {
            const isOwn = message.isOwnMessage;
            return (
              <li
                key={message.messageId}
                className={`${styles.messageRow} ${isOwn ? styles.own : styles.other}`}
                data-own={isOwn}
              >
                <div className={`${styles.bubble} ${isOwn ? styles.bubbleOwn : styles.bubbleOther}`}>
                  {!isOwn && (
                    <span className={styles.speakerName}>
                      {message.speakerName || "相手"}
                    </span>
                  )}
                  <p className={styles.messageText}>{message.displayText}</p>
                  <time className={styles.timestamp} dateTime={message.createdAt}>
                    {formatTime(message.createdAt)}
                  </time>
                </div>
              </li>
            );
          })}
          {interim && (
            <li className={`${styles.messageRow} ${styles.own}`} data-own="true">
              <div
                className={`${styles.bubble} ${styles.bubbleOwn} ${styles.bubbleInterim}`}
                aria-label="認識途中"
              >
                <p className={styles.messageText}>{interim}</p>
              </div>
            </li>
          )}
        </ul>
      )}
      <div ref={bottomRef} />
    </section>
  );
}
