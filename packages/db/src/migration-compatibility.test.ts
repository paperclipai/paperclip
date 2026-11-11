import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_COMPAT_REASON_CODES,
  checkNewMigrationCompatibility,
  classifyMigrationSequence,
  classifyMigrationSql,
  collectCreatedTables,
  parseMigrationCompatOverride,
  parseNonTransactionalMigrations,
  summarizeMigrationCompatibility,
  type MigrationCompatibility,
  type MigrationCompatReasonCode,
} from "./migration-compatibility.js";

const BP = "--> statement-breakpoint\n";
const NEW_TABLE = `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY NOT NULL, "issue_id" uuid);${BP}`;

function codes(sql: string): MigrationCompatReasonCode[] {
  return classifyMigrationSql(sql).reasons.map((reason) => reason.code);
}

type Case = readonly [name: string, sql: string, compatibility: MigrationCompatibility, code: MigrationCompatReasonCode];

const cases: readonly Case[] = [
  // Compatible: additive changes the previous release never touches.
  ["create table", `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "issue_id" uuid REFERENCES "issues"("id"));`, "online_compatible", "create_table"],
  ["create table if not exists", `CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid PRIMARY KEY);`, "online_compatible", "create_table_if_not_exists"],
  ["create temp table", `CREATE TEMP TABLE scratch (old_id uuid) ON COMMIT DROP;`, "online_compatible", "create_temp_table"],
  ["plain index on a table created here", `${NEW_TABLE}CREATE UNIQUE INDEX "widgets_uq" ON "widgets" USING btree ("issue_id");`, "online_compatible", "create_index_new_table"],
  ["constraints on a table created here", `${NEW_TABLE}ALTER TABLE "widgets" ADD CONSTRAINT "widgets_issue_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;`, "online_compatible", "alter_new_table"],
  ["trigger on a table created here", `${NEW_TABLE}CREATE TRIGGER widgets_touch BEFORE UPDATE OF issue_id ON "widgets" FOR EACH ROW EXECUTE FUNCTION touch();`, "online_compatible", "create_trigger_new_table"],
  ["constant rows in a table created here", `${NEW_TABLE}INSERT INTO "widgets" ("id") VALUES ('00000000-0000-0000-0000-000000000001');`, "online_compatible", "seed_new_table"],
  ["concurrent index", `CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_x_idx" ON "issues" USING btree ("company_id","id") WHERE "issues"."status" = 'done';`, "online_compatible", "create_index_concurrently"],
  ["nullable column", `ALTER TABLE "issues" ADD COLUMN "time_zone" text;`, "online_compatible", "add_column"],
  ["column with a constant default", `ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;`, "online_compatible", "add_column"],
  ["column with a cast literal default", `ALTER TABLE "issues" ADD COLUMN "meta" jsonb NOT NULL DEFAULT '{"a": "b, c"}'::jsonb;`, "online_compatible", "add_column"],
  ["column with a stable timestamp default", `ALTER TABLE "issues" ADD COLUMN "seen_at" timestamp with time zone DEFAULT now() NOT NULL;`, "online_compatible", "add_column"],
  ["several additive actions", `ALTER TABLE "issues" ADD COLUMN "a" text, ADD COLUMN "b" numeric(24, 7) DEFAULT '0' NOT NULL;`, "online_compatible", "add_column"],
  ["foreign key added NOT VALID", `ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") NOT VALID;`, "online_compatible", "add_constraint_not_valid"],
  ["check added NOT VALID", `ALTER TABLE "issues" ADD CONSTRAINT "issues_kind_check" CHECK ("kind" IN ('a', 'b')) NOT VALID;`, "online_compatible", "add_constraint_not_valid"],
  ["drop not null", `ALTER TABLE "issues" ALTER COLUMN "title" DROP NOT NULL;`, "online_compatible", "drop_not_null"],
  ["create enum", `CREATE TYPE "public"."mood" AS ENUM('sad', 'ok');`, "online_compatible", "create_type"],
  ["add enum value", `ALTER TYPE "public"."mood" ADD VALUE IF NOT EXISTS 'happy';`, "online_compatible", "add_enum_value"],
  ["create sequence", `CREATE SEQUENCE "issue_numbers";`, "online_compatible", "create_sequence"],
  ["create extension", `CREATE EXTENSION IF NOT EXISTS "pg_trgm";`, "online_compatible", "create_extension"],
  ["new function", `CREATE FUNCTION touch() RETURNS trigger AS $fn$ BEGIN DELETE FROM issues; RETURN NEW; END; $fn$ LANGUAGE plpgsql;`, "online_compatible", "create_function"],
  ["new view", `CREATE VIEW "open_issues" AS SELECT * FROM "issues";`, "online_compatible", "create_view"],
  ["comment", `COMMENT ON COLUMN "issues"."title" IS 'DROP TABLE issues; is only text here';`, "online_compatible", "comment"],
  ["no-op select", `SELECT 1;`, "online_compatible", "no_op"],
  ["analyze", `ANALYZE "issues";`, "online_compatible", "analyze"],
  ["extended statistics", `CREATE STATISTICS IF NOT EXISTS "s" ON ("a"), ("b") FROM "issues";`, "online_compatible", "create_statistics"],
  ["guarded DO block around an additive statement", `DO $$ BEGIN\n IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x' AND conrelid = 'issues'::regclass) THEN\n  ALTER TABLE "issues" ADD CONSTRAINT "x" FOREIGN KEY ("a") REFERENCES "b"("id") NOT VALID;\n END IF;\nEND $$;`, "online_compatible", "add_constraint_not_valid"],
  ["duplicate-tolerant DO block on a table created here", `${NEW_TABLE}DO $$ BEGIN\n ALTER TABLE "widgets" ADD CONSTRAINT "w_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade;\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$;`, "online_compatible", "alter_new_table"],

  // Requires staging: the previous release breaks or its writes are rejected.
  ["drop table", `DROP TABLE IF EXISTS "widgets" CASCADE;`, "requires_staging", "drop_table"],
  ["drop column", `ALTER TABLE "issues" DROP COLUMN IF EXISTS "legacy";`, "requires_staging", "drop_column"],
  ["rename table", `ALTER TABLE "issues" RENAME TO "tasks";`, "requires_staging", "rename_table"],
  ["rename column", `ALTER TABLE "issues" RENAME COLUMN "title" TO "name";`, "requires_staging", "rename_column"],
  ["alter column type", `ALTER TABLE "issues" ALTER COLUMN "number" SET DATA TYPE bigint USING "number"::bigint;`, "requires_staging", "alter_column_type"],
  ["set not null on an existing column", `ALTER TABLE "issues" ALTER COLUMN "title" SET NOT NULL;`, "requires_staging", "set_not_null"],
  ["not null column without a default", `ALTER TABLE "issues" ADD COLUMN "public_id" varchar(128) NOT NULL;`, "requires_staging", "add_not_null_column_without_default"],
  ["drop default", `ALTER TABLE "issues" ALTER COLUMN "status" DROP DEFAULT;`, "requires_staging", "drop_default"],
  ["validated check", `ALTER TABLE "issues" ADD CONSTRAINT "issues_kind_check" CHECK ("kind" IN ('a', 'b'));`, "requires_staging", "add_validated_check"],
  ["unique constraint", `ALTER TABLE "issues" ADD CONSTRAINT "issues_uq" UNIQUE("company_id","number");`, "requires_staging", "add_unique_constraint"],
  ["unique index on an existing table", `CREATE UNIQUE INDEX CONCURRENTLY "issues_uq" ON "issues" ("company_id","number");`, "requires_staging", "create_unique_index_existing_table"],
  ["drop type", `DROP TYPE "public"."mood";`, "requires_staging", "drop_type"],
  ["rename enum value", `ALTER TYPE "mood" RENAME VALUE 'ok' TO 'fine';`, "requires_staging", "rename_type"],
  ["truncate", `TRUNCATE TABLE "issues";`, "requires_staging", "truncate"],
  ["delete", `DELETE FROM "issues" WHERE "status" = 'cancelled';`, "requires_staging", "delete_rows"],
  ["delete inside a CTE", `WITH ranked AS (SELECT id FROM issues) DELETE FROM "issues" i USING ranked r WHERE i.id = r.id;`, "requires_staging", "delete_rows"],
  ["guarded DO block around a validated check", `DO $$ BEGIN\n ALTER TABLE "issues" ADD CONSTRAINT "c" CHECK ("a" > 0);\nEXCEPTION WHEN duplicate_object THEN null;\nEND $$;`, "requires_staging", "add_validated_check"],

  // Lock and duration hazards: unknown, reported under lock_hazard_ codes.
  ["plain index on an existing table", `CREATE INDEX IF NOT EXISTS "issues_x_idx" ON "issues" USING btree ("company_id");`, "unknown", "lock_hazard_create_index"],
  ["validated foreign key on an existing table", `ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;`, "unknown", "lock_hazard_validated_foreign_key"],
  ["validated foreign key in a guarded DO block", `DO $$ BEGIN\n IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN\n  ALTER TABLE "issues" ADD CONSTRAINT "x" FOREIGN KEY ("a") REFERENCES "b"("id");\n END IF;\nEND $$;`, "unknown", "lock_hazard_validated_foreign_key"],
  ["validate constraint", `ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_owner_fk";`, "unknown", "lock_hazard_validate_constraint"],
  ["set not null on a column added here", `ALTER TABLE "issues" ADD COLUMN "kind" text DEFAULT 'task';${BP}ALTER TABLE "issues" ALTER COLUMN "kind" SET NOT NULL;`, "unknown", "lock_hazard_set_not_null"],
  ["column with a volatile default", `ALTER TABLE "issues" ADD COLUMN "token" uuid DEFAULT gen_random_uuid() NOT NULL;`, "unknown", "lock_hazard_table_rewrite"],
  ["generated column", `ALTER TABLE "issues" ADD COLUMN "n" bigint GENERATED ALWAYS AS IDENTITY;`, "unknown", "lock_hazard_table_rewrite"],
  ["column with an inline foreign key", `ALTER TABLE "issues" ADD COLUMN "owner_id" uuid REFERENCES "users"("id");`, "unknown", "lock_hazard_add_column_constraint"],
  ["update backfill", `UPDATE "issues" SET "kind" = 'task' WHERE "kind" IS NULL;`, "unknown", "lock_hazard_data_backfill"],
  ["CTE backfill", `WITH ranked AS (SELECT id FROM issues) UPDATE "issues" i SET n = 1 FROM ranked r WHERE i.id = r.id;`, "unknown", "lock_hazard_data_backfill"],
  ["batched backfill loop", `DO $$ DECLARE n integer; BEGIN LOOP UPDATE issues SET a = 1 WHERE id IN (SELECT id FROM issues LIMIT 1000); GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0; END LOOP; END $$;`, "unknown", "lock_hazard_data_backfill"],
  ["copy from live tables into a new table", `${NEW_TABLE}INSERT INTO "widgets" ("id") SELECT "id" FROM "issues";`, "unknown", "lock_hazard_copy_into_new_table"],
  ["lock table", `LOCK TABLE "issues" IN ACCESS EXCLUSIVE MODE;`, "unknown", "lock_hazard_lock_table"],

  // Unknown: not positively recognized, or it changes what old code experiences.
  ["insert into an existing table", `INSERT INTO "issues" ("id") VALUES ('1');`, "unknown", "data_change_existing_table"],
  ["set default", `ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'todo';`, "unknown", "set_default"],
  ["drop constraint", `ALTER TABLE "issues" DROP CONSTRAINT "issues_owner_fk";`, "unknown", "drop_constraint"],
  ["drop index", `DROP INDEX IF EXISTS "issues_x_idx";`, "unknown", "drop_index"],
  ["drop trigger", `DROP TRIGGER IF EXISTS t ON "issues";`, "unknown", "drop_object"],
  ["constraint from an existing index", `ALTER TABLE "issues" ADD CONSTRAINT "issues_uq" UNIQUE USING INDEX "issues_uq_idx";`, "unknown", "add_constraint_other"],
  ["replace function", `CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;`, "unknown", "replace_function"],
  ["replace view", `CREATE OR REPLACE VIEW "open_issues" AS SELECT * FROM "issues";`, "unknown", "replace_view"],
  ["trigger on an existing table", `CREATE TRIGGER t BEFORE INSERT OR UPDATE OF a, b ON "issues" FOR EACH ROW EXECUTE FUNCTION touch();`, "unknown", "create_trigger_existing_table"],
  ["create table as", `CREATE TABLE "issues_copy" AS SELECT * FROM "issues";`, "unknown", "create_table_as"],
  ["procedural DO block", `DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN x text', 'issues'); END $$;`, "unknown", "do_block_procedural"],
  ["DO block with an unrecognized guard", `DO $$ BEGIN IF current_setting('x') = 'y' THEN ALTER TABLE "issues" ADD COLUMN "a" text; END IF; END $$;`, "unknown", "do_block_procedural"],
  ["DO block that raises", `DO $$ BEGIN IF EXISTS (SELECT 1 FROM issues) THEN RAISE EXCEPTION 'no'; END IF; END $$;`, "unknown", "do_block_procedural"],
  ["unrecognized alter table action", `ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;`, "unknown", "unrecognized_alter_table_action"],
  ["unrecognized statement", `GRANT SELECT ON "issues" TO reader;`, "unknown", "unrecognized_statement"],
  ["vacuum", `VACUUM FULL "issues";`, "unknown", "unrecognized_statement"],
  ["empty file", `-- nothing here\n`, "unknown", "no_statements"],
];

