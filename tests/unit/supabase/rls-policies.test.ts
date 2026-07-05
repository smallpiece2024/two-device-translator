import * as fs from "fs";
import * as path from "path";

/**
 * Supabase RLS ポリシー（20260705073031_phase2_rls_policies.sql）に対する
 * 静的回帰ガードテスト。
 *
 * 実DBに接続せず、SQLファイルをテキストとして正規表現で検証する
 * (CI では Supabase/Docker/ネットワークに接続しないため)。
 *
 * 目的: bd-882 (Supabase Auth + RLSポリシー) の設計意図
 * (docs/design/supabase-design.md ポリシー方針表) が、将来の変更で
 * 壊れた場合に CI で検知できるようにする。
 *
 * 実DBでの実際のRLS挙動（16ケース）はローカルで検証済みであり、
 * このテストはその設計がSQLソース上で維持されていることを保証する
 * 「ソースコードレベルの回帰ガード」である。
 */

const migrationsDir = path.resolve(__dirname, "../../../supabase/migrations");
const rlsMigrationPath = path.join(
  migrationsDir,
  "20260705073031_phase2_rls_policies.sql",
);

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("--");
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join("\n");
}

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => path.join(migrationsDir, name));
}

type PolicyCommand = "select" | "insert" | "update" | "delete";

interface ParsedPolicy {
  name: string;
  table: string;
  command: PolicyCommand;
  roles: string[];
  hasUsing: boolean;
  hasWithCheck: boolean;
  statement: string;
}

/**
 * `create policy "name" on public.table for <cmd> to <roles> [using (...)]
 * [with check (...)]` 文を抽出する。
 *
 * このファイル内のポリシーはネストしたサブクエリに `;` を含まないため、
 * 非貪欲マッチで最初の `;` までを1文として扱ってよい。
 */
function extractPolicies(sql: string): ParsedPolicy[] {
  const cleaned = stripSqlLineComments(sql);
  const regex =
    /create\s+policy\s+"([^"]+)"\s+on\s+public\.(\w+)\s+for\s+(select|insert|update|delete)\s+([\s\S]*?);/gi;
  const policies: ParsedPolicy[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    const [, name, table, command, body] = match;
    const rolesMatch = body.match(
      /^\s*to\s+([a-z_,\s]+?)\s*(?:using|with\s+check|$)/i,
    );
    const roles = rolesMatch
      ? rolesMatch[1]
          .split(",")
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean)
      : [];
    policies.push({
      name,
      table: table.toLowerCase(),
      command: command.toLowerCase() as PolicyCommand,
      roles,
      hasUsing: /using\s*\(/i.test(body),
      hasWithCheck: /with\s+check\s*\(/i.test(body),
      statement: match[0],
    });
  }
  return policies;
}

interface ParsedGrant {
  privileges: string[];
  target: string;
  roles: string[];
  statement: string;
}

/**
 * `grant <privileges> on <target> to <roles>;` 文を抽出する。
 * grant 文にネストした括弧は現状存在しないため、`;` までの非貪欲マッチでよい。
 */
function extractGrants(sql: string): ParsedGrant[] {
  const cleaned = stripSqlLineComments(sql);
  const regex = /grant\s+([\s\S]*?)\s+on\s+([\s\S]*?)\s+to\s+([\s\S]*?);/gi;
  const grants: ParsedGrant[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    const [, privilegesRaw, target, rolesRaw] = match;
    grants.push({
      privileges: privilegesRaw
        .split(",")
        .map((p) => p.trim().toLowerCase()),
      target: target.trim().toLowerCase(),
      roles: rolesRaw.split(",").map((r) => r.trim().toLowerCase()),
      statement: match[0],
    });
  }
  return grants;
}

/**
 * GRANT の privilege が insert/update/delete、または `all` / `all privileges`
 * （すべての権限を一括付与する書き方）であるかどうかを判定する。
 *
 * 理由: `grant all on public.rooms to anon;` のように `all` 一語（あるいは
 * `all privileges`）で書かれると、単純な
 * `["insert","update","delete"].includes(p)` の判定をすり抜けてしまう。
 * `all` は insert/update/delete を含む全権限を意味するため、危険パターンとして
 * 明示的に扱う。
 */
function isWriteOrAllPrivilege(privilege: string): boolean {
  const normalized = privilege.trim().toLowerCase();
  return (
    normalized === "all" ||
    normalized === "all privileges" ||
    ["insert", "update", "delete"].includes(normalized)
  );
}

