import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, applyPendingMigrations, companies, createDb, environmentLeases, executionWorkspaces,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, projects, workspaceOperations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { describeRetainedPriorWorkspace, parsePorcelainZ } from "./fresh-workspace-seed.js";
import { recordNativeLocalProcessStop } from "./native-local-process-stop.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { requestTaskRetry } from "./task-retry.js";

const execFile = promisify(execFileCallback);
const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RETRY_WORKSPACE_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

/** R2: a Retry after recovery runs out must not drop the agent's work. */
describe.skipIf(!support.supported)("Retry workspace continuity after exhausted or blocked recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-retry-workspace-"));
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} } as typeof database;
    } else database = await startEmbeddedPostgresTestDatabase("retry-workspace-continuity-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function git(cwd: string, ...args: string[]) {
    return (await execFile("git", ["-C", cwd, ...args])).stdout.trim();
  }

  type Kind = "exhausted_generation" | "blocked_recovery" | "blocked_without_generation" | "duplicate_holds";
  async function seed(kind: Kind) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry continuity", defaultResponsibleUserId: "board",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer",
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    const [project] = await db.insert(projects).values({ companyId, name: "Repository" }).returning();
    // A real primary checkout and the task's own git worktree with uncommitted edits.
    const primary = join(root, `${issueId}-primary`);
    await execFile("git", ["init", "--initial-branch=main", primary]);
    await git(primary, "config", "user.email", "test@example.com");
    await git(primary, "config", "user.name", "Retry test");
    await writeFile(join(primary, "README.md"), "committed\n");
    await git(primary, "add", ".");
    await git(primary, "commit", "-m", "base");
    const worktree = join(root, `${issueId}-worktree`);
    const branchName = `TASK-${issueId.slice(0, 8)}`;
    await git(primary, "worktree", "add", "-b", branchName, worktree, "main");
    await writeFile(join(worktree, "README.md"), "committed\nedited before the fault\n");
    await writeFile(join(worktree, "NOTES.md"), "untracked pre-fault work\n");
    await db.insert(issues).values({ id: issueId, companyId, projectId: project.id, title: "Edit the repository",
      status: "blocked", assigneeAgentId: agentId,
      executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "isolated_workspace" } });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: branchName, status: "active", cwd: worktree,
      providerType: "git_worktree", providerRef: worktree, baseRef: "main", branchName }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issueId));
    const blockedKind = kind === "blocked_recovery" || kind === "blocked_without_generation";
    const errorCode = blockedKind ? "native_restart_recovery_blocked" : "native_session_retry_exhausted";
    const [source] = await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode, processPid: 999_999_999,
      contextSnapshot: { issueId }, startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId,
      phase: "terminal_failure", attempt: 3, failureCode: errorCode });
    await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: sourceRunId, provider: "local",
      status: "expired", leasePolicy: "ephemeral", executionWorkspaceId: workspace.id, releasedAt: new Date(Date.now() - 50_000),
      cleanupStatus: "success" });
    expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as unknown as Db, source))).toBe(true);
    // Recovery clears the process fields after it records the host's stop observation.
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, sourceRunId));
    const generation = createSystemRecovery(sourceRunId);
    const systemRecovery = kind === "exhausted_generation" || kind === "duplicate_holds"
      ? failSystemRecovery(generation, new SystemRecoveryFailure("source_unavailable", "use_alternative_strategy"))
      : { ...generation, state: "complete" as const, phase: "settle_result_or_dispatch" as const };
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: blockedKind ? "board" : "system", returnOwnerAgentId: agentId,
      cause: blockedKind ? "native_restart_recovery_blocked" : "native_continuation_requires_reconciliation",
      fingerprint: `native-restart:${sourceRunId}`, nextAction: "Retry the task.",
      // A blocked restart without an admission hold records no generation.
      evidence: kind === "blocked_without_generation" ? { runId: sourceRunId, reason: "ownership changed" }
        : { runId: sourceRunId, systemRecovery } }).returning();
    // Several holds can describe the same failed run; a historical one has no generation.
    if (kind === "duplicate_holds") await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "system", returnOwnerAgentId: agentId, cause: "native_session_retry_exhausted",
      status: "resolved", fingerprint: randomUUID(), nextAction: "Retry the task.", evidence: { runId: sourceRunId } });
    return { companyId, agentId, issueId, source, workspace, worktree, primary, branchName, action };
  }

  async function retry(f: Awaited<ReturnType<typeof seed>>) {
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    const successorRunId = randomUUID();
    const blocked: string[] = [];
    const continuation = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const admitted = await admitExplicitNativeContinuation({ db: tx as unknown as Db, companyId: f.companyId,
        issueId: f.issueId, agentId: f.agentId, actorId: "board", actorType: "user", reason: "task_retry",
        commentId: null, successorRunId, taskRetryRequestId: receipt.requestId!, onBlocked: reason => blocked.push(reason) });
      await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "queued",
        contextSnapshot: { issueId: f.issueId, taskRetryRequestId: receipt.requestId } });
      await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: successorRunId })
        .where(eq(agentWakeupRequests.id, receipt.requestId!));
      return admitted;
    });
    expect(blocked).toEqual([]);
    expect(continuation).toMatchObject({ previousRunId: f.source.id, taskRetryRequestId: receipt.requestId });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId));
    return { successor, requestId: receipt.requestId!, readiness: await readFreshWorkspaceReadiness(db, successor) };
  }

  it.each(["exhausted_generation", "blocked_recovery", "blocked_without_generation", "duplicate_holds"] as const)(
    "continues a %s Retry in the task's own git worktree with its uncommitted edits", async kind => {
      const f = await seed(kind);
      const { successor, requestId, readiness } = await retry(f);
      expect(readiness).toEqual({ mode: "reuse_issue_workspace", retryIntentId: requestId,
        sourceRunId: f.source.id, workspaceId: f.workspace.id, cwd: f.worktree });
      // The retained directory is the same worktree: git history, branch and pre-fault files are intact.
      expect((await lstat(join(readiness!.mode === "reuse_issue_workspace" ? readiness!.cwd : "", ".git"))).isFile()).toBe(true);
      expect(await git(f.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(f.branchName);
      expect(await readFile(join(f.worktree, "NOTES.md"), "utf8")).toBe("untracked pre-fault work\n");
      expect(await readFile(join(f.worktree, "README.md"), "utf8")).toContain("edited before the fault");
      // The task binding is unchanged and this attempt consumed the generation's alternative attempt once.
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.executionWorkspaceId).toBe(f.workspace.id);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
      if (kind !== "blocked_without_generation") expect(readSystemRecovery(action.evidence)?.freshAttemptRunId).toBe(successor.id);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, requestId));
      expect((wake.payload?.taskRetry as Record<string, unknown>).strategy).toBe("continue");
      expect(await readFreshWorkspaceReadiness(db, { ...successor, id: randomUUID() })).toBeNull();
    }, 30_000);

  it("lists renamed paths from either porcelain status column once", () => {
    expect(parsePorcelainZ("R  new.md\0old.md\0 R moved.md\0before.md\0?? NOTES.md\0 M README.md\0")).toEqual([
      "new.md", "moved.md", "NOTES.md", "README.md"]);
  });

  it("names the retained prior worktree and its uncommitted files for a fresh attempt", async () => {
    const f = await seed("exhausted_generation");
    const prior = await describeRetainedPriorWorkspace(db, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, successorRunId: randomUUID(), freshCwd: join(root, "fresh") });
    expect(prior).toEqual({ sourceRunId: f.source.id, path: f.worktree, branchName: f.branchName,
      changedFilesKnown: true, changedFileCount: 2, changedFiles: expect.arrayContaining(["NOTES.md", "README.md"]) });
  }, 30_000);

  it("ignores a workspace operation orphaned by a restart of the stopped source", async () => {
    const f = await seed("blocked_recovery");
    // The server died during the source's preparation; no process can still run it.
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
      heartbeatRunId: f.source.id, issueId: f.issueId, phase: "worktree_prepare", status: "running",
      startedAt: new Date(Date.now() - 24 * 60 * 60_000) });
    const { readiness } = await retry(f);
    expect(readiness).toMatchObject({ mode: "reuse_issue_workspace", cwd: f.worktree });
  }, 30_000);

  it.each(["live_lease", "running_operation", "corrupt_git", "missing_directory", "remote_authority", "shared_workspace", "export_pending", "repair_required", "live_source_operation"] as const)(
    "keeps the fresh isolated attempt when the prior workspace is unsafe: %s", async unsafe => {
      const f = await seed("exhausted_generation");
      if (unsafe === "live_lease") await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        provider: "local", status: "active", leasePolicy: "ephemeral", executionWorkspaceId: f.workspace.id });
      if (unsafe === "running_operation") await db.insert(workspaceOperations).values({ companyId: f.companyId,
        // A workspace-control job has no run and can predate the source settling.
        executionWorkspaceId: f.workspace.id, issueId: f.issueId, phase: "worktree_prepare", status: "running",
        startedAt: new Date(Date.now() - 24 * 60 * 60_000) });
      if (unsafe === "corrupt_git") await writeFile(join(f.worktree, ".git"), "gitdir: /nonexistent/worktree\n");
      if (unsafe === "missing_directory") await rm(f.worktree, { recursive: true, force: true });
      if (unsafe === "remote_authority") await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: randomUUID(), source: { kind: "empty" },
        location: null, writerRunId: null, dirty: false } } })
        .where(eq(executionWorkspaces.id, f.workspace.id));
      if (unsafe === "shared_workspace") await db.update(executionWorkspaces).set({ mode: "shared_workspace" })
        .where(eq(executionWorkspaces.id, f.workspace.id));
      if (unsafe === "repair_required") await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed" } })
        .where(eq(heartbeatRuns.id, f.source.id));
      // The source settled just now; an operation it started in this server process may still be running.
      if (unsafe === "live_source_operation") {
        await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.source.id));
        await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
          heartbeatRunId: f.source.id, issueId: f.issueId, phase: "worktree_prepare", status: "running", startedAt: new Date(Date.now() - 1_000) });
      }
      if (unsafe === "export_pending") await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence,
        systemRecovery: { ...readSystemRecovery(f.action.evidence)!, state: "running" } } })
        .where(eq(issueRecoveryActions.id, f.action.id));
      const { readiness, successor } = await retry(f);
      expect(readiness).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.source.id });
      // The fresh attempt names the retained directory only when reuse would also
      // trust it as a source: task-owned, local, settled and with no other writer.
      const prior = await describeRetainedPriorWorkspace(db, { companyId: f.companyId, issueId: f.issueId,
        sourceRunId: f.source.id, successorRunId: successor.id, freshCwd: join(root, "fresh") });
      if (unsafe === "corrupt_git") expect(prior).toEqual({ sourceRunId: f.source.id, path: f.worktree,
        branchName: f.branchName, changedFilesKnown: false, changedFileCount: 0, changedFiles: [] });
      else expect(prior).toBeNull();
      const [task] = await db.select().from(issues).where(and(eq(issues.id, f.issueId), eq(issues.companyId, f.companyId)));
      expect(task.executionWorkspaceId).toBe(f.workspace.id);
    }, 30_000);
});
