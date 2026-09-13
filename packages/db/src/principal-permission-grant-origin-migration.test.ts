import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0278_natural_nehzno.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describeEmbeddedPostgres("principal permission grant origin migration", () => {
  it("preserves ambiguous historical grants with unknown provenance", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-grant-origin-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    try {
      await sql.unsafe(`
        DROP TABLE principal_permission_grants CASCADE;
        DROP TABLE company_memberships CASCADE;
        DROP TABLE activity_log CASCADE;
        DROP TABLE join_requests CASCADE;
        CREATE TABLE company_memberships (
          id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          principal_type text NOT NULL,
          principal_id text NOT NULL,
          status text NOT NULL,
          membership_role text
        );
        CREATE TABLE principal_permission_grants (
          id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          principal_type text NOT NULL,
          principal_id text NOT NULL,
          permission_key text NOT NULL,
          scope jsonb,
          granted_by_user_id text
        );
        CREATE TABLE activity_log (
          company_id uuid NOT NULL,
          action text NOT NULL,
          entity_type text NOT NULL,
          entity_id text NOT NULL
        );
        CREATE TABLE join_requests (
          company_id uuid NOT NULL,
          request_type text NOT NULL,
          requesting_user_id text,
          status text NOT NULL
        );
        INSERT INTO company_memberships VALUES
          ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'user', 'owner', 'active', 'owner'),
          ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'user', 'admin', 'active', 'admin'),
          ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', 'user', 'operator', 'active', 'member'),
          ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000001', 'user', 'plugin-user', 'active', 'admin'),
          ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000001', 'user', 'invite-user', 'active', 'admin'),
          ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000001', 'user', 'edited-user', 'active', 'admin');
        INSERT INTO principal_permission_grants VALUES
          ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'user', 'owner', 'users:manage_permissions', NULL, NULL),
          ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'user', 'admin', 'tools:use', NULL, NULL),
          ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'user', 'operator', 'tasks:assign', NULL, NULL),
          ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'user', 'owner', 'tools:use', '{"projectId":"project-1"}', NULL),
          ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001', 'user', 'owner', 'tools:use', NULL, 'grant-author'),
          ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000001', 'user', 'admin', 'users:manage_permissions', NULL, NULL),
          ('00000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000001', 'agent', 'owner', 'tools:use', NULL, NULL),
          ('00000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-000000000001', 'user', 'plugin-user', 'tools:use', NULL, NULL),
          ('00000000-0000-4000-8000-000000000018', '00000000-0000-4000-8000-000000000001', 'user', 'invite-user', 'tools:use', NULL, NULL),
          ('00000000-0000-4000-8000-000000000019', '00000000-0000-4000-8000-000000000001', 'user', 'edited-user', 'tools:use', NULL, NULL);
        INSERT INTO activity_log VALUES
          ('00000000-0000-4000-8000-000000000001', 'authorization.grants_updated_by_plugin', 'principal_permission_grants', 'user:plugin-user'),
          ('00000000-0000-4000-8000-000000000001', 'company_member.permissions_updated', 'company_membership', '00000000-0000-4000-8000-000000000106');
        INSERT INTO join_requests VALUES
          ('00000000-0000-4000-8000-000000000001', 'human', 'invite-user', 'approved');
      `);

      for (const statement of await migrationStatements()) {
        await sql.unsafe(statement);
      }
      await sql.unsafe(`
        INSERT INTO principal_permission_grants (
          id, company_id, principal_type, principal_id, permission_key, scope, granted_by_user_id
        ) VALUES (
          '00000000-0000-4000-8000-000000000020',
          '00000000-0000-4000-8000-000000000001',
          'user',
          'new-user',
          'tools:use',
          NULL,
          NULL
        )
      `);

      const rows = await sql.unsafe<Array<{ id: string; grant_origin: string }>>(`
        SELECT id, grant_origin
        FROM principal_permission_grants
        ORDER BY id
      `);
      expect(rows).toEqual([
        { id: "00000000-0000-4000-8000-000000000010", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000011", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000012", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000013", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000014", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000015", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000016", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000017", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000018", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000019", grant_origin: "legacy_unknown" },
        { id: "00000000-0000-4000-8000-000000000020", grant_origin: "explicit" },
      ]);
    } finally {
      await sql.end();
    }
  }, 20_000);
});
