/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { LanguageSelector } from "@/components/LanguageSelector/LanguageSelector";

describe("LanguageSelector", () => {
  it("SUPPORTED_LANGUAGES(ja-JP/en-US)の選択肢を表示する", () => {
    render(<LanguageSelector value="ja-JP" onChange={jest.fn()} />);

    expect(screen.getByRole("option", { name: "日本語" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "英語" })).toBeInTheDocument();
  });

  it("現在の値がselectに反映される", () => {
    render(<LanguageSelector value="en-US" onChange={jest.fn()} />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("en-US");
  });

  it("選択を変更するとonChangeが新しい言語コードで呼ばれる", async () => {
    const user = userEvent.setup();
    const handleChange = jest.fn();
    render(<LanguageSelector value="ja-JP" onChange={handleChange} />);

    await user.selectOptions(screen.getByRole("combobox"), "en-US");

    expect(handleChange).toHaveBeenCalledWith("en-US");
  });

  it("disabled=trueの場合、selectが非活性になる", () => {
    render(<LanguageSelector value="ja-JP" onChange={jest.fn()} disabled />);

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("disabled時はユーザー操作してもonChangeが呼ばれない", async () => {
    const user = userEvent.setup();
    const handleChange = jest.fn();
    render(<LanguageSelector value="ja-JP" onChange={handleChange} disabled />);

    await user.selectOptions(screen.getByRole("combobox"), "en-US").catch(() => {
      // disabled な要素への操作は user-event が例外を投げる場合があるため無視する
    });

    expect(handleChange).not.toHaveBeenCalled();
  });
});
