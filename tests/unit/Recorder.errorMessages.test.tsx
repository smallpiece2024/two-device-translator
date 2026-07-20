/** @jest-environment jsdom */
/**
 * マイク許可拒否時のエラーメッセージ出し分け（bd-2jn）のテスト。
 *
 * 実機で「ブラウザ設定によりマイクが事前ブロックされ、許可ダイアログが
 * 出ないまま英語の生メッセージが表示される」事象が起きたため、
 * getUserMedia 失敗時に DOMException.name で対処ガイド付きの文言に
 * 出し分けることを検証する:
 * - NotAllowedError / PermissionDeniedError: サイト設定からの許可手順を案内
 * - NotFoundError: マイク未接続の確認を案内
 * - その他: 従来どおり汎用メッセージ（＋ Error なら詳細）
 * - ブラウザの生メッセージ（英語）は NotAllowed / NotFound では表示しない
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import {
  Recorder,
  getUserMediaErrorMessage,
} from "@/components/Recorder/Recorder";

describe("getUserMediaErrorMessage（bd-2jn）", () => {
  it("NotAllowedErrorでサイト設定からの許可手順を案内し、生メッセージを含めない", () => {
    const message = getUserMediaErrorMessage(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    expect(message).toContain("ブロックされています");
    expect(message).toContain("許可");
    expect(message).toContain("再読み込み");
    expect(message).not.toContain("Permission denied");
  });

  it("PermissionDeniedError（旧名）もNotAllowedErrorと同じ案内になる", () => {
    const notAllowed = getUserMediaErrorMessage(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    const permissionDenied = getUserMediaErrorMessage(
      new DOMException("Permission denied", "PermissionDeniedError"),
    );
    expect(permissionDenied).toBe(notAllowed);
  });

  it("NotFoundErrorでマイク未接続の確認を案内し、生メッセージを含めない", () => {
    const message = getUserMediaErrorMessage(
      new DOMException("Requested device not found", "NotFoundError"),
    );
    expect(message).toContain("マイクが見つかりません");
    expect(message).not.toContain("Requested device not found");
  });

  it("その他のDOMExceptionは従来どおり汎用メッセージ＋詳細", () => {
    const message = getUserMediaErrorMessage(
      new DOMException("Could not start audio source", "NotReadableError"),
    );
    expect(message).toContain("マイクへのアクセスが拒否されました");
    expect(message).toContain("Could not start audio source");
  });

  it("Error以外のrejectは汎用の失敗メッセージ", () => {
    expect(getUserMediaErrorMessage("boom")).toBe(
      "マイクへのアクセスに失敗しました",
    );
  });

  it("DOMExceptionでない素のオブジェクトでもnameで判定される（汎用判定の境界）", () => {
    const message = getUserMediaErrorMessage({ name: "NotAllowedError" });
    expect(message).toContain("ブロックされています");
  });
});

describe("Recorder × マイク許可拒否時の表示（bd-2jn）", () => {
  let rejectGetUserMedia: ((reason: unknown) => void) | null;

  beforeEach(() => {
    rejectGetUserMedia = null;
    const getUserMediaMock = jest.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectGetUserMedia = reject;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });
  });

  it("NotAllowedErrorで対処ガイドが表示され、英語の生メッセージは表示されない", async () => {
    const user = userEvent.setup();
    render(<Recorder language="ja-JP" sendMessage={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "開始" }));
    await act(async () => {
      rejectGetUserMedia?.(
        new DOMException("Permission denied", "NotAllowedError"),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("状態: エラー")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/ブロックされています/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Permission denied/)).not.toBeInTheDocument();
  });

  it("NotFoundErrorでマイク未接続の案内が表示される", async () => {
    const user = userEvent.setup();
    render(<Recorder language="ja-JP" sendMessage={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "開始" }));
    await act(async () => {
      rejectGetUserMedia?.(
        new DOMException("Requested device not found", "NotFoundError"),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("状態: エラー")).toBeInTheDocument();
    });
    expect(screen.getByText(/マイクが見つかりません/)).toBeInTheDocument();
  });

  it("その他のエラーでは従来どおり詳細付き汎用メッセージが表示され、原文がconsole.warnに残る", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const user = userEvent.setup();
      render(<Recorder language="ja-JP" sendMessage={jest.fn()} />);

      await user.click(screen.getByRole("button", { name: "開始" }));
      const err = new DOMException(
        "Could not start audio source",
        "NotReadableError",
      );
      await act(async () => {
        rejectGetUserMedia?.(err);
      });

      await waitFor(() => {
        expect(screen.getByText("状態: エラー")).toBeInTheDocument();
      });
      expect(
        screen.getByText(/マイクへのアクセスが拒否されました: Could not start audio source/),
      ).toBeInTheDocument();
      expect(warnSpy).toHaveBeenCalledWith(
        "[Recorder] getUserMedia に失敗しました:",
        err,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
