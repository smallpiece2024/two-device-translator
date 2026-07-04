import * as fs from "fs";
import * as path from "path";

describe("package.json の npm scripts定義", () => {
  const pkgPath = path.resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
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
});
