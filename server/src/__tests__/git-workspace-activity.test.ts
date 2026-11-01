import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { expirationScope, gitWorkspaceLastActivityAt, isGitWorkspaceExpirationEligible } from "../services/git-workspace-expiration.js";
import { workspaceMoveEligible } from "../services/isolated-repository-rehome.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("Git workspace activity bindings", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const now = new Date("2026-10-20T12:00:00Z");
  const old = new Date("2026-10-01T12:00:00Z");
  const recent = new Date("2026-10-20T11:30:00Z");
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-workspace-activity-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    // Retained rows can predate native scope bindings. Preserve each fixture's
    // independent native/legacy path instead of normalizing JSON on insertion.
    await db.execute(sql`ALTER TABLE heartbeat_runs DISABLE TRIGGER heartbeat_runs_set_scope_kind`);
  });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Activity", issuePrefix: `AC${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Activity" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Root", status: "done", completedAt: old, updatedAt: old });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Activity", cwd: `/tmp/activity-${companyId}` }).returning();
    const [child] = await db.insert(issues).values({ companyId, parentId: issueId, title: "Child", status: "done", completedAt: old, updatedAt: old }).returning();
    const [bound] = await db.insert(issues).values({ companyId, executionWorkspaceId: workspace.id, title: "Bound", status: "done", completedAt: old, updatedAt: old }).returning();
    return { companyId, agentId, issueId, workspace, child, bound,
      eligible: () => db.transaction(tx => isGitWorkspaceExpirationEligible(tx, workspace, now)) };
  }

  it.each(["rootIssue", "childIssue", "boundIssue", "boundNative", "contextChildIssue", "contextChildTask", "contextWorkspace", "checkout", "execution"])(
    "keeps recent activity and deletion vetoes through %s", async route => {
      const f = await fixture();
      const runId = randomUUID();
      const issueId = route === "rootIssue" ? f.issueId : route === "childIssue" ? f.child.id : f.bound.id;
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "scheduled_retry", createdAt: recent,
        ...(route.endsWith("Issue") && !route.startsWith("context") ? { scopeKind: "issue" as const, issueId } : {}),
        ...(route === "boundNative" ? { nativeIssueId: f.bound.id } : {}),
        contextSnapshot: route === "contextChildIssue" ? { issueId: f.child.id } : route === "contextChildTask" ? { taskId: f.child.id }
          : route === "contextWorkspace" ? { executionWorkspaceId: f.workspace.id } : null });
      if (route === "checkout" || route === "execution") await db.update(issues)
        .set(route === "checkout" ? { checkoutRunId: runId } : { executionRunId: runId }).where(eq(issues.id, f.bound.id));
      expect(await gitWorkspaceLastActivityAt(db, f.workspace)).toEqual(recent);
      expect(await f.eligible()).toBe(false);
      expect(await workspaceMoveEligible(db, f.workspace)).toBe(false);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: recent }).where(eq(heartbeatRuns.id, runId));
      expect(await f.eligible()).toBe(true);
      expect(await workspaceMoveEligible(db, f.workspace)).toBe(true);
      // Downstream lease matching depends on the same run IDs even after the
      // controller has settled, with no direct issue/workspace lease binding.
      await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: runId, status: "pending_cleanup", releasedAt: recent });
      expect(await f.eligible()).toBe(false);
      expect(await workspaceMoveEligible(db, f.workspace)).toBe(false);
    });

  it("retains both native and conflicting legacy bindings", async () => {
    const f = await fixture();
    const [unrelated] = await db.insert(issues).values({ companyId: f.companyId, title: "Unrelated", updatedAt: old }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: unrelated.id,
      status: "running", createdAt: recent, contextSnapshot: { taskId: f.issueId } });
    expect(await f.eligible()).toBe(false);
    expect(await gitWorkspaceLastActivityAt(db, f.workspace)).toEqual(recent);
  });

  it("includes a multiply bound run exactly once", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, scopeKind: "issue", issueId: f.issueId,
      nativeIssueId: f.child.id, status: "succeeded", createdAt: recent, finishedAt: recent,
      contextSnapshot: { issueId: f.issueId, taskId: f.child.id, executionWorkspaceId: f.workspace.id } });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, f.bound.id));
    const [row] = await db.execute<{ count: number }>(sql`${expirationScope(f.workspace)} SELECT count(*)::int AS count FROM relevant_runs`);
    expect(row.count).toBe(1);
    expect(await f.eligible()).toBe(true);
  });

  it("keeps malformed contexts, case sensitivity, and company isolation unchanged", async () => {
    const f = await fixture();
    const contexts = [null, [], [{ issueId: f.issueId }], [[{ taskId: f.issueId }]], true, 12, "string", { issueId: f.issueId.toUpperCase() },
      { issueId: 12 }, { taskId: { id: f.issueId } }, { executionWorkspaceId: [f.workspace.id] }];
    for (const context of contexts) await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot)
      VALUES ($1::uuid, $2::uuid, 'running', $3::timestamptz, $4::jsonb)`, [f.companyId, f.agentId, recent.toISOString(), JSON.stringify(context)]);
    const otherCompanyId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `AO${otherCompanyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Other" });
    await db.insert(heartbeatRuns).values({ companyId: otherCompanyId, agentId: otherAgentId, nativeIssueId: f.issueId,
      status: "running", createdAt: recent, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, executionWorkspaceId: f.workspace.id } });
    expect(await f.eligible()).toBe(true);
    expect(await gitWorkspaceLastActivityAt(db, f.workspace)).toEqual(old);
  });

  it.each(["null", "array", "nestedArray", "number", "string", "boolean"])("retains native matches with %s context", async kind => {
    const f = await fixture();
    const contexts = { null: null, array: [{ issueId: f.issueId }], nestedArray: [[{ taskId: f.issueId }]], number: 12, string: "string", boolean: true };
    const context = contexts[kind as keyof typeof contexts];
    await db.$client.unsafe(`INSERT INTO heartbeat_runs (company_id, agent_id, native_issue_id, status, created_at, context_snapshot)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', $4::timestamptz, $5::jsonb)`, [f.companyId, f.agentId, f.issueId, recent.toISOString(), JSON.stringify(context)]);
    expect(await f.eligible()).toBe(false);
    expect(await gitWorkspaceLastActivityAt(db, f.workspace)).toEqual(recent);
  });

  it("keeps a finished run with a current controller lease", async () => {
    const f = await fixture();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", createdAt: old, finishedAt: old,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000), contextSnapshot: { executionWorkspaceId: f.workspace.id } });
    expect(await f.eligible()).toBe(false);
  });

  it("still observes a newly active consumer between successive checks", async () => {
    const f = await fixture();
    expect(await f.eligible()).toBe(true);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued", createdAt: recent,
      contextSnapshot: { executionWorkspaceId: f.workspace.id } });
    expect(await f.eligible()).toBe(false);
    expect(await gitWorkspaceLastActivityAt(db, f.workspace)).toEqual(recent);
  });
});
