import * as fs from "fs";
import * as path from "path";

/**
 * Supabase migrations / seed に対する静的回帰ガードテスト。
 *
 * 実DBに接続せず、SQLファイルをテキストとして正規表現で検証する。
 * (CI では Supabase/Docker/ネットワークに接続しないため、この方式を採用する)
 *
 * 目的: bd-fo6 (Phase2 Supabaseスキーマ) のレビュー指摘・設計意図が、
 * 将来の変更で壊れた場合に CI で検知できるようにする。
 */

const migrationsDir = path.resolve(__dirname, "../../../supabase/migrations");
const seedPath = path.resolve(__dirname, "../../../supabase/seed.sql");

const phase2MigrationPath = path.join(
  migrationsDir,
  "20260705063916_phase2_auth_room.sql",
);

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

/**
 * SQLの行コメント（`-- ...`）を除去したテキストを返す。
 *
 * 理由: 正規表現ベースの簡易パースは、行コメントアウトによって
 * 実質的に無効化された文（例: 誤ってコメントアウトされた
 * `enable row level security`）を誤って「有効」と判定してしまう。
 * 検証対象の文はすべて実行される SQL 文でなければならないため、
 * 抽出処理の前段でコメントを取り除く。
 */
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

/**
 * `create table [if not exists] [schema.]tablename` からテーブル名を抽出する。
 * スキーマ修飾（public.xxx）・引用符（"xxx"）の有無に頑健にする。
 */
function extractCreatedTableNames(sql: string): string[] {
  const cleaned = stripSqlLineComments(sql);
  const regex =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    names.push(match[1].toLowerCase());
  }
  return names;
}

/**
 * `alter table [schema.]tablename enable row level security` から
 * RLSが有効化されたテーブル名を抽出する。
 */
function extractRlsEnabledTableNames(sql: string): string[] {
  const cleaned = stripSqlLineComments(sql);
  const regex =
    /alter\s+table\s+"?(?:[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    names.push(match[1].toLowerCase());
  }
  return names;
}

describe("supabase/migrations: RLS全有効ガード（汎用・将来のマイグレーション追加にも適用）", () => {
  // 理由: 新しいテーブルを追加した際に RLS 有効化を忘れると、
  // deny-by-default の前提が崩れ、意図せずデータが公開されるリスクがある。
  // 全マイグレーションファイルを走査し、create table された全テーブルに
  // 対応する enable row level security が存在することを機械的に保証する。
  const migrationFiles = listMigrationFiles();

  it("マイグレーションファイルが1件以上存在する", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it.each(migrationFiles.map((f) => [path.basename(f), f] as const))(
    "%s: create table された全テーブルに RLS が有効化されている",
    (_name, filePath) => {
      const sql = readFile(filePath);
      const createdTables = extractCreatedTableNames(sql);
      const rlsEnabledTables = extractRlsEnabledTableNames(sql);

      const missing = createdTables.filter(
        (table) => !rlsEnabledTables.includes(table),
      );

      expect(missing).toEqual([]);
    },
  );
});

describe("supabase/migrations/20260705063916_phase2_auth_room.sql: Phase2スキーマの存在ガード", () => {
  const sql = readFile(phase2MigrationPath);
  const createdTables = extractCreatedTableNames(sql);

  it.each([
    "plans",
    "user_profiles",
    "rooms",
    "participants",
    "invites",
  ])("テーブル '%s' が create table されている", (tableName) => {
    expect(createdTables).toContain(tableName);
  });

  // 理由: messages / summaries は Phase3 スコープであり、
  // Phase2 マイグレーションに混入するとタスク境界が崩れる。
  it.each(["messages", "summaries"])(
    "テーブル '%s' は含まれない（Phase3スコープ混入防止）",
    (tableName) => {
      expect(createdTables).not.toContain(tableName);
    },
  );
});

describe("supabase/migrations/20260705063916_phase2_auth_room.sql: 制約ガード", () => {
  const sql = readFile(phase2MigrationPath);

  it("rooms_status_check 制約が存在する", () => {
    expect(sql).toMatch(/constraint\s+rooms_status_check\s+check/i);
  });

  // 理由: 制約名の存在だけでは、許容値が意図せず変更・削除されても検知できない。
  // db-design.md のインデックス戦略/制約仕様と一致することを固定する。
  it("rooms_status_check 制約が 'active'/'ended' のみを許容する", () => {
    const match = sql.match(
      /constraint\s+rooms_status_check\s+check\s*\(([\s\S]*?)\)\s*\n?\s*\)\s*;/i,
    );
    expect(match).not.toBeNull();
    const body = match ? match[1] : "";
    expect(body).toMatch(/status\s+in\s*\(\s*'active'\s*,\s*'ended'\s*\)/i);
  });

  it("participants_role_check 制約が存在する", () => {
    expect(sql).toMatch(/constraint\s+participants_role_check\s+check/i);
  });

  // 理由: participants_role_identity_check と同水準で、role の許容値
  // ('owner'/'guest') が意図せず変更・削除された場合に検知する。
  it("participants_role_check 制約が 'owner'/'guest' のみを許容する", () => {
    const match = sql.match(
      /constraint\s+participants_role_check\s+check\s*\(([\s\S]*?)\)\s*,/i,
    );
    expect(match).not.toBeNull();
    const body = match ? match[1] : "";
    expect(body).toMatch(/role\s+in\s*\(\s*'owner'\s*,\s*'guest'\s*\)/i);
  });

  // 理由(bd-fo6レビュー should-fix対応の回帰防止):
  // owner は user_id 必須・guest_cookie_id 禁止、guest は逆、という
  // 相互排他ルールを制約文字列レベルで固定する。
  it("participants_role_identity_check 制約が相互排他形式である", () => {
    const match = sql.match(
      /constraint\s+participants_role_identity_check\s+check\s*\(([\s\S]*?)\n\s*\)\s*;/i,
    );
    expect(match).not.toBeNull();
    const body = match ? match[1] : "";

    // owner 側: user_id は非NULL、guest_cookie_id は NULL
    expect(body).toMatch(
      /role\s*=\s*'owner'\s+and\s+user_id\s+is\s+not\s+null\s+and\s+guest_cookie_id\s+is\s+null/i,
    );

    // guest 側: guest_cookie_id は非NULL、user_id は NULL
    expect(body).toMatch(
      /role\s*=\s*'guest'\s+and\s+guest_cookie_id\s+is\s+not\s+null\s+and\s+user_id\s+is\s+null/i,
    );
  });
});

