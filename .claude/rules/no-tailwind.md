---
description: Tailwind CSSの使用を禁止する。スタイリングにはCSS Modulesを使用すること。
globs: "**/*.{tsx,jsx,ts,js,css,html,md}"
---

# Tailwind CSS 使用禁止

Tailwind CSSの使用は厳禁。`tailwind`, `@apply`, ユーティリティクラスの使用は一切禁止する。

理由: 要素ごとに個別のスタイルを設定するため、人間があとで統一的なメンテナンスをしづらい。

代わりに CSS Modules + CSS Custom Properties を使用すること。
