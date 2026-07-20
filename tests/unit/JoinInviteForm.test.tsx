/** @jest-environment jsdom */
/**
 * JoinInviteForm（`/join/[inviteToken]` のゲスト参加フォーム）の単体テスト。
 *
 * `POST /api/guest/join` は `fetch` をモックして検証し、実ネットワーク接続は
 * 行わない。`next/navigation` の `useRouter` もモックし、成功時の画面遷移を
 * `router.push` 呼び出しで検証する。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { JoinInviteForm } from "@/app/(public)/join/[inviteToken]/JoinInviteForm";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe("JoinInviteForm", () => {
  const inviteToken = "invite-token-123";

  beforeEach(() => {
    pushMock.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("初期表示: フォームが表示され、表示名は空・言語はja-JP", () => {
    render(<JoinInviteForm inviteToken={inviteToken} />);

    expect(screen.getByRole("form", { name: "ゲスト参加フォーム" })).toBeInTheDocument();
    expect(screen.getByLabelText("表示名（任意）")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("ja-JP");
  });

  it("送信するとinviteToken・displayName・languageを付けてfetchが呼ばれる", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: "room-xyz" }),
    });

    render(<JoinInviteForm inviteToken={inviteToken} />);

    await user.type(screen.getByLabelText("表示名（任意）"), "たろう");
    await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");
    await user.click(screen.getByRole("button", { name: "参加する" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/guest/join",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inviteToken,
            displayName: "たろう",
            language: "en-US",
          }),
        }),
      );
    });
  });

  it("表示名を空欄のまま送信するとdisplayNameがundefinedとして送信される", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: "room-xyz" }),
    });

    render(<JoinInviteForm inviteToken={inviteToken} />);
    await user.click(screen.getByRole("button", { name: "参加する" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.displayName).toBeUndefined();
  });

  it("成功時はレスポンスのroomIdで/room/{roomId}へ遷移する", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: "room-xyz" }),
    });

    render(<JoinInviteForm inviteToken={inviteToken} />);
    await user.click(screen.getByRole("button", { name: "参加する" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/room/room-xyz");
    });
  });

  it("APIが失敗レスポンスを返した場合はrole=alertでエラーメッセージを表示する", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "招待の有効期限が切れています" }),
    });

    render(<JoinInviteForm inviteToken={inviteToken} />);
    await user.click(screen.getByRole("button", { name: "参加する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("招待の有効期限が切れています");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("APIが失敗レスポンスかつエラーメッセージ本文が無い場合は既定文言を表示する", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("no body");
      },
    });

    render(<JoinInviteForm inviteToken={inviteToken} />);
    await user.click(screen.getByRole("button", { name: "参加する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "参加処理に失敗しました。時間をおいて再度お試しください。",
    );
  });

  it("通信エラー（fetch自体がreject）の場合は通信エラー文言を表示する", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    render(<JoinInviteForm inviteToken={inviteToken} />);
    await user.click(screen.getByRole("button", { name: "参加する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "通信エラーが発生しました。時間をおいて再度お試しください。",
    );
  });

  it("送信中はボタン・入力欄がdisabledになる", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<JoinInviteForm inviteToken={inviteToken} />);
    const submitButton = screen.getByRole("button", { name: "参加する" });
    await user.click(submitButton);

    expect(screen.getByRole("button", { name: "参加処理中..." })).toBeDisabled();
    expect(screen.getByLabelText("表示名（任意）")).toBeDisabled();

    resolveFetch({ ok: true, json: async () => ({ roomId: "room-xyz" }) });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled();
    });
  });
});
