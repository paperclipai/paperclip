import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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

  it.for([
    { source: "f3c67d50", sourceCommit: "f3c67d50dad32563c7eb5cef1ebae8e83584d4cf", count: 248, removedHashes: 4 },
    { source: "64814d5", sourceCommit: "64814d5a4b1cf9a61e6f0a661856d3c92401fa3b", count: 274, removedHashes: 0 },
  ])("upgrades the exact $source history without losing files or provider sessions", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async ({ source, sourceCommit, count, removedHashes }, { onTestFinished }) => {
    const database = await startEmbeddedPostgresTestDatabase("work-folder-historical-");
    // Register each cleanup before acquiring the next resource or parsing the
    // fixture. Vitest runs these in reverse order even when setup fails.
    onTestFinished(() => database.cleanup());
    const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    onTestFinished(() => admin.end());
    const migrationsFolder = mkdtempSync(path.join(os.tmpdir(), "work-folder-f3-history-"));
    onTestFinished(() => rmSync(migrationsFolder, { recursive: true, force: true }));
    const historyRoot = new URL(`./__fixtures__/work-folders-${source}/`, import.meta.url);
    const history = JSON.parse(readFileSync(new URL("history.json", historyRoot), "utf8")) as {
      sourceCommit: string;
      journal: { entries: { tag: string; when: number }[] };
      files: { name: string; sha256: string; currentFile?: string }[];
    };
    const historicalUrl = new URL(database.connectionString);
    historicalUrl.pathname = "/historical_preview";
    const sql = postgres(historicalUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      // The cluster helper's regular database is intentionally not the upgrade
      // subject: this separate database has never seen the current schema.
      await admin`CREATE DATABASE historical_preview`;
      expect(history.sourceCommit).toBe(sourceCommit);
      expect(history.files).toHaveLength(count);
      expect(history.journal.entries).toHaveLength(count);
      mkdirSync(path.join(migrationsFolder, "meta"));
      writeFileSync(path.join(migrationsFolder, "meta/_journal.json"), JSON.stringify(history.journal));
      for (const file of history.files) {
        const historicalFile = new URL(file.name, historyRoot);
        const sourceFile = existsSync(historicalFile) ? historicalFile : new URL(`./migrations/${file.currentFile ?? file.name}`, import.meta.url);
        const bytes = readFileSync(sourceFile);
        // Shared SQL, including the renumbered idempotent work-folder migration,
        // must match the exact old bytes. Removed SQL remains in the fixture.
        expect(createHash("sha256").update(bytes).digest("hex"), file.name).toBe(file.sha256);
        writeFileSync(path.join(migrationsFolder, file.name), bytes);
      }
      await migrate(drizzle(sql), { migrationsFolder });
      const journalBefore = [...await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`];
      expect(journalBefore).toHaveLength(count);
      expect(journalBefore.map(row => ({ hash: row.hash, created_at: String(row.created_at) }))).toEqual(
        history.journal.entries.map(entry => ({
          hash: history.files.find(file => file.name === `${entry.tag}.sql`)!.sha256,
          created_at: String(entry.when),
        })),
      );
      expect(await sql`SELECT to_regclass('public.email_messages') AS name`).toEqual([{ name: source === "f3c67d50" ? null : "email_messages" }]);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'heartbeat_runs'
        AND column_name = 'controller_boot_id'`).toHaveLength(source === "f3c67d50" ? 0 : 1);

      const company = randomUUID(), otherCompany = randomUUID(), project = randomUUID(), environment = randomUUID();
      const responsibleUser = "paperclip-id:historical-preview-user";
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Historical preview', 'HPV'), (${otherCompany}, 'Other company', 'HPO')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${project}, ${company}, 'Original project')`;
      await sql`INSERT INTO environments (id, name, driver, config) VALUES (${environment}, 'Historical Daytona', 'sandbox',
        ${JSON.stringify({ provider: "daytona", image: "historical-qualified-image", reuseLease: true })})`;
      const taskFolders: string[] = [];
      for (const runtimeMode of ["legacy", "native"]) {
        const agent = randomUUID(), task = randomUUID(), run = randomUUID(), lease = randomUUID(), repository = randomUUID();
        const nativeSession = runtimeMode === "native" ? randomUUID() : null;
        const providerId = `historical-${runtimeMode}-sandbox`, conversationId = `original-${runtimeMode}-conversation`;
        await sql`INSERT INTO agents (id, company_id, name, adapter_type, default_environment_id)
          VALUES (${agent}, ${company}, ${runtimeMode}, 'codex_local', ${environment})`;
        await sql`INSERT INTO issues (id, company_id, project_id, title, status, assignee_agent_id, responsible_user_id)
          VALUES (${task}, ${company}, ${project}, ${runtimeMode + ' existing task'}, 'in_progress', ${agent}, ${responsibleUser})`;
        await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode, responsible_user_id,
          native_session_id, session_id_before, session_id_after, context_snapshot)
          VALUES (${run}, ${company}, ${agent}, 'succeeded', ${runtimeMode}, ${responsibleUser}, ${nativeSession},
          ${conversationId}, ${conversationId}, ${JSON.stringify({ issueId: task, projectId: project })})`;
        await sql`INSERT INTO environment_leases (id, company_id, environment_id, issue_id, heartbeat_run_id, provider,
          provider_lease_id, lease_policy, metadata) VALUES (${lease}, ${company}, ${environment}, ${task}, ${run}, 'daytona',
          ${providerId}, 'reuse', ${JSON.stringify({ nativeHarnessBackup: { sessionId: conversationId, objectKey: "private/provider-backup" } })})`;
        await sql`INSERT INTO agent_task_sessions (company_id, agent_id, adapter_type, task_key, session_display_id,
          session_params_json, last_run_id) VALUES (${company}, ${agent}, 'codex_local', ${task}, ${conversationId},
          ${JSON.stringify({ sessionId: conversationId, nativeSessionId: nativeSession, sandboxId: providerId, cwd: "/home/daytona" })}, ${run})`;
        const folders: Record<string, string> = {};
        for (const [scope, owner] of [["task", task], ["agent", agent], ["user", responsibleUser], ["project", project]]) {
          const [folder] = await sql`INSERT INTO work_folders (company_id, scope, owner_id, imported_at)
            VALUES (${company}, ${scope}, ${owner}, '2026-09-01') ON CONFLICT (company_id, scope, owner_id)
            DO UPDATE SET owner_id = EXCLUDED.owner_id RETURNING id`;
          folders[scope] = folder.id;
        }
        taskFolders.push(folders.task);
        const objectKey = `${company}/work-folders/${folders.task}/original-content`;
        await sql`INSERT INTO work_files (company_id, folder_id, path, object_key, byte_size, sha256, executable, deleted_at)
          VALUES (${company}, ${folders.task}, 'nested/keep.sh', ${objectKey}, 12, ${"a".repeat(64)}, true, NULL),
            (${company}, ${folders.task}, 'empty.txt', ${objectKey + '/empty'}, 0, ${"b".repeat(64)}, false, NULL),
            (${company}, ${folders.task}, 'trash.txt', ${objectKey + '/trash'}, 4, ${"c".repeat(64)}, false, '2026-09-01')`;
        await sql`INSERT INTO work_file_operations (company_id, folder_id, operation_id, fingerprint)
          VALUES (${company}, ${folders.task}, 'original-retry-safe-write', 'original-operation-fingerprint')`;
        await sql`INSERT INTO task_repository_bindings (id, company_id, task_id, workspace_id, name, repo_url, repo_ref,
          setup_complete, checkpoint_key, checkpoint_sha256, checkpoint_at)
          VALUES (${repository}, ${company}, ${task}, ${randomUUID()}, 'original-repo', 'https://example.invalid/private.git',
          'task-unpushed-branch', true, ${`${company}/task-repositories/${repository}/checkpoint`}, ${"d".repeat(64)}, '2026-09-01')`;
        await sql`INSERT INTO work_folder_objects (object_key, company_id, folder_id, repository_binding_id, provider, delete_after)
          VALUES (${objectKey}, ${company}, ${folders.task}, NULL, 's3', NULL),
          (${objectKey + '/pending-upload'}, ${company}, ${folders.task}, NULL, 's3', '2030-01-01'),
          (${`${company}/task-repositories/${repository}/checkpoint`}, ${company}, NULL, ${repository}, 's3', NULL)`;
        const manifest = { version: 1, companyId: company, taskId: task, agentId: agent, responsibleUserId: responsibleUser,
          projectId: project, runId: run, leaseId: lease, home: "/home/daytona", folders, repositories: [{ bindingId: repository }] };
        await sql`INSERT INTO work_folder_runs (run_id, company_id, manifest, baselines, pending_operations, state,
          last_saved_at, error, refresh_requested) VALUES (${run}, ${company}, ${JSON.stringify(manifest)},
          ${JSON.stringify({ task: [{ path: "nested/keep.sh", kind: "file", byteSize: 12, sha256: "a".repeat(64), executable: true }] })},
          ${JSON.stringify({ "task/empty.txt": { id: randomUUID(), signature: "pending-original-signature" } })},
          'failed', '2026-09-01', 'Recoverable original storage interruption', true)`;
      }
      const preservedTables = ["issues", "agents", "environments", "environment_leases", "agent_task_sessions", "heartbeat_runs",
        "work_folders", "work_files", "work_file_operations", "work_folder_objects", "work_folder_runs", "task_repository_bindings"];
      const before = new Map<string, Record<string, unknown>[]>();
      for (const table of preservedTables) {
        const rows = await sql`SELECT to_jsonb(t) AS row FROM ${sql(table)} t`;
        before.set(table, rows.map(row => row.row));
      }
      const pending = await inspectMigrations(historicalUrl.toString());
      expect(pending.status).toBe("needsMigrations");
      if (pending.status !== "needsMigrations") throw new Error("Historical preview unexpectedly has current migrations");
      expect(pending.pendingMigrations).toEqual(expect.arrayContaining([
        "0275_easy_dragon_man.sql", "0276_hard_mandroid.sql",
      ]));
      if (source === "f3c67d50") expect(pending.pendingMigrations).toContain("0277_sandbox_work_folders.sql");
      else expect(pending.pendingMigrations).not.toContain("0277_sandbox_work_folders.sql");
      await applyPendingMigrations(historicalUrl.toString());
      expect((await inspectMigrations(historicalUrl.toString())).status).toBe("upToDate");
      for (const table of preservedTables) {
        const after = (await sql`SELECT to_jsonb(t) AS row FROM ${sql(table)} t`).map(row => row.row);
        expect(after, table).toHaveLength(before.get(table)!.length);
        for (const original of before.get(table)!) expect(after, table).toContainEqual(expect.objectContaining(original));
      }
      expect(await sql`SELECT to_regclass('public.email_messages') AS name`).toEqual([{ name: "email_messages" }]);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'heartbeat_runs'
        AND column_name IN ('controller_boot_id', 'controller_lease_expires_at', 'execution_stage')`).toHaveLength(3);
      // Both mainline migrations must execute even when the saved preview has a
      // later work-folder timestamp. A schema marker alone is not evidence.
      expect(await sql`SELECT to_regclass('public.ai_connection_defaults') AS name`).toEqual([{ name: "ai_connection_defaults" }]);
      expect(await sql`SELECT to_regclass('public.chat_endpoints_photon_number_uq') AS name`).toEqual([{ name: "chat_endpoints_photon_number_uq" }]);
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'adapter_auth_sessions'
        AND column_name IN ('ai_connection', 'connection_id', 'connection_grant_id', 'connection_method')`).toHaveLength(4);
      // Compare the complete six-table catalog with the independently migrated
      // current database, ignoring physical column order from historical ADDs.
      async function workFolderSchema(connection: typeof sql) {
        const tables = ["work_folders", "work_files", "work_file_operations", "work_folder_objects", "work_folder_runs", "task_repository_bindings"];
        const columns = await connection`SELECT table_name, column_name, data_type, udt_name, column_default, is_nullable
          FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
        const constraints = await connection`SELECT c.relname AS table_name, x.contype AS type, pg_get_constraintdef(x.oid) AS definition
          FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' ORDER BY c.relname, x.contype, pg_get_constraintdef(x.oid)`;
        const indexes = await connection`SELECT tablename AS table_name, indexdef AS definition FROM pg_indexes
          WHERE schemaname = 'public' ORDER BY tablename, indexdef`;
        return {
          columns: columns.filter(row => tables.includes(row.table_name)),
          constraints: constraints.filter(row => tables.includes(row.table_name)),
          indexes: indexes.filter(row => tables.includes(row.table_name)).map(row => ({
            ...row, definition: row.definition.replace(/^CREATE( UNIQUE)? INDEX \S+ ON /, "CREATE$1 INDEX ON "),
          })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
      }
      expect(await workFolderSchema(sql)).toEqual(await workFolderSchema(admin));
      const journalAfter = [...await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`];
      expect(journalAfter).toHaveLength(pending.availableMigrations.length + removedHashes);
      expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
      expect(new Set(journalAfter.map(row => row.hash)).size).toBe(journalAfter.length);
      for (const hash of history.files.slice(-4).map(file => file.sha256)) expect(journalAfter.filter(row => row.hash === hash)).toHaveLength(1);
      await applyPendingMigrations(historicalUrl.toString());
      expect([...(await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)]).toEqual(journalAfter);
      for (const table of preservedTables) {
        const afterReplay = (await sql`SELECT to_jsonb(t) AS row FROM ${sql(table)} t`).map(row => row.row);
        expect(afterReplay, `${table} after replay`).toHaveLength(before.get(table)!.length);
        for (const original of before.get(table)!) expect(afterReplay, table).toContainEqual(expect.objectContaining(original));
      }
      await expect(sql`INSERT INTO work_files (company_id, folder_id, path) VALUES (${otherCompany}, ${taskFolders[0]}, 'foreign.txt')`)
        .rejects.toMatchObject({ code: "23503" });
      await expect(sql`INSERT INTO work_file_operations (company_id, folder_id, operation_id, fingerprint)
        VALUES (${company}, ${taskFolders[0]}, 'original-retry-safe-write', 'new-fingerprint')`).rejects.toMatchObject({ code: "23505" });
    } finally {
      await sql.end();
    }
  });

});
