import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { hasRequiredWorkspaceRecovery } from "../services/workspace-restore-recovery-state.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workspace restore hold under environment lock contention", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else { temporary = await startEmbeddedPostgresTestDatabase("workspace-restore-lock-"); db = createDb(temporary.connectionString); } }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(runtimeMode: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace recovery", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Restore files", status: "in_progress", assigneeAgentId: agentId });
    const [project] = await db.insert(projects).values({ companyId, name: "Workspace project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id,
      sourceIssueId: issueId, mode: "isolated", strategyType: "git_worktree", name: "Fixture workspace", cwd: "/work/fixture",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", runtimeMode,
      finishedAt: new Date(), contextSnapshot: { issueId, executionWorkspaceId: workspace.id },
    }).returning();
    const [environment] = await db.insert(environments).values({ name: `Shared sandbox ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, executionWorkspaceId: workspace.id, heartbeatRunId: runId,
      environmentId: environment.id, status: "active", leasePolicy: "ephemeral", provider: "daytona", providerLeaseId: randomUUID(),
      metadata: { remoteCwd: "/work/fixture", workspaceRealization: { authoritativeRoot: "/work/fixture" }, driver: "sandbox",
        pluginId: randomUUID(), sandboxProviderPlugin: true },
    }).returning();
    return { runId, run, lease };
  }

  // A second write to a row this transaction already wrote re-runs its
  // foreign-key checks, which take KEY SHARE locks on the referenced rows.
  // Another run's lease acquisition holds the shared environment FOR UPDATE.
  it.each(["legacy", "native"])("retains an active %s source while another run holds its environment", async (runtimeMode) => {
    const f = await seed(runtimeMode);
    let locked!: () => void, release!: () => void;
    const isLocked = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, f.lease.environmentId!)).for("update");
      locked();
      await released;
    });
    await isLocked;
    let returned: Awaited<ReturnType<typeof terminalizeLegacyExecution>>;
    try {
      returned = await terminalizeLegacyExecution({ db, run: f.run, status: "failed", recordRestoreFailureOnly: runtimeMode === "native",
        workspaceRestoreSource: f.lease, patch: { resultJson: { workspaceRestoreFailure: "restore_failed" } } });
    } finally { release(); await holder; }
    expect(hasRequiredWorkspaceRecovery(returned!.resultJson)).toBe(true);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: expect.objectContaining({
      remoteCwd: "/work/fixture",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", runId: f.runId, originalLeasePolicy: "ephemeral" },
      sandboxStopAndRetain: expect.objectContaining({ leaseId: f.lease.id, runId: f.runId }),
    }) });
  });
});
