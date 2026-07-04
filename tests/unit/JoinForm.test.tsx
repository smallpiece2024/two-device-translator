/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { JoinForm } from "@/app/(public)/room/[roomId]/JoinForm";

/**
 * JoinForm（簡易ルーム参加フォーム）の単体テスト。
 *
 * 送信後にマウントされる `RoomClient` は WebSocket 接続を伴い、jsdom環境では
 * WebSocket が未定義のため、テストでは `RoomClient` をモック化し、JoinForm から
 * 渡される props（役割・表示名・言語）のみを検証する。
 */
jest.mock("@/app/(public)/room/[roomId]/RoomClient", () => ({
  RoomClient: (props: {
    roomId: string;
    wsUrl: string;
    role?: string;
    displayName?: string;
    language?: string;
  }) => (
    <div data-testid="room-client-mock" data-props={JSON.stringify(props)} />
  ),
}));

describe("JoinForm", () => {
  it("表示名・言語・roleの初期値でフォームを表示する", () => {
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    expect(screen.getByRole("form", { name: "ルーム参加フォーム" })).toBeInTheDocument();
    expect(screen.getByText("ルーム「room-123」に参加")).toBeInTheDocument();
    expect(screen.getByLabelText("表示名（任意）")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("ja-JP");
    expect(screen.getByRole("combobox", { name: "役割" })).toHaveValue("guest");
  });

  it("表示名を入力できる", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    const input = screen.getByLabelText("表示名（任意）");
    await user.type(input, "たろう");

    expect(input).toHaveValue("たろう");
  });

  it("言語を選択できる", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");

    expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("en-US");
  });

  it("役割を選択できる", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    await user.selectOptions(screen.getByRole("combobox", { name: "役割" }), "owner");

    expect(screen.getByRole("combobox", { name: "役割" })).toHaveValue("owner");
  });

  it("送信すると入力内容を反映した RoomClient がマウントされる", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    await user.type(screen.getByLabelText("表示名（任意）"), "たろう");
    await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");
    await user.selectOptions(screen.getByRole("combobox", { name: "役割" }), "owner");
    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props).toEqual({
      roomId: "room-123",
      wsUrl: "ws://localhost:3001/ws",
      role: "owner",
      displayName: "たろう",
      language: "en-US",
    });
  });

  it("表示名を空欄のまま送信するとdisplayNameがundefinedになる", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props.displayName).toBeUndefined();
    expect(props.role).toBe("guest");
    expect(props.language).toBe("ja-JP");
  });
});