describe("supabase/migrations/20260705073031_phase2_rls_policies.sql: ポリシー存在ガード", () => {
  const sql = readFile(rlsMigrationPath);
  const policies = extractPolicies(sql);

  function policiesFor(table: string): ParsedPolicy[] {
    return policies.filter((p) => p.table === table);
  }

  it("ポリシーが1件以上抽出できる（正規表現の陳腐化検知）", () => {
    expect(policies.length).toBeGreaterThan(0);
  });

  describe("user_profiles: 本人のみ select/update、insert/delete ポリシーなし", () => {
    const tablePolicies = policiesFor("user_profiles");

    it("select ポリシーが authenticated ロールに存在する", () => {
      const p = tablePolicies.find((x) => x.command === "select");
      expect(p).toBeDefined();
      expect(p?.roles).toEqual(["authenticated"]);
      expect(p?.hasUsing).toBe(true);
    });

    it("update ポリシーが authenticated ロールに存在し with check を伴う", () => {
      const p = tablePolicies.find((x) => x.command === "update");
      expect(p).toBeDefined();
      expect(p?.roles).toEqual(["authenticated"]);
      expect(p?.hasUsing).toBe(true);
      expect(p?.hasWithCheck).toBe(true);
    });

    it("insert ポリシーが存在しない（handle_new_userトリガー経由のみ）", () => {
      expect(tablePolicies.find((x) => x.command === "insert")).toBeUndefined();
    });

    it("delete ポリシーが存在しない", () => {
      expect(tablePolicies.find((x) => x.command === "delete")).toBeUndefined();
    });
  });

  describe("plans: select のみ（anon/authenticated 参照可能、書き込み不可）", () => {
    const tablePolicies = policiesFor("plans");

    it("select ポリシーが anon, authenticated 両方に存在する", () => {
      const p = tablePolicies.find((x) => x.command === "select");
      expect(p).toBeDefined();
      expect(p?.roles).toEqual(
        expect.arrayContaining(["anon", "authenticated"]),
      );
    });

    it("insert/update/delete ポリシーが存在しない", () => {
      expect(
        tablePolicies.filter((x) => x.command !== "select"),
      ).toEqual([]);
    });
  });

  describe("rooms: 4操作すべて owner_user_id 条件", () => {
    const tablePolicies = policiesFor("rooms");
    const commands: PolicyCommand[] = ["select", "insert", "update", "delete"];

    it.each(commands)("%s ポリシーが存在し owner_user_id 条件を含む", (cmd) => {
      const p = tablePolicies.find((x) => x.command === cmd);
      expect(p).toBeDefined();
      expect(p?.roles).toEqual(["authenticated"]);
      expect(p?.statement).toMatch(/owner_user_id\s*=\s*auth\.uid\(\)/i);
    });

    it("update ポリシーは using と with check を両方伴う（オーナー変更防止）", () => {
      const p = tablePolicies.find((x) => x.command === "update");
      expect(p?.hasUsing).toBe(true);
      expect(p?.hasWithCheck).toBe(true);
    });
  });

  describe("participants: select のみ（ルームオーナー経由の exists 条件）", () => {
    const tablePolicies = policiesFor("participants");

    it("select ポリシーのみ存在する", () => {
      expect(tablePolicies.map((p) => p.command)).toEqual(["select"]);
    });

    it("select ポリシーが rooms への exists サブクエリでオーナー条件を持つ", () => {
      const p = tablePolicies[0];
      expect(p.statement).toMatch(/exists\s*\(\s*select/i);
      expect(p.statement).toMatch(/owner_user_id\s*=\s*auth\.uid\(\)/i);
      expect(p.roles).toEqual(["authenticated"]);
    });
  });

  describe("invites: 4操作すべてルームオーナー条件", () => {
    const tablePolicies = policiesFor("invites");
    const commands: PolicyCommand[] = ["select", "insert", "update", "delete"];

    it.each(commands)(
      "%s ポリシーが存在し rooms への exists サブクエリでオーナー条件を持つ",
      (cmd) => {
        const p = tablePolicies.find((x) => x.command === cmd);
        expect(p).toBeDefined();
        expect(p?.roles).toEqual(["authenticated"]);
        expect(p?.statement).toMatch(/exists\s*\(\s*select/i);
        expect(p?.statement).toMatch(/owner_user_id\s*=\s*auth\.uid\(\)/i);
      },
    );

    it("update ポリシーは using と with check を両方伴う", () => {
      const p = tablePolicies.find((x) => x.command === "update");
      expect(p?.hasUsing).toBe(true);
      expect(p?.hasWithCheck).toBe(true);
    });

    it("anon ロールへの select ポリシーは存在しない（token照合はサーバー側限定）", () => {
      const anonSelect = tablePolicies.find(
        (p) => p.command === "select" && p.roles.includes("anon"),
      );
      expect(anonSelect).toBeUndefined();
    });
  });
});

describe("supabase/migrations: 危険パターン否定ガード（汎用・全マイグレーション対象）", () => {
  // 理由: 将来のマイグレーション追加時に、意図せず deny-by-default が
  // 崩れるパターンを機械的に検知する。個別ポリシー内容ではなく、
  // 「絶対にあってはならない形」を横断的に禁止する。
  const migrationFiles = listMigrationFiles();

  it("マイグレーションファイルが1件以上存在する", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it.each(migrationFiles.map((f) => [path.basename(f), f] as const))(
    "%s: `to public` ロールを対象にしたポリシー/GRANTが存在しない（文字列一致）",
    (_name, filePath) => {
      const sql = stripSqlLineComments(readFile(filePath));
      // "on public.xxx"（スキーマ修飾）を誤検知しないよう、"to" の直後の
      // "public" のみを対象にする。GRANT文の "to public" はこれで検知できる。
      expect(sql).not.toMatch(/\bto\s+public\b/i);
    },
  );

  it.each(migrationFiles.map((f) => [path.basename(f), f] as const))(
    "%s: 全ポリシーが明示的な to 句を持ち、PUBLIC を対象にしていない（暗黙PUBLIC検知）",
    (_name, filePath) => {
      // 理由: `to public` の文字列一致だけでは、`to` 句そのものを省略した
      // ポリシー（PostgreSQL では to 句省略時は暗黙的に PUBLIC が対象になる）
      // を検知できない。extractPolicies() の roles 抽出結果を用いて、
      // 「to 句が存在し、かつ public を含まない」ことを全ポリシーについて
      // 横断的に検証する。
      const sql = readFile(filePath);
      const policies = extractPolicies(sql);
      const violations = policies.filter(
        (p) => p.roles.length === 0 || p.roles.includes("public"),
      );
      expect(violations).toEqual([]);
    },
  );

  it.each(migrationFiles.map((f) => [path.basename(f), f] as const))(
    "%s: anon ロールへの insert/update/delete/all GRANTが存在しない",
    (_name, filePath) => {
      const sql = readFile(filePath);
      const grants = extractGrants(sql);
      const dangerous = grants.filter(
        (g) =>
          g.roles.includes("anon") &&
          g.privileges.some((p) => isWriteOrAllPrivilege(p)),
      );
      expect(dangerous).toEqual([]);
    },
  );

  it.each(migrationFiles.map((f) => [path.basename(f), f] as const))(
    "%s: update ポリシーには必ず with check が対になっている",
    (_name, filePath) => {
      const sql = readFile(filePath);
      const policies = extractPolicies(sql);
      const updatePoliciesWithoutCheck = policies.filter(
        (p) => p.command === "update" && !p.hasWithCheck,
      );
      expect(updatePoliciesWithoutCheck).toEqual([]);
    },
  );
});

describe("supabase/migrations/20260705073031_phase2_rls_policies.sql: GRANT privilege 明示ガード", () => {
  // 理由: ポリシー（行レベル）とは別に GRANT（テーブルレベル）で権限が
  // 過剰に付与されると、ポリシーの絞り込みと無関係にアクセスが漏れる
  // （例: participants に insert ポリシーが無くても、誤って
  // `grant insert on public.participants to authenticated;` が追加されれば
  // insert 自体は成功してしまう）。GRANT された privilege 集合そのものを
  // 明示的に固定し、意図しない権限追加を検知する。
  const sql = readFile(rlsMigrationPath);
  const grants = extractGrants(sql);

  function grantsFor(target: string): ParsedGrant[] {
    return grants.filter((g) => g.target === target);
  }

  it("public.participants への GRANT は authenticated への select のみである", () => {
    const tableGrants = grantsFor("public.participants");
    expect(tableGrants).toHaveLength(1);
    const [grant] = tableGrants;
    expect(grant.roles).toEqual(["authenticated"]);
    expect(grant.privileges).toEqual(["select"]);
  });

  it("public.user_profiles への GRANT は authenticated への select/update のみである", () => {
    const tableGrants = grantsFor("public.user_profiles");
    expect(tableGrants).toHaveLength(1);
    const [grant] = tableGrants;
    expect(grant.roles).toEqual(["authenticated"]);
    expect(grant.privileges).toEqual(
      expect.arrayContaining(["select", "update"]),
    );
    expect(grant.privileges).toHaveLength(2);
  });

  it("public.invites への GRANT に anon ロールは一切含まれない（selectも含む）", () => {
    const tableGrants = grantsFor("public.invites");
    expect(tableGrants.length).toBeGreaterThan(0);
    for (const grant of tableGrants) {
      expect(grant.roles).not.toContain("anon");
    }
  });
});
