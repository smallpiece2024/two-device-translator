/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TTSToggle } from "@/components/TTSToggle/TTSToggle";

describe("TTSToggle", () => {
  it("role=switchでaria-checkedが現在の状態を反映する（ON）", () => {
    render(<TTSToggle enabled={true} onChange={jest.fn()} />);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("role=switchでaria-checkedが現在の状態を反映する（OFF）", () => {
    render(<TTSToggle enabled={false} onChange={jest.fn()} />);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("クリックすると反転した値でonChangeが呼ばれる", async () => {
    const user = userEvent.setup();
    const handleChange = jest.fn();
    render(<TTSToggle enabled={false} onChange={handleChange} />);

    await user.click(screen.getByRole("switch"));

    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("disabled=trueの場合、スイッチが非活性になる", () => {
    render(<TTSToggle enabled={true} onChange={jest.fn()} disabled />);

    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("disabled時はクリックしてもonChangeが呼ばれない", async () => {
    const user = userEvent.setup();
    const handleChange = jest.fn();
    render(<TTSToggle enabled={false} onChange={handleChange} disabled />);

    await user.click(screen.getByRole("switch"));

    expect(handleChange).not.toHaveBeenCalled();
  });

  it("ラベルテキストがaria-labelledby経由で参照される", () => {
    render(<TTSToggle enabled={true} onChange={jest.fn()} label="読み上げ(TTS)" />);

    expect(screen.getByRole("switch", { name: "読み上げ(TTS)" })).toBeInTheDocument();
  });
});
