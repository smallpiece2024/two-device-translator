/** @jest-environment jsdom */
/**
 * `src/app/(owner)/rooms/RoomList.tsx` の単体テスト（bd-two-device-translator-2x6）。
 *
 * 表示専用コンポーネントのため、外部依存のモックは不要。
 *
 * @see src/app/(owner)/rooms/RoomList.tsx
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RoomList } from "@/app/(owner)/rooms/RoomList";

describe("RoomList", () => {
  it("複数件表示: 状態バッジ（進行中/終了）と入室リンクが正しく表示される", () => {
    render(
      <RoomList
        rooms={[
          { id: "room-1", status: "active", createdAt: "2026-01-01T09:00:00Z" },
          { id: "room-2", status: "ended", createdAt: "2026-01-02T10:30:00Z" },
        ]}
      />
    );

    expect(screen.getByText("進行中")).toBeInTheDocument();
    expect(screen.getByText("終了")).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: "入室する" });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/room/room-1");
    expect(links[1]).toHaveAttribute("href", "/room/room-2");
  });

  it("作成日時がja-JPロケールでフォーマットされ「作成」の接尾辞付きで表示される", () => {
    render(
      <RoomList
        rooms={[{ id: "room-1", status: "active", createdAt: "2026-01-01T09:00:00Z" }]}
      />
    );

    expect(screen.getByText(/作成$/)).toBeInTheDocument();
  });

  it("不正な日時文字列の場合はフォーマットせず元の文字列を表示する", () => {
    render(
      <RoomList
        rooms={[{ id: "room-1", status: "active", createdAt: "not-a-date" }]}
      />
    );

    expect(screen.getByText("not-a-date 作成")).toBeInTheDocument();
  });

  it("0件時: 空状態メッセージと作成リンクを表示する", () => {
    render(<RoomList rooms={[]} />);

    expect(screen.getByText("まだルームがありません。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "最初のルームを作成する" })).toHaveAttribute(
      "href",
      "/rooms/new"
    );
    expect(screen.queryByRole("link", { name: "入室する" })).not.toBeInTheDocument();
  });
});
