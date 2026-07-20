import * as fs from "fs";
import * as path from "path";

/**
 * インフラ設定ファイル（pm2 / Caddy / .gitignore）の静的検証。
 * 実際の GCP リソース作成（terraform apply）や VM 上での実行は対象外。
 */

describe("ecosystem.config.js（pm2）", () => {
  const ecosystemPath = path.resolve(__dirname, "../../ecosystem.config.js");

  it("require でき、apps 配列が定義されている", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(ecosystemPath) as {
      apps: Array<{
        name: string;
        script: string;
        node_args?: string;
        env?: Record<string, unknown>;
      }>;
    };
    expect(Array.isArray(config.apps)).toBe(true);
  });

  it("web アプリが standalone サーバーをポート3000で起動する設定である", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(ecosystemPath) as {
      apps: Array<{
        name: string;
        script: string;
        node_args?: string;
        env?: Record<string, unknown>;
      }>;
    };
    const web = config.apps.find((app) => app.name === "web");
    expect(web).toBeDefined();
    expect(web?.script).toContain(".next/standalone/server.js");
    expect(web?.env?.PORT).toBe(3000);
    expect(web?.env?.HOSTNAME).toBe("127.0.0.1");
  });

  it("apps はちょうど2要素である（web/ws）", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(ecosystemPath) as {
      apps: Array<{ name: string }>;
    };
    expect(config.apps).toHaveLength(2);
  });

  it("ws アプリが dist-server/server/index.js をポート3001で起動する設定である", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(ecosystemPath) as {
      apps: Array<{
        name: string;
        script: string;
        node_args?: string;
        env?: Record<string, unknown>;
      }>;
    };
    const ws = config.apps.find((app) => app.name === "ws");
    expect(ws).toBeDefined();
    expect(ws?.script).toContain("dist-server/server/index.js");
    expect(ws?.env?.WS_PORT).toBe(3001);
  });

  it("両アプリとも --env-file=.env で .env を読み込む", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(ecosystemPath) as {
      apps: Array<{ name: string; node_args?: string }>;
    };
    for (const app of config.apps) {
      expect(app.node_args).toMatch(/--env-file=\.env/);
    }
  });
});

describe("infra/caddy/Caddyfile", () => {
  const caddyfilePath = path.resolve(
    __dirname,
    "../../infra/caddy/Caddyfile",
  );
  const content = fs.readFileSync(caddyfilePath, "utf8");

  it("APP_DOMAIN プレースホルダーを使用している", () => {
    expect(content).toMatch(/\{\$APP_DOMAIN\}/);
  });

  it("/ws* を 127.0.0.1:3001 へルーティングする", () => {
    expect(content).toMatch(/reverse_proxy\s+\/ws\*\s+127\.0\.0\.1:3001/);
  });

  it("それ以外を 127.0.0.1:3000 へルーティングする", () => {
    expect(content).toMatch(/reverse_proxy\s+127\.0\.0\.1:3000/);
  });

  it("gzip 圧縮を有効化している", () => {
    expect(content).toMatch(/encode\s+gzip/);
  });

  it("/ws* のルーティングが catch-all(127.0.0.1:3000)より前に出現する", () => {
    const wsIndex = content.search(/reverse_proxy\s+\/ws\*\s+127\.0\.0\.1:3001/);
    const catchAllIndex = content.search(/reverse_proxy\s+127\.0\.0\.1:3000/);
    expect(wsIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(wsIndex).toBeLessThan(catchAllIndex);
  });
});

describe(".gitignore: Terraform state の除外", () => {
  const gitignorePath = path.resolve(__dirname, "../../.gitignore");
  const content = fs.readFileSync(gitignorePath, "utf8");

  it("*.tfstate を除外している", () => {
    expect(content).toMatch(/\*\.tfstate/);
  });

  it("*.tfstate.* を除外している", () => {
    expect(content).toMatch(/\*\.tfstate\.\*/);
  });

  it(".terraform/ ディレクトリを除外している", () => {
    expect(content).toMatch(/\.terraform\//);
  });

  it("terraform.tfvars を除外している", () => {
    expect(content).toMatch(/terraform\.tfvars/);
  });

  it(".terraform.lock.hcl は除外していない（コミット対象）", () => {
    const ignoreLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(
      ignoreLines.some((line) => line.includes(".terraform.lock.hcl")),
    ).toBe(false);
  });
});
