import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migration = readFileSync(new URL("./migrations/0277_sandbox_work_folders.sql", import.meta.url), "utf8");

(support.supported ? describe : describe.skip)("work folder preview migration", () => {
  it("preserves cached content, trash, and unpushed repository checkpoints on replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("work-folder-preview-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const company = randomUUID(), otherCompany = randomUUID(), task = randomUUID(), folder = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Preview', 'PVM'), (${otherCompany}, 'Other', 'PVO')`;
      await sql`INSERT INTO issues (id, company_id, title) VALUES (${task}, ${company}, 'Preserve task')`;
      await sql`INSERT INTO work_folders (id, company_id, scope, owner_id) VALUES (${folder}, ${company}, 'task', ${task})`;
      await sql`INSERT INTO work_files (company_id, folder_id, path, object_key, sha256, executable, deleted_at)
        VALUES (${company}, ${folder}, 'keep.sh', 'content/keep', 'hash-keep', true, NULL),
               (${company}, ${folder}, 'trash.txt', 'content/trash', 'hash-trash', false, '2020-01-01')`;
      await sql`INSERT INTO task_repository_bindings (company_id, task_id, workspace_id, name, checkpoint_key, checkpoint_sha256)
        VALUES (${company}, ${task}, ${randomUUID()}, 'repo', 'checkpoint/unpushed', 'hash-checkpoint')`;
      // The earliest preview did not yet have these sync columns.
      await sql`ALTER TABLE work_folder_runs DROP COLUMN baselines, DROP COLUMN pending_operations`;
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await sql.unsafe(statement);
        }
      }
      const files = await sql`SELECT path, object_key, sha256, executable, deleted_at IS NOT NULL AS trashed
        FROM work_files WHERE folder_id = ${folder} ORDER BY path`;
      expect([...files]).toEqual([
        { path: "keep.sh", object_key: "content/keep", sha256: "hash-keep", executable: true, trashed: false },
        { path: "trash.txt", object_key: "content/trash", sha256: "hash-trash", executable: false, trashed: true },
      ]);
      expect([...(await sql`SELECT checkpoint_key, checkpoint_sha256 FROM task_repository_bindings WHERE task_id = ${task}`)])
        .toEqual([{ checkpoint_key: "checkpoint/unpushed", checkpoint_sha256: "hash-checkpoint" }]);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'work_folder_runs' AND column_name IN ('baselines', 'pending_operations')`).toHaveLength(2);
      await expect(sql`INSERT INTO work_files (company_id, folder_id, path) VALUES (${otherCompany}, ${folder}, 'denied.txt')`)
        .rejects.toMatchObject({ code: "23503" });
      await expect(sql`INSERT INTO work_files (company_id, folder_id, path) VALUES (${company}, ${folder}, 'keep.sh')`)
        .rejects.toMatchObject({ code: "23505" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("applies missing mainline migrations after a renamed preview without losing files", async () => {
    const database = await startEmbeddedPostgresTestDatabase("work-folder-renumber-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const company = randomUUID(), task = randomUUID(), folder = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Preview upgrade', 'PVU')`;
      await sql`INSERT INTO issues (id, company_id, title) VALUES (${task}, ${company}, 'Existing task')`;
      await sql`INSERT INTO work_folders (id, company_id, scope, owner_id) VALUES (${folder}, ${company}, 'task', ${task})`;
      await sql`INSERT INTO work_files (company_id, folder_id, path, object_key, executable)
        VALUES (${company}, ${folder}, 'saved.sh', 'preview/saved', true)`;
      await sql`INSERT INTO task_repository_bindings (company_id, task_id, workspace_id, name, checkpoint_key)
        VALUES (${company}, ${task}, ${randomUUID()}, 'repo', 'preview/unpushed')`;
      const mainlineHashes = ["0272_light_kate_bishop", "0273_aromatic_moondragon", "0274_agent_chat"].map((name) =>
        createHash("sha256").update(readFileSync(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8")).digest("hex"),
      );
      const previewHash = createHash("sha256").update(migration).digest("hex");
      // Model a preview that already recorded its work-folder migration with a
      // timestamp newer than the subsequently merged mainline migration.
      await sql`DROP TABLE email_sends, email_messages, email_endpoints`;
      await sql`ALTER TABLE heartbeat_runs DROP COLUMN controller_boot_id, DROP COLUMN controller_lease_expires_at, DROP COLUMN execution_stage`;
      await sql`ALTER TABLE issue_comments DROP COLUMN client_request_id`;
      for (const hash of mainlineHashes) await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await sql`UPDATE drizzle.__drizzle_migrations SET created_at = 1799999999999 WHERE hash = ${previewHash}`;
      const before = await inspectMigrations(database.connectionString);
      expect(before.status).toBe("needsMigrations");
      await applyPendingMigrations(database.connectionString);
      await applyPendingMigrations(database.connectionString);
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
      expect(await sql`SELECT to_regclass('public.email_messages') AS table_name`)
        .toMatchObject([{ table_name: "email_messages" }]);
      expect(await sql`SELECT path, object_key, executable FROM work_files WHERE folder_id = ${folder}`)
        .toMatchObject([{ path: "saved.sh", object_key: "preview/saved", executable: true }]);
      expect(await sql`SELECT checkpoint_key FROM task_repository_bindings WHERE task_id = ${task}`)
        .toMatchObject([{ checkpoint_key: "preview/unpushed" }]);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'heartbeat_runs'
        AND column_name IN ('controller_boot_id', 'controller_lease_expires_at', 'execution_stage')`).toHaveLength(3);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'issue_comments'
        AND column_name = 'client_request_id'`).toHaveLength(1);
      for (const hash of mainlineHashes) {
        expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
      }
      expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${previewHash}`).toHaveLength(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

});