describe("classifyMigrationSql", () => {
  it.each(cases)("%s", (_name, sql, compatibility, code) => {
    const result = classifyMigrationSql(sql);
    expect(result.reasons.map((reason) => reason.code)).toContain(code);
    expect(result.compatibility).toBe(compatibility);
    expect(result.classified).toBe(compatibility);
    expect(result.override).toBeNull();
  });

  it("has a test case for every reason code", () => {
    const covered = new Set<string>([...cases.map((entry) => entry[3]), "invalid_override"]);
    expect(MIGRATION_COMPAT_REASON_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  it("takes the worst statement: staging over unknown over compatible", () => {
    const additive = `ALTER TABLE "issues" ADD COLUMN "a" text;`;
    const hazard = `CREATE INDEX "i" ON "issues" ("a");`;
    const breaking = `ALTER TABLE "issues" DROP COLUMN "b";`;
    expect(classifyMigrationSql([additive, hazard].join(BP)).compatibility).toBe("unknown");
    expect(classifyMigrationSql([additive, hazard, breaking].join(BP)).compatibility).toBe("requires_staging");
    expect(classifyMigrationSql([additive, hazard, breaking].join(BP)).reasons).toEqual([
      expect.objectContaining({ code: "add_column", compatibility: "online_compatible", statements: [1] }),
      expect.objectContaining({ code: "lock_hazard_create_index", compatibility: "unknown", statements: [2] }),
      expect.objectContaining({ code: "drop_column", compatibility: "requires_staging", statements: [3] }),
    ]);
  });

  it("splits statements that share a chunk without a breakpoint", () => {
    expect(codes(`ALTER TABLE "issues" ADD COLUMN "a" text;\nDROP TABLE "issues";`)).toEqual(["add_column", "drop_table"]);
  });

  it("classifies each action of a multi-action ALTER TABLE", () => {
    expect(codes(`ALTER TABLE "issues" ADD COLUMN "a" text, DROP COLUMN "b", ALTER COLUMN "c" TYPE bigint;`))
      .toEqual(["add_column", "drop_column", "alter_column_type"]);
  });

  it("does not let comments or string contents hide or invent statements", () => {
    expect(classifyMigrationSql(`-- DROP TABLE "issues";\n/* TRUNCATE issues; */\nALTER TABLE "issues" ADD COLUMN "a" text DEFAULT 'x; DROP TABLE issues;';`).compatibility)
      .toBe("online_compatible");
    expect(classifyMigrationSql(`COMMENT ON TABLE "issues" IS E'it\\'s';${BP}DROP TABLE "issues";`).compatibility).toBe("requires_staging");
    expect(classifyMigrationSql(`COMMENT ON TABLE "issues" IS 'it''s';\nDROP TABLE "issues";`).compatibility).toBe("requires_staging");
  });

  it("keeps a quoted identifier with an escaped quote distinct from other names", () => {
    // "iss""ues" is a table named iss"ues, not issues.
    const sql = `CREATE TABLE "iss""ues" (id uuid);${BP}DROP TABLE "issues";${BP}ALTER TABLE issues DROP COLUMN title;`;
    expect(codes(sql)).toEqual(["create_table", "drop_table", "drop_column"]);
    expect(classifyMigrationSql(sql).compatibility).toBe("requires_staging");
    expect(collectCreatedTables(sql)).toEqual(['"iss%22ues"']);
    expect(classifyMigrationSql(`CREATE TABLE "iss""ues" (id uuid);${BP}CREATE INDEX i ON "iss""ues" (id);`).compatibility).toBe("online_compatible");
    expect(classifyMigrationSql(`CREATE TABLE "Issues" (id uuid);${BP}DROP TABLE issues;`).compatibility).toBe("requires_staging");
  });

  it("treats quoted, unquoted and schema-qualified names of a new table alike", () => {
    expect(classifyMigrationSql(`CREATE TABLE public.widgets (id uuid);${BP}CREATE INDEX "w" ON "widgets" (id);${BP}ALTER TABLE "public"."widgets" ADD COLUMN a text NOT NULL;`).compatibility)
      .toBe("online_compatible");
  });

  it("does not take CREATE TABLE IF NOT EXISTS as proof that a table is new", () => {
    const sql = `CREATE TABLE IF NOT EXISTS issues (id uuid);${BP}ALTER TABLE issues DROP COLUMN title;${BP}CREATE INDEX "i" ON issues (id);`;
    expect(classifyMigrationSql(sql)).toMatchObject({ compatibility: "requires_staging" });
    expect(codes(sql)).toEqual(["create_table_if_not_exists", "drop_column", "lock_hazard_create_index"]);
    // An earlier migration created the table: it exists.
    expect(classifyMigrationSql(sql, { existingTables: new Set(["issues"]) }).compatibility).toBe("requires_staging");
    // No earlier migration created it: the table is new, whatever the spelling.
    expect(classifyMigrationSql(sql, { existingTables: new Set(["projects"]) }).compatibility).toBe("online_compatible");
    expect(classifyMigrationSql(sql.replace("issues (id uuid)", `"public"."issues" (id uuid)`), { existingTables: new Set() }).compatibility)
      .toBe("online_compatible");
    // A temporary table always belongs to the migration session.
    expect(classifyMigrationSql(`CREATE TEMP TABLE IF NOT EXISTS scratch (id uuid);${BP}DROP TABLE scratch;`).compatibility).toBe("online_compatible");
  });

  it("classifies a sequence knowing the tables earlier migrations created", () => {
    const create = `DO $$ BEGIN IF to_regclass('public.widgets') IS NULL THEN CREATE TABLE "widgets" ("id" uuid); END IF; END $$;`;
    const repair = `CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid);${BP}ALTER TABLE "widgets" ADD COLUMN "n" integer NOT NULL;`;
    const rename = `ALTER TABLE "widgets" RENAME TO "gadgets";`;
    const again = `CREATE TABLE IF NOT EXISTS "gadgets" ("id" uuid);${BP}CREATE INDEX "g" ON "gadgets" ("id");`;
    expect(collectCreatedTables(create)).toEqual(["widgets"]);
    expect(collectCreatedTables(rename)).toEqual(["gadgets"]);
    expect(classifyMigrationSequence([repair, create, repair, rename, again]).map((result) => result.compatibility))
      .toEqual(["online_compatible", "online_compatible", "requires_staging", "requires_staging", "unknown"]);
    expect(classifyMigrationSequence([repair], [create])[0].compatibility).toBe("requires_staging");
  });

  it("reports whether a migration needs to run outside a transaction", () => {
    expect(classifyMigrationSql(`CREATE INDEX CONCURRENTLY "i" ON "issues" ("a");`).usesConcurrently).toBe(true);
    expect(classifyMigrationSql(`DROP INDEX CONCURRENTLY IF EXISTS "i";`).usesConcurrently).toBe(true);
    expect(classifyMigrationSql(`COMMENT ON TABLE "issues" IS 'built CONCURRENTLY';${BP}CREATE INDEX "i" ON "issues" ("a");`).usesConcurrently).toBe(false);
  });

  it("does not treat an existing table as new because another table was created", () => {
    expect(classifyMigrationSql(`${NEW_TABLE}CREATE INDEX "i" ON "widgets_archive" ("id");`).compatibility).toBe("unknown");
  });

  it("never classifies an unrecognized ADD CONSTRAINT form as a column", () => {
    expect(codes(`ALTER TABLE "issues" ADD CONSTRAINT "c" NOT NULL "title";`)).toEqual(["add_constraint_other"]);
  });

  it("classifies every statement inside a guarded DO block", () => {
    const sql = `DO $$ BEGIN\n IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN\n  ALTER TABLE "issues" DROP CONSTRAINT "x";\n END IF;\n ALTER TABLE "issues" ADD CONSTRAINT "x" FOREIGN KEY ("a") REFERENCES "b"("id") NOT VALID;\nEND $$;`;
    expect(codes(sql)).toEqual(["drop_constraint", "add_constraint_not_valid"]);
  });
});

describe("migration-compat override", () => {
  const hazard = `CREATE INDEX "i" ON "issues" ("a");`;

  it("replaces the verdict and keeps the classifier's own result", () => {
    const result = classifyMigrationSql(`-- paperclip:migration-compat online_compatible: issues has under 1k rows on every stack\n${hazard}`);
    expect(result).toMatchObject({
      compatibility: "online_compatible",
      classified: "unknown",
      override: { compatibility: "online_compatible", justification: "issues has under 1k rows on every stack" },
      overrideError: null,
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(["lock_hazard_create_index"]);
  });

  it("can mark a contract migration compatible and an additive one staged", () => {
    expect(classifyMigrationSql(`-- Contract step.\n\n-- paperclip:migration-compat online_compatible: no release since v0.3 reads issues.legacy\nALTER TABLE "issues" DROP COLUMN "legacy";`))
      .toMatchObject({ compatibility: "online_compatible", classified: "requires_staging" });
    expect(classifyMigrationSql(`-- paperclip:migration-compat requires_staging: old servers crash on the new enum value\nALTER TYPE "mood" ADD VALUE 'x';`))
      .toMatchObject({ compatibility: "requires_staging", classified: "online_compatible" });
  });

  it.each([
    ["missing justification", `-- paperclip:migration-compat online_compatible\n${hazard}`],
    ["empty justification", `-- paperclip:migration-compat online_compatible:   \n${hazard}`],
    ["token justification", `-- paperclip:migration-compat online_compatible: ok\n${hazard}`],
    ["unknown value", `-- paperclip:migration-compat unknown: we could not decide today\n${hazard}`],
    ["unsupported value", `-- paperclip:migration-compat safe: this one is certainly fine\n${hazard}`],
    ["missing colon", `-- paperclip:migration-compat online_compatible because it is fine\n${hazard}`],
    ["two directives", `-- paperclip:migration-compat online_compatible: the table is tiny everywhere\n-- paperclip:migration-compat requires_staging: or maybe it is not\n${hazard}`],
    ["after the first statement", `${hazard}\n-- paperclip:migration-compat online_compatible: the table is tiny everywhere\n`],
    ["inside a block comment", `/* paperclip:migration-compat online_compatible: the table is tiny everywhere */\n${hazard}`],
    ["on a breakpoint line", `--> statement-breakpoint paperclip:migration-compat online_compatible: the table is tiny\n${hazard}`],
  ])("rejects an override with %s", (_name, sql) => {
    const result = classifyMigrationSql(sql);
    expect(result.override).toBeNull();
    expect(result.overrideError).toMatch(/paperclip:migration-compat/);
    expect(result.compatibility).toBe("unknown");
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_override");
  });

  it("never lets a rejected override improve the verdict", () => {
    expect(classifyMigrationSql(`-- paperclip:migration-compat online_compatible\nDROP TABLE "issues";`).compatibility).toBe("requires_staging");
    expect(classifyMigrationSql(`-- paperclip:migration-compat online_compatible\nALTER TABLE "issues" ADD COLUMN "a" text;`).compatibility).toBe("unknown");
  });

  it("reads nothing when the file has no directive", () => {
    expect(parseMigrationCompatOverride(`-- An ordinary comment about compat.\n${hazard}`)).toEqual({ override: null, error: null });
  });
});

describe("checkNewMigrationCompatibility", () => {
  const additive = { fileName: "0500_additive.sql", sql: `ALTER TABLE "issues" ADD COLUMN "a" text;` };
  const unknown = { fileName: "0501_unknown.sql", sql: `CREATE INDEX "i" ON "issues" ("a");${BP}UPDATE "issues" SET a = 'x';` };
  const staged = { fileName: "0502_staged.sql", sql: `ALTER TABLE "issues" DROP COLUMN "a";` };

  it("passes with no new migrations and with compatible ones", () => {
    expect(checkNewMigrationCompatibility([])).toMatchObject({ passed: true, errors: [], notices: [] });
    expect(checkNewMigrationCompatibility([additive])).toMatchObject({ passed: true, errors: [], notices: [] });
  });

  it("fails an unknown migration and tells the author what to do", () => {
    const result = checkNewMigrationCompatibility([additive, unknown]);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error).toContain("0501_unknown.sql");
    expect(error).toContain("lock_hazard_create_index (statement 1)");
    expect(error).toContain("lock_hazard_data_backfill (statement 2)");
    expect(error).toContain("CREATE INDEX CONCURRENTLY");
    expect(error).toContain("expand migration now and a contract migration in a later release");
    expect(error).toContain("-- paperclip:migration-compat online_compatible: <why");
    expect(error).toContain("-- paperclip:migration-compat requires_staging: <what");
    expect(error).toContain("doc/DATABASE.md");
  });

  it("passes an unknown migration that carries a justified override, with a notice", () => {
    const result = checkNewMigrationCompatibility([{ ...unknown, sql: `-- paperclip:migration-compat online_compatible: issues is small and the update is idempotent\n${unknown.sql}` }]);
    expect(result).toMatchObject({ passed: true, errors: [] });
    expect(result.notices).toEqual([expect.stringMatching(/0501_unknown\.sql: online_compatible by override \(classifier said unknown\): issues is small/)]);
  });

  it("fails an override without a justification, even on a compatible migration", () => {
    const result = checkNewMigrationCompatibility([{ ...additive, sql: `-- paperclip:migration-compat online_compatible:\n${additive.sql}` }]);
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/0500_additive\.sql: .*needs a justification/)]);
  });

  it("fails a CONCURRENTLY migration that the migrator would run inside a transaction", () => {
    const concurrent = { fileName: "packages/db/src/migrations/0503_index.sql", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "issues" ("a");` };
    const result = checkNewMigrationCompatibility([concurrent], { nonTransactionalMigrations: new Set(["0313_private_task_access.sql"]) });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/0503_index\.sql: uses CONCURRENTLY[\s\S]*Add "0503_index\.sql" to MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS in packages\/db\/src\/client\.ts/)]);
    expect(checkNewMigrationCompatibility([concurrent], { nonTransactionalMigrations: new Set(["0503_index.sql"]) }).passed).toBe(true);
    // Without the list (a caller that cannot read the migrator) the check is skipped.
    expect(checkNewMigrationCompatibility([concurrent]).passed).toBe(true);
  });

  it("judges new migrations after the ones already on the target branch", () => {
    const repair = { fileName: "0504_repair.sql", sql: `CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid);${BP}CREATE INDEX "w" ON "widgets" ("id");` };
    expect(checkNewMigrationCompatibility([repair], { priorMigrationSql: [] }).passed).toBe(true);
    expect(checkNewMigrationCompatibility([repair], { priorMigrationSql: [`CREATE TABLE "widgets" ("id" uuid);`] }).passed).toBe(false);
    expect(checkNewMigrationCompatibility([repair]).passed).toBe(false);
    // The second new migration sees the table the first one created.
    expect(checkNewMigrationCompatibility([repair, { ...repair, fileName: "0505_again.sql" }], { priorMigrationSql: [] }).errors)
      .toEqual([expect.stringContaining("0505_again.sql")]);
  });

  it("does not fail requires_staging, and prints a notice instead", () => {
    const result = checkNewMigrationCompatibility([staged]);
    expect(result).toMatchObject({ passed: true, errors: [] });
    expect(result.notices).toEqual([expect.stringMatching(/0502_staged\.sql: requires_staging[\s\S]*drop_column \(statement 1\)[\s\S]*does not fail the check yet/)]);
  });
});

describe("the shipped migrations", () => {
  const dbDir = fileURLToPath(new URL("..", import.meta.url));
  const migrationsDir = `${dbDir}src/migrations`;
  const journal = JSON.parse(readFileSync(`${migrationsDir}/meta/_journal.json`, "utf8")) as { entries: { idx: number; tag: string }[] };
  const files = [...journal.entries]
    .sort((left, right) => left.idx - right.idx || left.tag.localeCompare(right.tag))
    .map((entry) => `${entry.tag}.sql`);
  const classified = classifyMigrationSequence(files.map((file) => readFileSync(`${migrationsDir}/${file}`, "utf8")));
  const results = files.map((file, index) => ({ file, result: classified[index] }));

  it("classifies every file without an invalid override and with a consistent summary", () => {
    expect(results.filter(({ result }) => result.overrideError).map(({ file }) => file)).toEqual([]);
    const summary = summarizeMigrationCompatibility(results.map(({ result }) => result));
    expect(summary.total).toBe(results.length);
    expect(Object.values(summary.byCompatibility).reduce((sum, count) => sum + count, 0)).toBe(results.length);
    // The rules must keep recognizing the common additive shapes.
    expect(summary.byCompatibility.online_compatible).toBeGreaterThan(results.length * 0.4);
  });

  it("keeps known hazardous migrations out of online_compatible", () => {
    const verdict = (prefix: string) => results.find(({ file }) => file.startsWith(prefix))?.result.compatibility;
    // 0224 adds a NOT NULL column without a default to a live table.
    expect(verdict("0224_")).toBe("requires_staging");
    // 0313 backfills privacy columns in batched loops.
    expect(verdict("0313_")).not.toBe("online_compatible");
    // 0466 drops a column the previous release wrote.
    expect(verdict("0466_")).toBe("requires_staging");
  });

  it("finds the migrator's non-transactional list, which holds every CONCURRENTLY migration", () => {
    const listed = parseNonTransactionalMigrations(readFileSync(`${dbDir}src/client.ts`, "utf8"));
    expect(listed?.has("0313_private_task_access.sql")).toBe(true);
    expect(results.filter(({ file, result }) => result.usesConcurrently && !listed?.has(file)).map(({ file }) => file)).toEqual([]);
    expect(parseNonTransactionalMigrations("const other = new Set([]);")).toBeNull();
  });

  it("classifies the files named on the command line, after the migrations that precede them", () => {
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/migration-compatibility.ts", ...args], { cwd: dbDir, encoding: "utf8" });
    const one = run("src/migrations/0224_unified_adapter_auth_sessions.sql");
    expect(one).toMatch(/^0224_unified_adapter_auth_sessions\.sql: requires_staging\n/);
    expect(one).toContain("add_not_null_column_without_default");
    expect(one.match(/^\S+\.sql: /gm)).toHaveLength(1);
    const two = JSON.parse(run("--json", "src/migrations/0468_busy_wendell_rand.sql", "src/migrations/0466_drop_project_environment.sql")) as { fileName: string; compatibility: string }[];
    expect(two.map(({ fileName, compatibility }) => [fileName, compatibility])).toEqual([
      ["0468_busy_wendell_rand.sql", "online_compatible"],
      ["0466_drop_project_environment.sql", "requires_staging"],
    ]);
  }, 60_000);
});
