/** @jest-environment jsdom */
/**
 * `src/app/(owner)/rooms/new/CreateRoomForm.tsx` の単体テスト
 * （bd-two-device-translator-2x6）。
 *
 * `./actions` の `createRoomAction` をモックし、実 Server Action・Supabase
 * 接続を行わない。`useActionState` の pending 状態とエラー表示を検証する。
 *
 * @see src/app/(owner)/rooms/new/CreateRoomForm.tsx
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CreateRoomForm } from "@/app/(owner)/rooms/new/CreateRoomForm";
import { createRoomAction } from "@/app/(owner)/rooms/new/actions";

jest.mock("@/app/(owner)/rooms/new/actions", () => ({
  createRoomAction: jest.fn(),
  initialCreateRoomState: { error: null },
}));

const createRoomActionMock = createRoomAction as jest.MockedFunction<typeof createRoomAction>;

describe("CreateRoomForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("「ルームを作成する」ボタン押下でcreateRoomActionが呼ばれる", async () => {
    const user = userEvent.setup();
    createRoomActionMock.mockResolvedValue({ error: null });
    render(<CreateRoomForm />);

    await user.click(screen.getByRole("button", { name: "ルームを作成する" }));

    expect(createRoomActionMock).toHaveBeenCalledTimes(1);
  });

  it("送信中はボタンがdisabledになり、文言が「作成中...」に変わる", async () => {
    const user = userEvent.setup();
    let resolveAction: (value: { error: null }) => void = () => {};
    const pending = new Promise<{ error: null }>((resolve) => {
      resolveAction = resolve;
    });
    createRoomActionMock.mockReturnValue(pending);
    render(<CreateRoomForm />);

    await user.click(screen.getByRole("button", { name: "ルームを作成する" }));

    expect(screen.getByRole("button", { name: "作成中..." })).toBeDisabled();

    resolveAction({ error: null });
    await screen.findByRole("button", { name: "ルームを作成する" });
    expect(screen.getByRole("button", { name: "ルームを作成する" })).not.toBeDisabled();
  });

  it("エラー時はrole=alertでエラーメッセージを表示する", async () => {
    const user = userEvent.setup();
    createRoomActionMock.mockResolvedValue({
      error: "ルームの作成に失敗しました。時間をおいて再度お試しください。",
    });
    render(<CreateRoomForm />);

    await user.click(screen.getByRole("button", { name: "ルームを作成する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ルームの作成に失敗しました。時間をおいて再度お試しください。"
    );
  });

  it("初期表示ではエラーが表示されない", () => {
    render(<CreateRoomForm />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("キャンセルリンクは/roomsを指す", () => {
    render(<CreateRoomForm />);

    expect(screen.getByRole("link", { name: "キャンセル" })).toHaveAttribute("href", "/rooms");
  });
});
