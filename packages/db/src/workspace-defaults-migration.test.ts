import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migration = await readFile(new URL("./migrations/0433_workspace_defaults.sql", import.meta.url), "utf8");
const support = await getEmbeddedPostgresTestSupport();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

(support.supported ? describe : describe.skip)("standard workspace defaults", () => {
  it("defaults new people to Coordinator", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-defaults-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await sql`SELECT user_id FROM user_workspace_preferences`).toHaveLength(0);
      const [row] = await sql`INSERT INTO user_workspace_preferences (user_id) VALUES ('new-person') RETURNING coordinator_workspace_enabled`;
      expect(row.coordinator_workspace_enabled).toBe(true);
    } finally { await sql.end(); }
  }, 30_000);

  it.each([null, true, false])("preserves legacy preferences and unrelated instance storage (%s) on upgrade and replay", async chat => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-defaults-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Existing company', 'OLD')`;
      for (const id of ['unchanged-classic', 'saved-coordinator', 'saved-classic']) {
        await sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${id}, ${id}, ${id + '@example.test'}, now(), now())`;
      }
      await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id) VALUES (${companyId}, 'user', 'existing-member')`;
      await sql`INSERT INTO user_workspace_preferences (user_id, coordinator_workspace_enabled) VALUES ('saved-coordinator', true), ('saved-classic', false)`;
      const settings = { enableStatusCards: true, ...(chat === null ? {} : { enableAgentChat: chat }) };
      await sql`INSERT INTO instance_settings (singleton_key, experimental) VALUES ('default', ${sql.json(settings)}) ON CONFLICT (singleton_key) DO UPDATE SET experimental = EXCLUDED.experimental`;
      for (let replay = 0; replay < 2; replay++) {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await sql.unsafe(statement);
        }
      }
      const rows = await sql`SELECT user_id, coordinator_workspace_enabled FROM user_workspace_preferences`;
      expect(Object.fromEntries(rows.map(row => [row.user_id, row.coordinator_workspace_enabled]))).toEqual({
        'saved-coordinator': true, 'saved-classic': false,
      });
      const [instance] = await sql`SELECT experimental FROM instance_settings WHERE singleton_key = 'default'`;
      expect(instance.experimental).toEqual(settings);
      const [newPerson] = await sql`INSERT INTO user_workspace_preferences (user_id) VALUES ('new-person') RETURNING coordinator_workspace_enabled`;
      expect(newPerson.coordinator_workspace_enabled).toBe(true);
    } finally { await sql.end(); }
  }, 30_000);

  it("starts Classic off for legacy preferences and preserves a later explicit opt-in on replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-classic-workspace-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`ALTER TABLE user_workspace_preferences DROP COLUMN classic_workspace_enabled`;
      await sql`INSERT INTO user_workspace_preferences (user_id, coordinator_workspace_enabled) VALUES ('old-off', false), ('old-on', true)`;
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await sql.unsafe(statement);
      }
      const upgraded = await sql`SELECT user_id, classic_workspace_enabled FROM user_workspace_preferences ORDER BY user_id`;
      expect(upgraded.map(row => row.classic_workspace_enabled)).toEqual([false, false]);
      await sql`UPDATE user_workspace_preferences SET classic_workspace_enabled = true WHERE user_id = 'old-off'`;
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await sql.unsafe(statement);
      }
      const [saved] = await sql`SELECT classic_workspace_enabled FROM user_workspace_preferences WHERE user_id = 'old-off'`;
      expect(saved.classic_workspace_enabled).toBe(true);
      const [fresh] = await sql`INSERT INTO user_workspace_preferences (user_id) VALUES ('new-classic-choice') RETURNING classic_workspace_enabled`;
      expect(fresh.classic_workspace_enabled).toBe(false);
    } finally { await sql.end(); }
  }, 30_000);

});