describe("supabase/migrations/20260705063916_phase2_auth_room.sql: インデックス/一意性ガード", () => {
  const sql = readFile(phase2MigrationPath);

  it("invites.token が unique 制約を持つ", () => {
    expect(sql).toMatch(/token\s+text\s+not\s+null\s+unique/i);
  });

  // 理由: db-design.md のインデックス戦略表に明記されているのにテストが
  // 漏れていた（should-fix対応）。room_id 単一列での参加者検索に使われる。
  it("participants(room_id) のインデックスが存在する", () => {
    expect(sql).toMatch(
      /create\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+public\.participants\s*\(\s*room_id\s*\)/i,
    );
  });

  it("participants(room_id, guest_cookie_id) のインデックスが存在する", () => {
    expect(sql).toMatch(
      /create\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+public\.participants\s*\(\s*room_id\s*,\s*guest_cookie_id\s*\)/i,
    );
  });

  it("rooms(owner_user_id, created_at desc) のインデックスが存在する", () => {
    expect(sql).toMatch(
      /create\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+public\.rooms\s*\(\s*owner_user_id\s*,\s*created_at\s+desc\s*\)/i,
    );
  });
});

describe("supabase/migrations/20260705063916_phase2_auth_room.sql: トリガーガード", () => {
  const sql = readFile(phase2MigrationPath);

  it("handle_new_user 関数が security definer を持つ", () => {
    const match = sql.match(
      /create\s+or\s+replace\s+function\s+public\.handle_new_user[\s\S]*?\$\$;/i,
    );
    expect(match).not.toBeNull();
    const body = match ? match[0] : "";
    expect(body).toMatch(/security\s+definer/i);
  });

  it("handle_new_user 関数が search_path を固定している", () => {
    const match = sql.match(
      /create\s+or\s+replace\s+function\s+public\.handle_new_user[\s\S]*?\$\$;/i,
    );
    expect(match).not.toBeNull();
    const body = match ? match[0] : "";
    // 理由: search_path を固定しないと search_path 汚染攻撃のリスクがある
    expect(body).toMatch(/set\s+search_path\s*=\s*public/i);
  });

  it("on_auth_user_created トリガーが auth.users の insert 後に定義されている", () => {
    expect(sql).toMatch(
      /create\s+trigger\s+on_auth_user_created\s+after\s+insert\s+on\s+auth\.users/i,
    );
  });
});

describe("supabase/seed.sql: seedガード", () => {
  const sql = readFile(seedPath);

  it("free プラン（max_participants=2）の insert が存在する", () => {
    expect(sql).toMatch(
      /insert\s+into\s+public\.plans\s*\([^)]*\)\s*values\s*\(\s*'free'\s*,\s*2\s*\)/i,
    );
  });

  // 理由: seed は複数回実行されうる（ローカル再セットアップ、CI再実行等）ため、
  // 冪等でなければ二重実行時にエラーとなる。
  it("insert が冪等である（on conflict ... do nothing）", () => {
    expect(sql).toMatch(/on\s+conflict\s*\([^)]*\)\s+do\s+nothing/i);
  });
});
