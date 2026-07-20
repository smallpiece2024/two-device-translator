// pm2 プロセス定義（GCE VM上、docs/design/infra-design.md「プロセス管理（pm2）」参照）。
//
// 環境変数は VM上の `.env`（コミットしない）から読み込む。
// pm2 の ecosystem.config.js には `.env` ファイルを自動読込する公式オプションが
// 存在しないため（`env` / `env_production` は静的な値の直書きのみに対応）、
// Node.js 20.6+ で安定利用可能な `--env-file` フラグを node_args に指定し、
// 起動時に `.env` を読み込ませる方式を採用する（VM は Node.js 24 系を想定）。
module.exports = {
  apps: [
    {
      name: "web",
      script: ".next/standalone/server.js",
      node_args: "--env-file=.env",
      env: {
        PORT: 3000,
        HOSTNAME: "127.0.0.1",
      },
    },
    {
      name: "ws",
      script: "dist-server/server/index.js",
      node_args: "--env-file=.env",
      env: {
        WS_PORT: 3001,
      },
    },
  ],
};
