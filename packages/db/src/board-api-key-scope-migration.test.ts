import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0212_cultured_george_stacy.sql";
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

describeEmbeddedPostgres("board API key scope migration", () => {
  it("marks only null-scope existing rows legacy and enforces scoped creates", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-board-key-scope-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    try {
      await sql.unsafe(`
        DROP TABLE board_api_key_authorization_events CASCADE;
        DROP TABLE cli_auth_challenges CASCADE;
        DROP TABLE board_api_keys CASCADE;
        CREATE TABLE board_api_keys (
          id uuid PRIMARY KEY,
          scope_config jsonb
        );
        CREATE TABLE cli_auth_challenges (id uuid PRIMARY KEY);
        INSERT INTO board_api_keys (id, scope_config) VALUES
          ('00000000-0000-4000-8000-000000000001', NULL),
          ('00000000-0000-4000-8000-000000000002', '{"version":999,"malformed":true}'::jsonb);
      `);

      for (const statement of await migrationStatements()) {
        await sql.unsafe(statement);
      }

      const rows = await sql.unsafe<Array<{
        id: string;
        scope_config: unknown;
        token_prefix: string | null;
        legacy_unrestricted: boolean;
      }>>(`
        SELECT id, scope_config, token_prefix, legacy_unrestricted
        FROM board_api_keys
        ORDER BY id
      `);
      expect(rows).toEqual([
        {
          id: "00000000-0000-4000-8000-000000000001",
          scope_config: null,
          token_prefix: null,
          legacy_unrestricted: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          scope_config: { version: 999, malformed: true },
          token_prefix: null,
          legacy_unrestricted: false,
        },
      ]);

      await expect(
        sql.unsafe(`INSERT INTO board_api_keys (id) VALUES ('00000000-0000-4000-8000-000000000003')`),
      ).rejects.toThrow();
      await expect(
        sql.unsafe(`
          INSERT INTO board_api_keys (id, scope_config)
          VALUES ('00000000-0000-4000-8000-000000000004', '{"version":1}'::jsonb)
        `),
      ).resolves.toBeDefined();
      await expect(
        sql.unsafe(`
          INSERT INTO board_api_keys (id, scope_config, legacy_unrestricted)
          VALUES ('00000000-0000-4000-8000-000000000005', '{"version":1}'::jsonb, true)
        `),
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  }, 20_000);
});
