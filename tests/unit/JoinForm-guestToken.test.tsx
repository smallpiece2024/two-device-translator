/** @jest-environment jsdom */
/**
 * JoinForm の `guestToken` prop（`gtt_guest` クッキー連携）に関する単体テスト。
 *
 * `guestToken` がある場合は「役割」セレクトを表示せず、送信時に
 * role を強制的に `"guest"` にして `RoomClient` へ渡す（state改ざん等の
 * 不測経路を考慮した多層防御）。`guestToken` が無い場合は既存動作
 * （役割セレクト表示）を維持することを回帰確認する。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { JoinForm } from "@/app/(public)/room/[roomId]/JoinForm";

jest.mock("@/app/(public)/room/[roomId]/RoomClient", () => ({
  RoomClient: (props: {
    roomId: string;
    wsUrl: string;
    role?: string;
    displayName?: string;
    language?: string;
    guestToken?: string;
  }) => <div data-testid="room-client-mock" data-props={JSON.stringify(props)} />,
}));

describe("JoinForm (guestToken)", () => {
  it("guestTokenありの場合、役割セレクトが表示されない", () => {
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        guestToken="guest-jwt-token"
      />,
    );

    expect(screen.queryByRole("combobox", { name: "役割" })).not.toBeInTheDocument();
  });

  it("guestTokenありの場合、送信するとrole:guestかつguestTokenがそのままRoomClientへ渡される", async () => {
    const user = userEvent.setup();
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        guestToken="guest-jwt-token"
      />,
    );

    await user.type(screen.getByLabelText("表示名（任意）"), "はなこ");
    await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");
    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props).toEqual({
      roomId: "room-123",
      wsUrl: "ws://localhost:3001/ws",
      role: "guest",
      displayName: "はなこ",
      language: "en-US",
      guestToken: "guest-jwt-token",
    });
  });

  it("guestToken+guestProfileありの場合、フォームをスキップして直接RoomClientがマウントされる（bd-1is）", () => {
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        guestToken="guest-jwt-token"
        guestProfile={{ displayName: "はなこ", language: "en-US" }}
      />,
    );

    // フォームは表示されない
    expect(screen.queryByRole("button", { name: "参加する" })).not.toBeInTheDocument();

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");
    expect(props.role).toBe("guest");
    expect(props.displayName).toBe("はなこ");
    expect(props.language).toBe("en-US");
    expect(props.guestToken).toBe("guest-jwt-token");
  });

  it("guestTokenがあってもguestProfileが無い場合は従来どおりフォームを表示する（bd-1is）", () => {
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        guestToken="guest-jwt-token"
      />,
    );

    expect(screen.getByRole("button", { name: "参加する" })).toBeInTheDocument();
  });

  it("guestTokenなしの場合、従来どおり役割セレクトが表示される（回帰確認）", () => {
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    expect(screen.getByRole("combobox", { name: "役割" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "役割" })).toHaveValue("guest");
  });

  it("guestTokenなしの場合、役割セレクトで選択した値がそのままRoomClientへ渡される（回帰確認）", async () => {
    const user = userEvent.setup();
    render(<JoinForm roomId="room-123" wsUrl="ws://localhost:3001/ws" />);

    await user.selectOptions(screen.getByRole("combobox", { name: "役割" }), "owner");
    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props.role).toBe("owner");
    expect(props.guestToken).toBeUndefined();
  });
});
