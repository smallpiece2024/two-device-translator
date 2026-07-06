/** @jest-environment jsdom */
/**
 * JoinForm の `ownerToken` prop（オーナーWS認証結線、bd-fmk）に関する単体テスト。
 *
 * `ownerToken` がある場合は「役割」セレクトを表示せず、送信時に
 * role を強制的に `"owner"` にして `RoomClient` へ渡す（guestToken と
 * 同じ多層防御パターン）。ownerToken と guestToken が同時に渡された場合は
 * ownerToken を優先する（page.tsx は所有者判定時に guestToken を渡さないため
 * 通常は同時に存在しないが、防御的に検証する）。
 *
 * @see tests/unit/JoinForm-guestToken.test.tsx（同パターンの guest 版）
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
    ownerToken?: string;
    guestToken?: string;
  }) => <div data-testid="room-client-mock" data-props={JSON.stringify(props)} />,
}));

describe("JoinForm (ownerToken)", () => {
  it("ownerTokenありの場合、役割セレクトが表示されない", () => {
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        ownerToken="owner-access-token"
      />,
    );

    expect(screen.queryByRole("combobox", { name: "役割" })).not.toBeInTheDocument();
  });

  it("ownerTokenありの場合、送信するとrole:ownerかつownerTokenがそのままRoomClientへ渡される", async () => {
    const user = userEvent.setup();
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        ownerToken="owner-access-token"
      />,
    );

    await user.type(screen.getByLabelText("表示名（任意）"), "たろう");
    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props.role).toBe("owner");
    expect(props.ownerToken).toBe("owner-access-token");
    expect(props.guestToken).toBeUndefined();
  });

  it("ownerTokenとguestTokenが同時に存在する場合、role:ownerが優先される（防御的検証）", async () => {
    const user = userEvent.setup();
    render(
      <JoinForm
        roomId="room-123"
        wsUrl="ws://localhost:3001/ws"
        ownerToken="owner-access-token"
        guestToken="guest-jwt-token"
      />,
    );

    await user.click(screen.getByRole("button", { name: "参加する" }));

    const mock = screen.getByTestId("room-client-mock");
    const props = JSON.parse(mock.getAttribute("data-props") ?? "{}");

    expect(props.role).toBe("owner");
    expect(props.ownerToken).toBe("owner-access-token");
  });
});
