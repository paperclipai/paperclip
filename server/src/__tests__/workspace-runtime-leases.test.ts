import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaceRuntimeLeases,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  WORKSPACE_RUNTIME_LEASE_TTL_MS,
  workspaceRuntimeLeaseService,
} from "../services/workspace-runtime-leases.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution workspace runtime lease tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution workspace runtime leases", () => {
  let db!: ReturnType<typeof createDb>;
  // A second client with its own connection pool stands in for a second server
  // process: nothing is shared in memory, so exclusivity has to come from Postgres.
  let otherProcessDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-runtime-lease-");
    db = createDb(tempDb.connectionString);
    otherProcessDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(executionWorkspaceRuntimeLeases);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLane() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Runtime lease",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Canary lane",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "git_worktree",
      name: "Shared canary workspace",
      status: "active",
      cwd: "/tmp/runtime-lease-workspace",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Security Engineer",
      role: "engineer",
    });

    return { companyId, projectId, executionWorkspaceId, agentId };
  }

  async function seedIssue(
    lane: { companyId: string; projectId: string; executionWorkspaceId: string; agentId: string },
    input: { title: string; status?: string },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: lane.companyId,
      projectId: lane.projectId,
      executionWorkspaceId: lane.executionWorkspaceId,
      title: input.title,
      status: input.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: lane.agentId,
    });
    return issueId;
  }

  async function seedRun(
    lane: { companyId: string; agentId: string },
    input: { status?: string } = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: lane.companyId,
      agentId: lane.agentId,
      status: input.status ?? "running",
    });
    return runId;
  }

  function ownerFor(input: { agentId: string; runId?: string | null; issueId?: string | null }) {
    return {
      actorType: "agent",
      agentId: input.agentId,
      runId: input.runId ?? null,
      issueId: input.issueId ?? null,
    };
  }

  it("grants the first claim and lets the same owner keep operating across runs", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const firstRunId = await seedRun(lane);
    const secondRunId = await seedRun(lane);
    const leases = workspaceRuntimeLeaseService(db);

    const first = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, runId: firstRunId, issueId: canaryIssueId }),
    });
    expect(first.outcome).toBe("created");
    expect(first.ownerKey).toBe(`issue:${canaryIssueId}`);
    expect(first.lease?.lastAction).toBe("start");

    // A later heartbeat of the same issue is still the same owner, even though the
    // run identity changed.
    const second = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "restart",
      owner: ownerFor({ agentId: lane.agentId, runId: secondRunId, issueId: canaryIssueId }),
    });
    expect(second.outcome).toBe("renewed");
    expect(second.lease?.id).toBe(first.lease?.id);
    expect(second.lease?.lastAction).toBe("restart");
    expect(second.lease?.ownerRunId).toBe(secondRunId);

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
  });

  it("rejects a sequential competing issue with 409 and leaves the lease untouched", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const competingIssueId = await seedIssue(lane, { title: "Unrelated shared-workspace work" });
    const leases = workspaceRuntimeLeaseService(db);

    const held = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });

    await expect(leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: competingIssueId }),
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "workspace_runtime_lease_conflict",
        executionWorkspaceId: lane.executionWorkspaceId,
        requestedAction: "start",
        ownerKey: `issue:${canaryIssueId}`,
        ownerIssueId: canaryIssueId,
      },
    });

    const after = await leases.get(lane.executionWorkspaceId);
    expect(after?.id).toBe(held.lease?.id);
    expect(after?.ownerKey).toBe(`issue:${canaryIssueId}`);
    expect(after?.renewedAt.getTime()).toBe(held.lease?.renewedAt.getTime());
  });

  it("serializes concurrent claims from separate database clients so exactly one owner wins", async () => {
    const lane = await seedLane();
    const contenderIssueIds = await Promise.all(
      Array.from({ length: 6 }, (_, index) => seedIssue(lane, { title: `Contender ${index}` })),
    );
    const leaseClients = [workspaceRuntimeLeaseService(db), workspaceRuntimeLeaseService(otherProcessDb)];

    const results = await Promise.allSettled(
      contenderIssueIds.map((issueId, index) =>
        leaseClients[index % leaseClients.length]!.claim({
          companyId: lane.companyId,
          executionWorkspaceId: lane.executionWorkspaceId,
          action: "start",
          owner: ownerFor({ agentId: lane.agentId, issueId }),
        }),
      ),
    );

    const granted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(granted).toHaveLength(1);
    expect(rejected).toHaveLength(contenderIssueIds.length - 1);
    for (const failure of rejected) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        details: { code: "workspace_runtime_lease_conflict" },
      });
    }

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerKey).toBe(
      (granted[0] as PromiseFulfilledResult<{ ownerKey: string | null }>).value.ownerKey,
    );
  });

  it("keeps a competing claim out from another database client after the lease is established", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const competingIssueId = await seedIssue(lane, { title: "Competing lane" });

    await workspaceRuntimeLeaseService(db).claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });

    await expect(workspaceRuntimeLeaseService(otherProcessDb).claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "stop",
      owner: ownerFor({ agentId: lane.agentId, issueId: competingIssueId }),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "workspace_runtime_lease_conflict", requestedAction: "stop" },
    });
  });

  it("lets the teardown issue reclaim once the canary issue reaches a terminal status", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const teardownIssueId = await seedIssue(lane, { title: "Authorized teardown" });
    const leases = workspaceRuntimeLeaseService(db);

    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });

    await expect(leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "stop",
      owner: ownerFor({ agentId: lane.agentId, issueId: teardownIssueId }),
    })).rejects.toMatchObject({ status: 409 });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, canaryIssueId));

    const reclaimed = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "stop",
      owner: ownerFor({ agentId: lane.agentId, issueId: teardownIssueId }),
    });
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.reclaimedFrom).toEqual({
      ownerKey: `issue:${canaryIssueId}`,
      reason: "owner_issue_terminal",
    });
    expect(reclaimed.lease?.ownerIssueId).toBe(teardownIssueId);
  });

  it("reclaims from a hidden owner issue and from a terminal owner run", async () => {
    const lane = await seedLane();
    const hiddenIssueId = await seedIssue(lane, { title: "Hidden owner" });
    const nextIssueId = await seedIssue(lane, { title: "Next owner" });
    const leases = workspaceRuntimeLeaseService(db);

    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: hiddenIssueId }),
    });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssueId));

    const afterHidden = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: nextIssueId }),
    });
    expect(afterHidden.reclaimedFrom?.reason).toBe("owner_issue_hidden");

    // Run-scoped owners (no issue in run context) recover once the run is terminal.
    await leases.release({ executionWorkspaceId: lane.executionWorkspaceId, force: true });
    const staleRunId = await seedRun(lane, { status: "running" });
    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, runId: staleRunId }),
    });

    await expect(leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: nextIssueId }),
    })).rejects.toMatchObject({ status: 409 });

    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, staleRunId));
    const afterRunTerminal = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: nextIssueId }),
    });
    expect(afterRunTerminal.reclaimedFrom).toEqual({
      ownerKey: `run:${staleRunId}`,
      reason: "owner_run_terminal",
    });
  });

  it("bounds recovery with a lease TTL even when the owner still looks eligible", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const competingIssueId = await seedIssue(lane, { title: "Competing lane" });
    const leases = workspaceRuntimeLeaseService(db);

    const claimedAt = new Date(Date.now() - WORKSPACE_RUNTIME_LEASE_TTL_MS - 60_000);
    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
      now: claimedAt,
    });

    const reclaimed = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: competingIssueId }),
    });
    expect(reclaimed.reclaimedFrom).toEqual({
      ownerKey: `issue:${canaryIssueId}`,
      reason: "lease_expired",
    });
  });

  it("lets a teardown issue claim immediately after the owner releases the lane", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const teardownIssueId = await seedIssue(lane, { title: "Authorized teardown" });
    const leases = workspaceRuntimeLeaseService(db);

    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });

    // A non-owner cannot release the lane out from under the owner.
    await expect(leases.release({
      executionWorkspaceId: lane.executionWorkspaceId,
      owner: ownerFor({ agentId: lane.agentId, issueId: teardownIssueId }),
    })).resolves.toEqual({ released: false, ownerKey: null });

    await expect(leases.release({
      executionWorkspaceId: lane.executionWorkspaceId,
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    })).resolves.toEqual({ released: true, ownerKey: `issue:${canaryIssueId}` });

    const claimed = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "stop",
      owner: ownerFor({ agentId: lane.agentId, issueId: teardownIssueId }),
    });
    expect(claimed.outcome).toBe("created");
    expect(claimed.lease?.ownerIssueId).toBe(teardownIssueId);
  });

  it("leaves board/operator control unleased", async () => {
    const lane = await seedLane();
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const leases = workspaceRuntimeLeaseService(db);

    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });

    const boardClaim = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "restart",
      owner: { actorType: "board", agentId: null, runId: null, issueId: null },
    });
    expect(boardClaim).toEqual({ outcome: "bypassed", ownerKey: null, lease: null, reclaimedFrom: null });

    // The agent's lease survives the operator action.
    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerKey).toBe(`issue:${canaryIssueId}`);
  });

  it("scopes leases per execution workspace", async () => {
    const lane = await seedLane();
    const otherWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: otherWorkspaceId,
      companyId: lane.companyId,
      projectId: lane.projectId,
      mode: "shared_workspace",
      strategyType: "git_worktree",
      name: "Second lane",
      status: "active",
      cwd: "/tmp/runtime-lease-workspace-2",
    });
    const canaryIssueId = await seedIssue(lane, { title: "HTTPS canary" });
    const competingIssueId = await seedIssue(lane, { title: "Competing lane" });
    const leases = workspaceRuntimeLeaseService(db);

    await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: lane.executionWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: canaryIssueId }),
    });
    const other = await leases.claim({
      companyId: lane.companyId,
      executionWorkspaceId: otherWorkspaceId,
      action: "start",
      owner: ownerFor({ agentId: lane.agentId, issueId: competingIssueId }),
    });
    expect(other.outcome).toBe("created");

    const rows = await db.select().from(executionWorkspaceRuntimeLeases);
    expect(rows).toHaveLength(2);
  });
});
