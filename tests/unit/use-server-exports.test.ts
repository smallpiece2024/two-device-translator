/**
 * `"use server"` ファイルの export 制約ガード（bd-2el）。
 *
 * Next.js の**本番ランタイムのみ**が「"use server" ファイルは async 関数のみ
 * export 可」を強制する（dev / `next build` / Jest では検出されない）。
 * 違反があるとモジュール読込時に
 * `Error: A "use server" file can only export async functions, found object.`
 * で該当ページ全体がクラッシュする（本番実機で発覚、digest 1026224665）。
 *
 * 本テストは src 配下の "use server" ディレクティブを持つ全ファイルを走査し、
 * 値の export（`export const/let/var` / 非async の `export function` /
 * 非async の `export default`）を静的に検出する。型のみの export
 * （`export interface` / `export type`）はランタイムに実体を持たないため許容する。
 *
 * @see docs/design/app-architecture.md（Server Action の設計制約）
 * @see tests/unit/supabase/rls-policies.test.ts（同様の静的ガードの流儀）
 */
import * as fs from "fs";
import * as path from "path";

const SRC_DIR = path.resolve(__dirname, "../../src");

/** src 配下の .ts/.tsx を再帰列挙する。 */
function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

/** ファイル先頭（コメントを除く最初の文）が "use server" ディレクティブか。 */
function hasUseServerDirective(content: string): boolean {
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return /^\s*["']use server["']\s*;?/.test(withoutComments);
}

/** 値の export（ランタイム実体を持つ非asyncの export）を検出する。 */
function findValueExports(content: string): string[] {
  const violations: string[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^export\s+(const|let|var)\s/.test(trimmed)) {
      violations.push(`L${index + 1}: ${trimmed}`);
    }
    if (/^export\s+function\s/.test(trimmed)) {
      violations.push(`L${index + 1}: ${trimmed}（async でない関数）`);
    }
    if (/^export\s+default\s/.test(trimmed) && !/^export\s+default\s+async\s+function/.test(trimmed)) {
      violations.push(`L${index + 1}: ${trimmed}`);
    }
  });
  return violations;
}

describe('"use server" ファイルの export 制約（本番ランタイム制約のガード）', () => {
  const useServerFiles = listSourceFiles(SRC_DIR).filter((file) =>
    hasUseServerDirective(fs.readFileSync(file, "utf8"))
  );

  it('"use server" ファイルが1つ以上存在する（走査自体の健全性確認）', () => {
    expect(useServerFiles.length).toBeGreaterThan(0);
  });

  it('"use server" ファイルは async 関数以外を export しない', () => {
    const allViolations = useServerFiles.flatMap((file) => {
      const violations = findValueExports(fs.readFileSync(file, "utf8"));
      const relative = path.relative(SRC_DIR, file);
      return violations.map((v) => `${relative} ${v}`);
    });

    expect(allViolations).toEqual([]);
  });
});
