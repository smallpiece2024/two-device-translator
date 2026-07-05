import * as fs from "fs";
import * as path from "path";

/**
 * `src/` (Next.js のクライアント/サーバー混在コード) に
 * service_role 相当の識別子・環境変数名が一切含まれないことを保証する
 * 静的回帰ガードテスト。
 *
 * 目的: bd-882 (Supabase Auth + RLSポリシー) の設計方針
 * (docs/design/security-design.md, supabase-design.md) である
 * 「GCP/Supabase service_role 認証情報はクライアントに一切露出させない」
 * を、将来の変更で `src/` に service_role キーの参照が混入した場合に
 * CI で検知できるようにする。
 *
 * `src/` はブラウザにバンドルされ得るコードを含むため、
 * `SUPABASE_SERVICE_KEY` や `service_role` という識別子そのものが
 * 存在してはならない（サーバー限定コードは `server/` に置く設計）。
 */

const srcDir = path.resolve(__dirname, "../../../src");

const forbiddenPatterns: { name: string; regex: RegExp }[] = [
  { name: "SUPABASE_SERVICE_KEY", regex: /SUPABASE_SERVICE_KEY/i },
  { name: "service_role", regex: /service_role/i },
];

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

describe("src/ 配下: service_role 認証情報の非露出ガード（汎用）", () => {
  const files = listFilesRecursive(srcDir);

  it("src/ 配下にファイルが1件以上存在する（走査対象の陳腐化検知）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(srcDir, f), f] as const))(
    "%s に service_role 関連の識別子が含まれない",
    (_relPath, filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      for (const { name, regex } of forbiddenPatterns) {
        expect({ file: _relPath, pattern: name, matched: regex.test(content) }).toEqual(
          { file: _relPath, pattern: name, matched: false },
        );
      }
    },
  );
});
