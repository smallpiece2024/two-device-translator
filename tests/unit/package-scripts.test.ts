import * as fs from "fs";
import * as path from "path";

describe("package.json の npm scripts定義", () => {
  const pkgPath = path.resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const requiredScripts = [
    "lint",
    "typecheck",
    "typecheck:server",
    "test",
    "build",
    "build:server",
    "dev",
  ];

  it("scriptsフィールドが定義されている", () => {
    expect(pkg.scripts).toBeDefined();
  });

  it.each(requiredScripts)(
    "必須npmスクリプト '%s' が定義されている",
    (scriptName) => {
      expect(pkg.scripts).toHaveProperty(scriptName);
      expect(typeof pkg.scripts?.[scriptName]).toBe("string");
      expect(pkg.scripts?.[scriptName].trim().length).toBeGreaterThan(0);
    },
  );

  it("typecheck:server は tsconfig.server.json を対象にしている", () => {
    expect(pkg.scripts?.["typecheck:server"]).toContain(
      "tsconfig.server.json",
    );
  });

  it("build:server は tsconfig.server.json を対象にしている", () => {
    expect(pkg.scripts?.["build:server"]).toContain("tsconfig.server.json");
  });

  it("build:server は tsc-alias でパスエイリアス（@shared/*）を相対パスに書き換える", () => {
    expect(pkg.scripts?.["build:server"]).toContain("tsc-alias");
  });

  describe("環境変数のプロジェクト直下 .env 集約（マシン全体のsetx依存を排除、bd-7sg）", () => {
    it("dev:ws は --env-file 系オプションで .env を読み込み server/index.ts を起動する", () => {
      const devWs = pkg.scripts?.["dev:ws"] ?? "";
      expect(devWs).toMatch(/--env-file(-if-exists)?=\.env/);
      expect(devWs).toContain("server/index.ts");
    });

    it("sb は dotenv 経由で .env を指定して supabase CLI を呼び出す", () => {
      const sb = pkg.scripts?.["sb"] ?? "";
      expect(sb).toBeTruthy();
      expect(sb).toMatch(/\bdotenv\b/);
      expect(sb).toMatch(/-e\s+\.env/);
      expect(sb).toMatch(/supabase/);
    });

    it("sb は -o (override) フラグでマシン残留の環境変数より .env を優先する", () => {
      const sb = pkg.scripts?.["sb"] ?? "";
      expect(sb).toMatch(/(^|\s)-o(\s|$)/);
    });

    it("devDependencies に dotenv-cli が存在する", () => {
      expect(pkg.devDependencies).toHaveProperty("dotenv-cli");
    });
  });
});
