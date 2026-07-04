import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "two-device-translator",
  description: "対面向けリアルタイム通訳ウェブサービス",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
