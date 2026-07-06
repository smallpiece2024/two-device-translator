/** @jest-environment jsdom */
/**
 * SettingsPanel（bd-fki）の単体テスト。
 *
 * 表示名（blur/Enterで確定・トリム後差分時のみコールバック）・言語
 * （LanguageSelector 再利用・即時反映）・言語検出トグル（checkbox
 * 「言語検出モード」・ローカルのみ、WS送信は呼び出し側の責務）・TTSトグルの
 * レンダリングとコールバック発火条件を検証する
 * （`src/components/SettingsPanel/SettingsPanel.tsx` 参照）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsPanel, type SettingsPanelProps } from "@/components/SettingsPanel/SettingsPanel";

function renderSettingsPanel(overrides: Partial<SettingsPanelProps> = {}) {
  const onDisplayNameChange = jest.fn();
  const onLanguageChange = jest.fn();
  const onDetectLanguageChange = jest.fn();
  const onTtsChange = jest.fn();

  const props: SettingsPanelProps = {
    displayName: "たろう",
    onDisplayNameChange,
    language: "ja-JP",
    onLanguageChange,
    detectLanguage: false,
    onDetectLanguageChange,
    ttsEnabled: true,
    onTtsChange,
    ...overrides,
  };

  const utils = render(<SettingsPanel {...props} />);

  return { ...utils, onDisplayNameChange, onLanguageChange, onDetectLanguageChange, onTtsChange };
}

describe("SettingsPanel", () => {
  it("表示名・言語選択・検出トグル・TTSトグルをレンダリングする", () => {
    renderSettingsPanel();

    expect(screen.getByLabelText("表示名")).toHaveValue("たろう");
    expect(screen.getByRole("combobox", { name: "話す言語" })).toHaveValue("ja-JP");
    expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "読み上げ(TTS)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("displayName未指定時は表示名入力欄が空文字になる", () => {
    renderSettingsPanel({ displayName: undefined });
    expect(screen.getByLabelText("表示名")).toHaveValue("");
  });

  describe("表示名の確定（blur/Enter）", () => {
    it("入力してblurすると、トリム後の値でonDisplayNameChangeが呼ばれる", async () => {
      const user = userEvent.setup();
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      await user.clear(input);
      await user.type(input, "  じろう  ");
      await user.tab();

      expect(onDisplayNameChange).toHaveBeenCalledTimes(1);
      expect(onDisplayNameChange).toHaveBeenCalledWith("じろう");
    });

    it("Enterキー押下で確定し、onDisplayNameChangeが呼ばれる", async () => {
      const user = userEvent.setup();
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      await user.clear(input);
      await user.type(input, "じろう{Enter}");

      expect(onDisplayNameChange).toHaveBeenCalledTimes(1);
      expect(onDisplayNameChange).toHaveBeenCalledWith("じろう");
    });

    it("トリム後の値が既存のdisplayNameと同じ場合はonDisplayNameChangeを呼ばない", async () => {
      const user = userEvent.setup();
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      await user.clear(input);
      await user.type(input, "  たろう  ");
      await user.tab();

      expect(onDisplayNameChange).not.toHaveBeenCalled();
    });

    it("何も変更せずblurした場合はonDisplayNameChangeを呼ばない", async () => {
      const user = userEvent.setup();
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      input.focus();
      await user.tab();

      expect(onDisplayNameChange).not.toHaveBeenCalled();
    });

    it("51文字以上を入力してblurすると、50文字にトリムされた値でonDisplayNameChangeが呼ばれる", () => {
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      // input要素自体の maxLength=50 は userEvent.type だと超過分の入力を防いで
      // しまうため、コンポーネント内部の `.slice(0, MAX_DISPLAY_NAME_LENGTH)`
      // トリム挙動自体を検証するべく fireEvent.change で maxLength を回避し、
      // 51文字を直接セットする。
      const longName = "な".repeat(51);
      fireEvent.change(input, { target: { value: longName } });
      fireEvent.blur(input);

      expect(onDisplayNameChange).toHaveBeenCalledTimes(1);
      expect(onDisplayNameChange).toHaveBeenCalledWith("な".repeat(50));
    });

    it("空文字にしてblurすると、空文字でonDisplayNameChangeが呼ばれる", async () => {
      const user = userEvent.setup();
      const { onDisplayNameChange } = renderSettingsPanel({ displayName: "たろう" });

      const input = screen.getByLabelText("表示名");
      await user.clear(input);
      await user.tab();

      expect(onDisplayNameChange).toHaveBeenCalledWith("");
    });

    it("外部からdisplayNameが変更されると入力欄の表示が同期される", () => {
      const { rerender } = renderSettingsPanel({ displayName: "たろう" });
      expect(screen.getByLabelText("表示名")).toHaveValue("たろう");

      rerender(
        <SettingsPanel
          displayName="はなこ"
          onDisplayNameChange={jest.fn()}
          language="ja-JP"
          onLanguageChange={jest.fn()}
          detectLanguage={false}
          onDetectLanguageChange={jest.fn()}
          ttsEnabled={true}
          onTtsChange={jest.fn()}
        />,
      );

      expect(screen.getByLabelText("表示名")).toHaveValue("はなこ");
    });
  });

  describe("言語選択（即時反映）", () => {
    it("言語を変更するとonLanguageChangeが即座に呼ばれる", async () => {
      const user = userEvent.setup();
      const { onLanguageChange } = renderSettingsPanel({ language: "ja-JP" });

      await user.selectOptions(screen.getByRole("combobox", { name: "話す言語" }), "en-US");

      expect(onLanguageChange).toHaveBeenCalledWith("en-US");
    });

    it("languageDisabled指定時は言語選択が無効化される", () => {
      renderSettingsPanel({ languageDisabled: true });
      expect(screen.getByRole("combobox", { name: "話す言語" })).toBeDisabled();
    });
  });

  describe("言語検出トグル（ローカルのみ、WS送信なし）", () => {
    it("チェックするとonDetectLanguageChange(true)が呼ばれる", async () => {
      const user = userEvent.setup();
      const { onDetectLanguageChange } = renderSettingsPanel({ detectLanguage: false });

      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));

      expect(onDetectLanguageChange).toHaveBeenCalledWith(true);
    });

    it("detectLanguage=trueのときチェック状態で描画される", () => {
      renderSettingsPanel({ detectLanguage: true });
      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).toBeChecked();
    });

    it("外していくとonDetectLanguageChange(false)が呼ばれる", async () => {
      const user = userEvent.setup();
      const { onDetectLanguageChange } = renderSettingsPanel({ detectLanguage: true });

      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));

      expect(onDetectLanguageChange).toHaveBeenCalledWith(false);
    });
  });

  describe("TTSトグル", () => {
    it("クリックするとonTtsChangeが反転した値で呼ばれる", async () => {
      const user = userEvent.setup();
      const { onTtsChange } = renderSettingsPanel({ ttsEnabled: true });

      await user.click(screen.getByRole("switch", { name: "読み上げ(TTS)" }));

      expect(onTtsChange).toHaveBeenCalledWith(false);
    });
  });

  describe("disabled指定時", () => {
    it("表示名・言語・検出トグル・TTSトグルすべてが操作不可になる", () => {
      renderSettingsPanel({ disabled: true });

      expect(screen.getByLabelText("表示名")).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "話す言語" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: /言語検出モード/ })).toBeDisabled();
      expect(screen.getByRole("switch", { name: "読み上げ(TTS)" })).toBeDisabled();
    });

    it("disabled指定時はクリック操作をしてもコールバックが呼ばれない", async () => {
      const user = userEvent.setup();
      const { onTtsChange, onDetectLanguageChange } = renderSettingsPanel({ disabled: true });

      await user.click(screen.getByRole("switch", { name: "読み上げ(TTS)" }));
      // checkbox の disabled 属性によりクリックが無視される
      await user.click(screen.getByRole("checkbox", { name: /言語検出モード/ }));

      expect(onTtsChange).not.toHaveBeenCalled();
      expect(onDetectLanguageChange).not.toHaveBeenCalled();
    });
  });
});
