/** @jest-environment jsdom */
/**
 * CloseTabButton（QRタブの「このタブを閉じる」ボタン、bd-5a2）の単体テスト。
 *
 * jsdom では window.close() が実際にタブを閉じることはないため、
 * spy で呼び出しを検証し、閉じられなかった場合のヒント表示
 * （window.closed が false のまま）を fake timers で検証する。
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CloseTabButton } from "@/app/(owner)/rooms/[roomId]/invite/CloseTabButton";

describe("CloseTabButton", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("クリックで window.close() が呼ばれる", async () => {
    const closeSpy = jest.spyOn(window, "close").mockImplementation(() => {});
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    render(<CloseTabButton />);

    await user.click(screen.getByRole("button", { name: "このタブを閉じる" }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("ブラウザに閉じることを拒否された場合（window.closedがfalseのまま）、手動で閉じるよう促すヒントを表示する", async () => {
    jest.spyOn(window, "close").mockImplementation(() => {});
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    render(<CloseTabButton />);

    await user.click(screen.getByRole("button", { name: "このタブを閉じる" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "タブを自動で閉じられませんでした。お手数ですが手動で閉じてください。"
    );
  });
});
