import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaceRuntimeLeases,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createOwnershipReportState,
  runOwnershipReconciliationPass,
  settleOwnableKind,
} from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { settleExecutionWorkspaceRuntimeLease } from "../services/workspace-runtime-lease-settlement.js";
import {
  WORKSPACE_RUNTIME_LEASE_TTL_MS,
  workspaceRuntimeLeaseService,
} from "../services/workspace-runtime-leases.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const KIND = "execution_workspace_runtime_lease";
const kind = OWNABLE_KINDS.find(entry => entry.id === KIND)!;

/**
 * The execution workspace runtime lease on the shared ownership path: a lease
 * whose issue or run owner is proven gone is released by identity, never by
 * age; live and agent-scoped owners are never released by the reconciler.
 */
describeEmbeddedPostgres("execution workspace runtime lease ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db!: ReturnType<typeof createDb>;
  let companyId: string;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-lease-ownership-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate activity_log, execution_workspace_runtime_leases, issues, execution_workspaces,
      projects, heartbeat_runs, agents, companies cascade`);
    companyId = randomUUID(); projectId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease ownership", issuePrefix: "LOW",
      requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "Lane", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer" });
  });

  async function workspace() {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({ id, companyId, projectId, mode: "shared_workspace",
      strategyType: "git_worktree", name: "Shared", status: "active", cwd: `/tmp/lease-${id}` });
    return id;
  }
  async function issue(status = "in_progress") {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, projectId, title: "Lane issue", status, priority: "high",
      assigneeAgentId: agentId });
    return id;
  }
  async function run(status = "running") {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status });
    return id;
  }
  const owner = (input: { issueId?: string; runId?: string }) =>
    ({ actorType: "agent", agentId, runId: input.runId ?? null, issueId: input.issueId ?? null });
  async function claim(executionWorkspaceId: string, input: { issueId?: string; runId?: string }, now?: Date) {
    return workspaceRuntimeLeaseService(db).claim({ companyId, executionWorkspaceId, action: "start",
      owner: owner(input), now });
  }
  const leaseRows = () => db.select().from(executionWorkspaceRuntimeLeases);
  const pass = (record = true) => runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
    kinds: [kind], record });

  it("settles a lease whose owner issue finished without releasing it (crash after claim)", async () => {
    const workspaceId = await workspace();
    const issueId = await issue();
    await claim(workspaceId, { issueId });
    // The owner died between entering the lease and leaving it: the issue is
    // done, and nothing released the lane.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const report = await pass();
    expect(report.kinds[0]).toMatchObject({ kind: KIND, inProgress: 1, settled: 1 });
    expect(report.kinds[0]!.reasons).toEqual({ owner_issue_terminal: 1 });
    expect(await leaseRows()).toHaveLength(0);
    // The release is logged with the previous owner and the proof.
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "execution_workspace.runtime_lease_released")))
      .toMatchObject([{ actorId: "ownership-reconciler", entityType: "execution_workspace", entityId: workspaceId,
        details: { previousOwnerKey: `issue:${issueId}`, proof: "owner_issue_terminal" } }]);
  });

  it("settles leases of hidden or missing issues and of terminal or missing runs", async () => {
    const hiddenIssue = await issue();
    const missingIssue = await issue();
    const terminalRun = await run();
    const missingRun = await run();
    await claim(await workspace(), { issueId: hiddenIssue });
    await claim(await workspace(), { issueId: missingIssue });
    await claim(await workspace(), { runId: terminalRun });
    await claim(await workspace(), { runId: missingRun });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssue));
    await db.delete(issues).where(eq(issues.id, missingIssue));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, terminalRun));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, missingRun));

    const settled = await settleOwnableKind(db, KIND);
    expect(settled.map(entry => entry.reason).sort()).toEqual(
      ["owner_issue_hidden", "owner_issue_missing", "owner_run_missing", "owner_run_terminal"]);
    expect(await leaseRows()).toHaveLength(0);
  });

  it("never releases a live issue's or run's lease by age, even long past the idle window", async () => {
    const longAgo = new Date(Date.now() - 10 * WORKSPACE_RUNTIME_LEASE_TTL_MS);
    await claim(await workspace(), { issueId: await issue("blocked") }, longAgo);
    await claim(await workspace(), { runId: await run("running") }, longAgo);

    const report = await pass();
    expect(report.kinds[0]).toMatchObject({ inProgress: 2, settled: 0, verdicts: { gone: 0, alive: 2, unprovable: 0 } });
    expect(await leaseRows()).toHaveLength(2);
  });

  it("never settles an agent-scoped lease: alive while held, unprovable once expired", async () => {
    const held = await workspace();
    const expired = await workspace();
    await claim(held, {});
    await claim(expired, {}, new Date(Date.now() - 2 * WORKSPACE_RUNTIME_LEASE_TTL_MS));

    const report = await pass();
    expect(report.kinds[0]).toMatchObject({ inProgress: 2, settled: 0, verdicts: { gone: 0, alive: 1, unprovable: 1 } });
    expect(report.kinds[0]!.reasons).toEqual({ fence_held: 1, fence_expired_without_provider_proof: 1 });
    expect(await leaseRows()).toHaveLength(2);
  });

  it("changes nothing on a read-only pass", async () => {
    const issueId = await issue();
    await claim(await workspace(), { issueId });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));

    const report = await pass(false);
    expect(report.kinds[0]).toMatchObject({ settled: 0, verdicts: { gone: 1, alive: 0, unprovable: 0 } });
    expect(await leaseRows()).toHaveLength(1);
  });

  it("keeps a lease that was taken over after the proof (compare-and-swap on the proven owner)", async () => {
    const workspaceId = await workspace();
    const doneIssue = await issue();
    const nextIssue = await issue();
    await claim(workspaceId, { issueId: doneIssue });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, doneIssue));
    const listed = (await kind.listInProgress!(db, 10, 0)).records;
    expect(listed).toHaveLength(1);
    // A competing claim reclaims the lane between the proof and the settle.
    await claim(workspaceId, { issueId: nextIssue });

    const outcome = await settleExecutionWorkspaceRuntimeLease(db, listed[0]!,
      { now: new Date(), proof: { verdict: "gone", reason: "pid_dead" } });
    expect(outcome).toEqual({ settled: false, reason: "lease_no_longer_held" });
    expect((await leaseRows())[0]?.ownerIssueId).toBe(nextIssue);
  });

  it("names the ownership proof, not the idle policy, when a gone owner's lease also expired", async () => {
    const workspaceId = await workspace();
    const doneIssue = await issue();
    await claim(workspaceId, { issueId: doneIssue }, new Date(Date.now() - 2 * WORKSPACE_RUNTIME_LEASE_TTL_MS));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, doneIssue));

    const reclaimed = await claim(workspaceId, { issueId: await issue() });
    expect(reclaimed.reclaimedFrom).toEqual({ ownerKey: `issue:${doneIssue}`, reason: "owner_issue_terminal" });
  });

  it("keeps the idle-reclaim policy at claim time for a live but idle owner", async () => {
    const workspaceId = await workspace();
    const idleIssue = await issue();
    await claim(workspaceId, { issueId: idleIssue }, new Date(Date.now() - WORKSPACE_RUNTIME_LEASE_TTL_MS - 60_000));

    const reclaimed = await claim(workspaceId, { issueId: await issue() });
    expect(reclaimed.reclaimedFrom).toEqual({ ownerKey: `issue:${idleIssue}`, reason: "lease_expired" });
  });
});
