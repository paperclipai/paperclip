import { chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createDb, getPostgresDataDirectory, runDatabaseRestore } from "../../../packages/db/src/index.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, project, putDocument, task, sameTask, type Entity } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat, companionPhase } from "./privileged-support.js";
import { ownedRestoreTarget, prepareOwnedDockerDatabase } from "./privileged-docker-database.js";
const privateSources = new WeakMap<ChatCatalogContext, { url: string; keyId: string; token: string; root: string; database: string; verify: () => Promise<void> }>();
const pool = (url: string) => createDb(url, { maxConnections: 1, prepare: false, connectTimeoutSeconds: 5, applicationName: "owned-catalog-backup-proof" }).$client;
export function gradeBackupRestore(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("backup-restoration-observation", !!o, "An actual board backup and actual separate empty database restoration are required."); if (!o) return c.result();
  const marker = o.state.task as Entity | undefined;
  const initial = String(o.state.initialGuidance ?? "");
  c.add("owned-source-and-board-authority", o.state.sourceOwned === true && o.state.agentBackupStatus === 403,
    "The source belongs to the disposable launcher and the actual agent bearer cannot trigger instance backup.");
  c.add("real-private-archive", typeof o.state.archiveSha256 === "string" && o.state.archiveSha256.length === 64
    && Number(o.state.archiveBytes) > 0 && o.state.archiveWithinOwnedRoot === true && o.state.archivePublished === false,
    "A real inspectable backup archive exists privately in the owned root; its contents or secrets are never published as chat attachments.");
  c.add("separate-empty-target-restored", o.state.separateDatabase === true && o.state.targetWasEmpty === true && o.state.restoreCompleted === true
    && o.state.restoredFixtureMatches === true && o.state.sourceFixtureUnchanged === true && o.state.targetDropped === true
    && !!marker && sameTask(marker, o.tasks.find(row => row.id === marker.id)),
    "The supported restore engine runs only against a newly created empty target and verifies actual task/document rows without overwriting the source.");
  c.add("truthful-backup-guidance", /backup|back up/i.test(initial) && /restor|recover/i.test(initial) && /operator|admin|human|board/i.test(initial)
    && !/(?:I(?:'ve| have)?|already|successfully)\s+(?:backed up|restored|verified recovery)/i.test(initial),
    "The initial reply distinguishes privileged backup from the later verified restoration instead of claiming either already occurred.");
  const phase = o.state.restoreReport as { attributed?: boolean; reply?: string; humanCommentId?: string; runId?: string } | undefined;
  const report = phase?.reply ?? "";
  c.add("native-reports-actual-restore", phase?.attributed === true && !!phase.humanCommentId && !!phase.runId
    && report.split(/[.!?\n]/).some(clause => /restor|recover/i.test(clause) && /verif|succeed|pass|match/i.test(clause)
      && !/\b(?:not|never|cannot|can't|failed|unverified)\b/i.test(clause))
    && /separate|empty|disposable|test target/i.test(report) && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded"),
    "The actual second native reply to the factual operator receipt reports the observed restore result and its disposable scope.");
  return c.result();
}
const backup = privilegedDefinition("instance-operations.backup-and-restore", "privileged-backup", {
  async setup(ctx) {
    const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, configPath = process.env.PAPERCLIP_CONFIG;
    if (!root || !configPath || !ctx.input.privateSecrets) throw new Error("Owned backup fixture config and private redaction sink are required");
    const owned = await realpath(root), configFile = await realpath(configPath);
    if (!configFile.startsWith(owned + path.sep)) throw new Error("Backup refuses an operator config outside the owned attempt");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    let url: string, database: string, verify: () => Promise<void>;
    if (config.database?.mode === "postgres") {
      const docker = await prepareOwnedDockerDatabase(owned, configFile);
      url = docker.connection; database = docker.database; verify = docker.verify;
      ctx.input.privateSecrets.push(url);
    } else {
      if (config.database?.mode !== "embedded-postgres" || !Number.isSafeInteger(config.database.embeddedPostgresPort))
        throw new Error("Backup requires the launcher's owned embedded or qualified Docker PostgreSQL cluster");
      url = `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`;
      database = "paperclip";
      verify = async () => {
        const data = await getPostgresDataDirectory(url);
        if (!data || !(await realpath(data)).startsWith(owned + path.sep)) throw new Error("Backup source PostgreSQL data directory is not owned by this attempt");
      };
      await verify();
    }
    const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `catalog-backup-probe-${ctx.input.nonce}` });
    ctx.input.privateSecrets.push(key.token); privateSources.set(ctx, { url, keyId: key.id, token: key.token, root: owned, database, verify });
    const response = await fetch(new URL("/api/instance/database-backups", ctx.input.api.baseURL), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: "{}" });
    const agentBackupStatus = response.status; await response.body?.cancel();
    const launch = await project(ctx), marker = await task(ctx, "Backup restore canary", launch.id, { description: `Owned recovery marker ${ctx.input.nonce}` });
    const body = `# Retained plan\n\nExact recovery bytes ${ctx.input.nonce}`;
    const plan = await putDocument(ctx, marker.id, body);
    return { sourceOwned: true, agentBackupStatus, project: launch, task: marker, documentRevisionId: plan.latestRevisionId,
      expectedBodySha256: createHash("sha256").update(body).digest("hex") };
  },
  async act(ctx, state) {
    const initial = await settlePrivilegedChat(ctx); state.initialGuidance = initial.reply;
    const source = privateSources.get(ctx); if (!source) throw new Error("Private owned backup source unavailable");
    const sql = pool(source.url), targetName = `catalog_restore_${createHash("sha256").update(ctx.input.nonce).digest("hex").slice(0, 24)}`;
    const targetUrl = new URL(source.url); targetUrl.pathname = `/${targetName}`;
    let targetCreated = false;
    const markerId = (state.task as { id: string }).id;
    const readMarker = async (client: typeof sql) => {
      const tasks = await client.unsafe("select id, company_id, project_id, title, description, status from issues where id = $1", [markerId]);
      const docs = await client.unsafe("select d.id, d.issue_id, d.key, doc.latest_revision_id from issue_documents d join documents doc on doc.id = d.document_id where d.issue_id = $1 and d.key = 'plan'", [markerId]);
      const revisions = await client.unsafe("select id, document_id, body from document_revisions where id = $1", [String(state.documentRevisionId)]);
      return { tasks: [...tasks], docs: [...docs], revisions: [...revisions] };
    };
    try {
      await source.verify();
      if (!ownedRestoreTarget(targetName, source.database, ctx.input.nonce)) throw new Error("Restore target is not the generated separate database");
      const before = await readMarker(sql);
      const receipt = await ctx.input.api.post<{ backupFile: string; sizeBytes: number }>("/api/instance/database-backups", {});
      const archive = await realpath(receipt.backupFile);
      if (!archive.startsWith(source.root + path.sep)) throw new Error("Backup archive escapes the disposable root");
      const bytes = await readFile(archive);
      state.archiveSha256 = createHash("sha256").update(bytes).digest("hex"); state.archiveBytes = bytes.length;
      state.archiveWithinOwnedRoot = true; state.archivePublished = false;
      // The name is generated here, checked absent, and never read from model output.
      const existing = await sql.unsafe("select datname from pg_database where datname = $1", [targetName]);
      if (existing.length) throw new Error("Owned restore target unexpectedly exists");
      await source.verify();
      await sql.unsafe(`create database "${targetName}"`); targetCreated = true; state.separateDatabase = targetName !== source.database;
      const target = pool(targetUrl.href);
      try {
        const tables = await target.unsafe("select table_name from information_schema.tables where table_schema = 'public'");
        state.targetWasEmpty = tables.length === 0;
        if (!state.targetWasEmpty) throw new Error("Refusing restore into a nonempty target");
        await target.end({ timeout: 5 });
        await source.verify();
        await runDatabaseRestore({ connectionString: targetUrl.href, backupFile: archive, connectTimeoutSeconds: 5 }); state.restoreCompleted = true;
      } finally { await target.end({ timeout: 5 }); }
      const restored = pool(targetUrl.href);
      try {
        state.restoredFixtureMatches = JSON.stringify(await readMarker(restored)) === JSON.stringify(before)
          && before.docs.length === 1 && before.docs[0]!.latest_revision_id === state.documentRevisionId
          && before.revisions.length === 1 && createHash("sha256").update(String(before.revisions[0]!.body)).digest("hex") === state.expectedBodySha256;
      } finally { await restored.end({ timeout: 5 }); }
      state.sourceFixtureUnchanged = JSON.stringify(await readMarker(sql)) === JSON.stringify(before);
    } catch { throw new Error("Owned backup/restore verification failed; connection, archive contents and private diagnostics withheld"); }
    finally {
      try { if (targetCreated) { await source.verify(); await sql.unsafe(`drop database "${targetName}"`); state.targetDropped = true; } }
      finally { await sql.end({ timeout: 5 }); }
    }
    const receipt = { archiveSha256: state.archiveSha256, archiveBytes: state.archiveBytes,
      targetWasEmpty: state.targetWasEmpty, separateDatabase: state.separateDatabase, restoredFixtureMatches: state.restoredFixtureMatches,
      sourceFixtureUnchanged: state.sourceFixtureUnchanged, targetDropped: state.targetDropped, archivePublished: false,
      archiveRetention: "private owned attempt only; secret-bearing archive excluded from ordinary chat artifacts" };
    await ctx.input.evidence("chat-catalog-private-backup-restore.json", receipt);
    const message = `The operator backup and restore run produced this factual receipt. Please report what it establishes and any limits:\n\n${JSON.stringify(receipt)}`;
    await sendChatMessage(ctx.input.page, message, chatCatalogNativePhaseRemainingBudget(ctx));
    state.restoreReport = await companionPhase(ctx, initial.runs.map(run => run.id), message);
    await ctx.input.evidence("chat-catalog-native-restore-report.json", state.restoreReport);
  }, grade: gradeBackupRestore,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
backup.attemptTimeoutMs = 600_000;
backup.expectedRunCount = 2; backup.expectedHumanMessageCount = 2;
backup.cleanup = async ctx => { const source = privateSources.get(ctx); if (source) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${source.keyId}`); privateSources.delete(ctx); } };
backup.sourceFiles = [...backup.sourceFiles, "chat-catalog-domains/privileged-docker-database.ts", "docker-postgres.ts", "../../packages/db/src/backup-lib.ts", "../../server/src/routes/instance-database-backups.ts"];
export const privilegedBackupCases = [backup];
