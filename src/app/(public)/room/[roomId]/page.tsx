/**
 * ゲスト向けトークルーム画面（Phase1 簡易版）。
 *
 * URL直打ちでの参加（簡易ルーム参加）に対応するため、まず `JoinForm` で
 * 表示名・話す言語・roleを選択させ、送信後に `RoomClient` をマウントして
 * WS接続・`join` 送信を開始する（`JoinForm` 内で結線）。
 *
 * 認証・認可は Phase2 で対応する（`docs/design/security-design.md` Phase1行）。
 * このページは Server Component として roomId と WS 接続先 URL を
 * `JoinForm` へ渡すのみで、状態管理・WS通信は `RoomClient` に集約する
 * （`docs/design/app-architecture.md` Client/Server Component境界 参照）。
 * ルームはサーバー側で初回join時に自動作成される（`server/room/roomManager.ts`）。
 */
import { JoinForm } from "./JoinForm";

const DEFAULT_WS_URL = "ws://localhost:3001/ws";

interface RoomPageProps {
  params: Promise<{ roomId: string }>;
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomId } = await params;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL;

  return <JoinForm roomId={roomId} wsUrl={wsUrl} />;
}
