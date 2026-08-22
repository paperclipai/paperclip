import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(path.join(import.meta.dirname, "migrations/0227_third_devos.sql"), "utf8");

describe("connection grants phase 2 migration", () => {
  it("renames workspace grants before restoring organization-only constraints", () => {
    const rename = sql.indexOf(`UPDATE "connection_grants" SET "kind" = 'organization' WHERE "kind" = 'workspace'`);
    const constraint = sql.indexOf(`"connection_grants"."kind" in ('organization', 'user')`);
    expect(rename).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(rename);
    expect(sql).not.toContain(`CHECK ("connection_grants"."kind" in ('workspace', 'user'))`);
  });

  it("backfills a default organization grant only when a connection is missing one", () => {
    expect(sql).toContain(`c."id", 'organization', c."credential_secret_refs", 'active', true`);
    expect(sql).toContain(`WHERE NOT EXISTS`);
    expect(sql).toContain(`g."connection_id" = c."id" AND g."is_default" = true`);
  });

  it("adds credential policy and the grant audience table", () => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "connection_grant_members"`);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "credential_policy" text DEFAULT 'shared' NOT NULL`);
    expect(sql).toContain(`'shared', 'per_user', 'per_user_with_fallback'`);
  });

  it("is safe to replay when schema state is ahead of the migration journal", () => {
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "connection_grant_members_company_grant_fk"`);
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "tool_connections_credential_policy_check"`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "connection_grants_default_uq"`);
    expect(sql).toContain(`IF NOT EXISTS (\n\t\tSELECT 1\n\t\tFROM pg_constraint`);
  });
});
