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
 * （コメントを除く実コードに）存在してはならない（サーバー限定コードは
 * `server/` に置く設計）。
 *
 * ## bd-jny 対応: 許可リスト方式への変更
 *
 * `src/lib/supabase/admin.ts`（ゲスト参加 Route Handler 専用の管理者権限
 * クライアント）は、設計上 `SUPABASE_SERVICE_KEY` / `service_role` を
 * 参照する必要がある（docs/design/overview.md D-11、
 * docs/design/supabase-design.md「service_role の使用箇所」）。
 * この1ファイルのみをガードの対象外とする「許可リスト」方式に変更する。
 *
 * ただし許可リストに入れるだけではガードが弱まってしまうため、以下の
 * 補償ガードを併設し、許可の前提条件が崩れたら検知できるようにする:
 *
 * 1. 許可ファイル (`admin.ts`) の先頭付近に `import "server-only"` が
 *    存在すること（ビルド時に Client Component からの import を検知する
 *    公式ガードが有効であることの確認）。
 * 2. `"use client"` を含む `src/` 配下のファイルが `admin.ts` を
 *    import していないこと（横断的な混入チェック）。
 *
 * また、コメント内で `service_role` 等の識別子に**言及**しているだけの
 * ファイル（例: `invite/page.tsx` の設計コメント）を誤検知しないよう、
 * 検査対象は「コメント（`//` 行コメント・`/* *\/` ブロックコメント）を
 * 除去したコード」とする。これにより、実コードに実識別子が現れた場合の
 * 検知能力は維持したまま、コメントでの言及は許容する。
 */

const srcDir = path.resolve(__dirname, "../../../src");

/** ガード対象外とするファイル（`src` からの相対パス、`/` 区切り）。 */
const ALLOWED_FILES = new Set<string>(["lib/supabase/admin.ts"]);

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

/**
 * TypeScript/TSX コードから `//` 行コメントと `/* *\/` ブロックコメントを
 * 除去する（文字列・テンプレートリテラル内の `//` や `/*` は除去しない）。
 *
 * 静的ガード用の簡易実装であり、完全な TS パーサではない。
 * 文字列（`'`, `"`, `` ` ``）の開始・終了とエスケープ（`\`）のみを
 * 考慮した状態機械で、実運用コードにおける誤除去（例: URL の `://`）を防ぐ。
 */
function stripTsComments(code: string): string {
  let result = "";
  let i = 0;
  const n = code.length;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") {
        result += ch;
      }
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === "\\") {
        // エスケープ文字の次の1文字も無条件でコピーする
        if (next !== undefined) {
          result += next;
          i += 2;
          continue;
        }
      }
      if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    // 通常コード領域
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      result += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/** ファイルに禁止パターンが（コメント除去後のコードに）含まれるかを判定する。 */
function findViolations(strippedContent: string): string[] {
  const matched: string[] = [];
  for (const { name, regex } of forbiddenPatterns) {
    if (regex.test(strippedContent)) {
      matched.push(name);
    }
  }
  return matched;
}

describe("src/ 配下: service_role 認証情報の非露出ガード（汎用・許可リスト方式）", () => {
  const files = listFilesRecursive(srcDir);
  const targetFiles = files.filter(
    (f) => !ALLOWED_FILES.has(path.relative(srcDir, f).split(path.sep).join("/"))
  );

  it("src/ 配下にファイルが1件以上存在する（走査対象の陳腐化検知）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("許可リストのファイルが実際に src/ 配下に存在する（陳腐化検知）", () => {
    for (const allowed of ALLOWED_FILES) {
      const fullPath = path.join(srcDir, ...allowed.split("/"));
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });

  it.each(targetFiles.map((f) => [path.relative(srcDir, f), f] as const))(
    "%s に service_role 関連の識別子が含まれない（コメント除去後のコードを検査）",
    (_relPath, filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const stripped = stripTsComments(content);
      const violations = findViolations(stripped);
      expect({ file: _relPath, violations }).toEqual({ file: _relPath, violations: [] });
    }
  );

  describe("stripTsComments() の検知能力確認（フィクスチャによるダミー違反）", () => {
    it("コメント内の言及は除去され、違反として検知されない", () => {
      const fixture = `
        // この関数は service_role の代替として SUPABASE_SERVICE_KEY を使わない設計。
        /* service_role について言及するブロックコメント */
        export function ok() {
          return "hello";
        }
      `;
      expect(findViolations(stripTsComments(fixture))).toEqual([]);
    });

    it("実コード中の識別子はコメント除去後も検知される（ガードが機能している証跡）", () => {
      const fixtureServiceRole = `
        export function bad() {
          const key = process.env.service_role_key;
          return key;
        }
      `;
      expect(findViolations(stripTsComments(fixtureServiceRole))).toContain("service_role");

      const fixtureServiceKeyEnv = `
        export function bad2() {
          return process.env.SUPABASE_SERVICE_KEY;
        }
      `;
      expect(findViolations(stripTsComments(fixtureServiceKeyEnv))).toContain(
        "SUPABASE_SERVICE_KEY"
      );
    });

    it("文字列リテラル中の // はコメントとして誤除去されない（URL等の保護）", () => {
      const fixture = `
        export const docsUrl = "https://example.com/service_role-guide";
      `;
      // URL 文字列中に "service_role" が実在するため、これは検知されて正しい
      // （文字列も実コードの一部であり、識別子の露出はコメントではない）。
      expect(findViolations(stripTsComments(fixture))).toContain("service_role");
    });
  });
});

describe("src/lib/supabase/admin.ts: 許可の前提条件（補償ガード）", () => {
  const adminFilePath = path.join(srcDir, "lib", "supabase", "admin.ts");

  it("admin.ts が存在する", () => {
    expect(fs.existsSync(adminFilePath)).toBe(true);
  });

  it("admin.ts の先頭付近に import \"server-only\" が存在する", () => {
    const content = fs.readFileSync(adminFilePath, "utf8");
    const firstLines = content.split("\n").slice(0, 5).join("\n");
    expect(/import\s+["']server-only["']\s*;?/.test(firstLines)).toBe(true);
  });
});

describe("src/ 配下: \"use client\" ファイルが admin.ts を import していないことの横断ガード", () => {
  const files = listFilesRecursive(srcDir).filter((f) => /\.(ts|tsx)$/.test(f));

  const adminImportPatterns = [
    /from\s+["']@\/lib\/supabase\/admin["']/,
    /from\s+["'][./]*lib\/supabase\/admin["']/,
    /require\(\s*["']@\/lib\/supabase\/admin["']\s*\)/,
  ];

  it.each(files.map((f) => [path.relative(srcDir, f), f] as const))(
    "%s: \"use client\" ディレクティブがある場合、admin.ts を import していない",
    (_relPath, filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const isClientFile = /^\s*["']use client["']\s*;?/.test(content);
      if (!isClientFile) {
        return;
      }
      const importsAdmin = adminImportPatterns.some((re) => re.test(content));
      expect({ file: _relPath, importsAdmin }).toEqual({ file: _relPath, importsAdmin: false });
    }
  );

  it("ダミーの \"use client\" ファイルが admin.ts を import していたら検知される（フィクスチャ）", () => {
    const fixture = `"use client";\nimport { getSupabaseAdminClient } from "@/lib/supabase/admin";\n`;
    const isClientFile = /^\s*["']use client["']\s*;?/.test(fixture);
    const importsAdmin = adminImportPatterns.some((re) => re.test(fixture));
    expect(isClientFile).toBe(true);
    expect(importsAdmin).toBe(true);
  });
});
