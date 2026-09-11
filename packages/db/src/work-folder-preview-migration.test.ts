import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migration = readFileSync(new URL("./migrations/0272_naive_the_watchers.sql", import.meta.url), "utf8");

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
});
