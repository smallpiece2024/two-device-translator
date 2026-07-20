"use client";

/**
 * QRDisplay: 招待URLをQRコード＋テキストで表示する（オーナーのみ、FR-2.2）。
 *
 * QRライブラリは `qrcode.react` を採用する。理由:
 * - `docs/design/frontend-design.md` の QRDisplay 節は「例: `qrcode`」を挙げつつ
 *   「クライアント生成、または Server Component で data URL 生成」を許容しており、
 *   ライブラリを一意に指定していない。
 * - 本コンポーネントは Client Component（`招待URLのコピー` 等の将来のインタラクション
 *   を持ちうる）として設計されているため、React コンポーネントとして直接使える
 *   `qrcode.react` を選定した（`qrcode` は文字列/データURLを生成するだけのAPIで、
 *   React コンポーネント化の分だけ呼び出し側のボイラープレートが増える）。
 * - `qrcode.react` は SVG（`QRCodeSVG`）を描画するため、`<canvas>` の
 *   ラスタライズ待ちが無く、テスト（RTL）でも DOM から直接内容を検証しやすい。
 *
 * 表示専用のプレゼンテーションコンポーネントとし、招待URLの発行・再発行ロジックは
 * 呼び出し元（`(owner)/rooms/[roomId]/invite/page.tsx`）に持たせる。
 */
import { QRCodeSVG } from "qrcode.react";
import styles from "./QRDisplay.module.css";

export interface QRDisplayProps {
  /** QRコードにエンコードする招待URL（`https://{host}/join/{token}`） */
  inviteUrl: string;
  /** 招待の有効期限（表示用、ISO文字列）。未指定なら期限表示を省略する */
  expiresAt?: string;
}

const QR_SIZE_PX = 220;

function formatExpiresAt(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function QRDisplay({ inviteUrl, expiresAt }: QRDisplayProps) {
  return (
    <div className={styles.container}>
      <div className={styles.qrWrapper} role="img" aria-label="招待用QRコード">
        <QRCodeSVG value={inviteUrl} size={QR_SIZE_PX} marginSize={2} />
      </div>
      <p className={styles.urlLabel}>参加用URL</p>
      <p className={styles.url}>
        <a href={inviteUrl} className={styles.urlLink}>
          {inviteUrl}
        </a>
      </p>
      {expiresAt && (
        <p className={styles.expiresAt}>有効期限: {formatExpiresAt(expiresAt)} まで</p>
      )}
    </div>
  );
}
