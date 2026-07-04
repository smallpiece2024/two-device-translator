/**
 * ゲスト向けトークルーム画面（Phase1 簡易版）。
 *
 * 認証・認可は Phase2 で対応する（`docs/design/security-design.md` Phase1行）。
 * このページは Server Component として roomId と WS 接続先 URL を
 * `RoomClient` へ渡すのみで、状態管理・WS通信は `RoomClient` に集約する
 * （`docs/design/app-architecture.md` Client/Server Component境界 参照）。
 */
import { RoomClient } from "./RoomClient";

const DEFAULT_WS_URL = "ws://localhost:3001/ws";

interface RoomPageProps {
  params: Promise<{ roomId: string }>;
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomId } = await params;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL;

  return <RoomClient roomId={roomId} wsUrl={wsUrl} />;
}
