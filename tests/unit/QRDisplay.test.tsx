/** @jest-environment jsdom */
/**
 * QRDisplay（招待URLをQRコード＋テキストで表示するプレゼンテーション
 * コンポーネント）の単体テスト。
 *
 * `qrcode.react` はSVGを描画するため実ライブラリのまま利用し、DOM上に
 * SVG要素が生成されること、渡したURLがテキスト・リンクとして表示される
 * ことを検証する。
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QRDisplay } from "@/components/QRDisplay/QRDisplay";

describe("QRDisplay", () => {
  const inviteUrl = "https://example.com/join/abc123token";

  it("渡したURLでQRコード（SVG）がレンダリングされる", () => {
    render(<QRDisplay inviteUrl={inviteUrl} />);

    const qrWrapper = screen.getByRole("img", { name: "招待用QRコード" });
    const svg = qrWrapper.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("招待URLがテキストとリンクで表示される", () => {
    render(<QRDisplay inviteUrl={inviteUrl} />);

    expect(screen.getByText("参加用URL")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: inviteUrl });
    expect(link).toHaveAttribute("href", inviteUrl);
  });

  it("expiresAt未指定の場合は有効期限が表示されない", () => {
    render(<QRDisplay inviteUrl={inviteUrl} />);

    expect(screen.queryByText(/有効期限/)).not.toBeInTheDocument();
  });

  it("expiresAt指定時は有効期限が整形されて表示される", () => {
    render(<QRDisplay inviteUrl={inviteUrl} expiresAt="2026-01-02T03:04:00.000Z" />);

    expect(screen.getByText(/有効期限:.*まで/)).toBeInTheDocument();
  });

  it("expiresAtが不正な日付文字列の場合はそのまま表示する", () => {
    render(<QRDisplay inviteUrl={inviteUrl} expiresAt="not-a-date" />);

    expect(screen.getByText("有効期限: not-a-date まで")).toBeInTheDocument();
  });
});
