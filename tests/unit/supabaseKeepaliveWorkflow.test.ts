/**
 * Supabase keepalive ワークフロー（bd-450）のバリデーションテスト。
 *
 * GitHub Actions の cron 実行そのものは CI では再現できないため、
 * ワークフロー定義が設計（docs/design/infra-design.md「Supabase keepalive」）
 * どおりであることを検証する:
 * - 3日おきの schedule + 手動実行（workflow_dispatch）のみをトリガーとする
 * - Secrets 参照のみで、公開リポジトリに実値（プロジェクトURL・キー）を置かない
 * - 読み取り専用（SELECT）で、書き込み系の指定がない
 * - service_role キーを参照しない
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const workflowPath = join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "supabase-keepalive.yml",
);

const raw = readFileSync(workflowPath, "utf8");
const doc = load(raw) as Record<string, unknown>;

/**
 * service_role キー検知パターン。大文字小文字・区切り文字の揺れ
 * （SUPABASE_SERVICE_ROLE_KEY / service_role / SERVICE-ROLE 等）を吸収する。
 * SUPABASE_SERVICE_KEY のような ROLE を含まない命名も SERVICE.KEY で拾う。
 */
const SERVICE_ROLE_PATTERN = /service[_-]?role|service[_-]?key/i;

/**
 * YAML パーサーのスキーマによっては `on` が真偽値 `true` キーとして解釈され得る
 * （YAML 1.1 の挙動。現行の js-yaml v5 の core schema では発生しないが、
 * 将来のパーサー変更に備えた防御的フォールバック）。
 */
function getTriggers(): Record<string, unknown> {
  const triggers =
    (doc as Record<string, unknown>).on ??
    (doc as Record<string, unknown>)["true"];
  expect(triggers).toBeDefined();
  return triggers as Record<string, unknown>;
}

type Step = { run?: string; env?: Record<string, string> };

function getSteps(): Step[] {
  const jobs = doc.jobs as Record<string, { steps: Step[] }>;
  return jobs.keepalive.steps;
}

function getRunScript(): string {
  const runStep = getSteps().find((s) => typeof s.run === "string");
  expect(runStep).toBeDefined();
  return runStep!.run!;
}

describe("supabase-keepalive.yml（bd-450）", () => {
  it("YAMLとしてパースできる", () => {
    expect(doc).toBeTruthy();
    expect(doc.name).toBe("Supabase Keepalive");
  });

  it("トリガーはscheduleとworkflow_dispatchのみ（push等で実APIを呼ばない）", () => {
    const triggers = getTriggers();
    // 本ワークフローは「CIで本物の外部APIを呼ばない」原則の唯一の例外として
    // 許容されているため、トリガーは許可リスト完全一致で検証する
    expect(Object.keys(triggers).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    const schedule = triggers.schedule as Array<{ cron: string }>;
    expect(schedule).toHaveLength(1);
    // 無料プランの停止条件（7日間無アクセス）に対して十分な余裕を持つ間隔
    expect(schedule[0].cron).toBe("0 20 */3 * *");
  });

  it("GITHUB_TOKENの権限を一切要求しない（permissions: {}）", () => {
    expect(doc.permissions).toEqual({});
  });

  it("ジョブにtimeout-minutesが設定され、curlにも--max-timeがある", () => {
    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    expect(typeof jobs.keepalive["timeout-minutes"]).toBe("number");
    expect(getRunScript()).toContain("--max-time");
  });

  it("接続情報はSecrets参照のみで、実値をファイルに含まない", () => {
    const runStep = getSteps().find((s) => typeof s.run === "string")!;
    expect(runStep.env).toEqual({
      SUPABASE_URL: "${{ secrets.SUPABASE_URL }}",
      SUPABASE_ANON_KEY: "${{ secrets.SUPABASE_ANON_KEY }}",
    });
    // プロジェクト固有URLやキーの実値がコミットされていないこと（公開リポジトリ）
    expect(raw).not.toMatch(/[a-z0-9]+\.supabase\.co/);
    expect(raw).not.toContain("eyJ"); // JWT形式キーの先頭
    expect(raw).not.toContain("sb_secret");
  });

  it("service_role検知パターンが現実的な命名の揺れを検出できる（ガード自体の検証）", () => {
    for (const bad of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_KEY",
      "service_role",
      "SERVICE-ROLE",
      "serviceRoleKey",
    ]) {
      expect(bad).toMatch(SERVICE_ROLE_PATTERN);
    }
    // anon キーの正規の参照名には誤反応しない
    expect("SUPABASE_ANON_KEY").not.toMatch(SERVICE_ROLE_PATTERN);
  });

  it("service_roleキーを参照しない", () => {
    // 注意コメント内の語は許容し、実際に使われる run スクリプトと env のみ検査する
    for (const step of getSteps()) {
      const target = JSON.stringify({ run: step.run, env: step.env });
      expect(target).not.toMatch(SERVICE_ROLE_PATTERN);
    }
  });

  it("読み取り専用のSELECTのみで、書き込み系の指定がない", () => {
    const run = getRunScript();
    expect(run).toContain("/rest/v1/plans?select=id&limit=1");
    expect(run).not.toMatch(/-X\s+(POST|PATCH|PUT|DELETE)/);
    expect(run).not.toMatch(/\s(-d|--data|--data-raw|--json)\s/);
  });

  it("anonキーをapikeyとAuthorizationヘッダーで参照している", () => {
    const run = getRunScript();
    expect(run).toContain('-H "apikey: $SUPABASE_ANON_KEY"');
    expect(run).toContain('-H "Authorization: Bearer $SUPABASE_ANON_KEY"');
  });

  it("Secrets未設定時とHTTP 200以外で失敗する", () => {
    const run = getRunScript();
    expect(run).toContain('[ -z "$SUPABASE_URL" ]');
    expect(run).toContain('[ -z "$SUPABASE_ANON_KEY" ]');
    expect(run).toMatch(/if \[ "\$status" != "200" \]/);
    expect(run).toContain("exit 1");
  });
});
