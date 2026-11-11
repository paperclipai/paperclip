import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ExecutionWorkspaceLeaseConflictError, environmentService } from "../services/environments.ts";
import { EnvironmentRunError, environmentRunOrchestrator } from "../services/environment-run-orchestrator.ts";
import { executionWorkspaceRequiresExclusiveLease } from "../services/execution-workspace-policy.ts";

/**
 * Regression coverage for LAC-6296.
 *
 * Two runs held `active` ephemeral leases on execution workspace
 * 07f19587-5990-4705-b077-196fed1c8c03 at the same time (2026-10-30), so two
 * agents edited one git worktree: the second run checked its own branch out in
 * the first run's worktree and the harness only noticed 4 minutes later, on a
 * lease boundary. A lease on a single-branch checkout has to be exclusive.
 */
describe("executionWorkspaceRequiresExclusiveLease", () => {
  it("treats single-branch checkouts as exclusive", () => {
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        providerType: "git_worktree",
      }),
    ).toBe(true);
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "operator_branch",
        strategyType: "project_primary",
        providerType: "local_fs",
      }),
    ).toBe(true);
    // A worktree strategy is one directory pinned to one branch whatever the
    // mode says, so the strategy alone is enough.
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "shared_workspace",
        strategyType: "git_worktree",
        providerType: "git_worktree",
      }),
    ).toBe(true);
  });

  it("leaves shared and adapter-managed workspaces concurrent", () => {
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "shared_workspace",
        strategyType: "project_primary",
        providerType: "local_fs",
      }),
    ).toBe(false);
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "agent_default",
        strategyType: "adapter_managed",
        providerType: "adapter_managed",
      }),
    ).toBe(false);
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "agent_default",
        strategyType: "cloud_sandbox",
        providerType: "cloud_sandbox",
      }),
    ).toBe(false);
    // A sandbox keeps its own lease reuse rules even when the issue asked for
    // an isolated workspace: nothing here checks a branch out on local disk.
    expect(
      executionWorkspaceRequiresExclusiveLease({
        mode: "isolated_workspace",
        strategyType: "cloud_sandbox",
        providerType: "cloud_sandbox",
      }),
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace lease exclusivity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("environmentService.acquireLease execution workspace exclusivity", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof environmentService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("execution-workspace-lease-exclusivity");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = environmentService(db);
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedContendedWorkspace(
    workspaceShape: Pick<typeof executionWorkspaces.$inferInsert, "mode" | "strategyType" | "providerType"> = {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      providerType: "git_worktree",
    },
  ) {
    const now = new Date();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const holderIssueId = randomUUID();
    const contenderIssueId = randomUUID();
    const holderRunId = randomUUID();
    const contenderRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Lease Fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Town of Harmony",
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values([
      {
        id: holderIssueId,
        companyId,
        projectId,
        title: "Hero image is broken on homepage",
        status: "in_progress",
        priority: "high",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: contenderIssueId,
        companyId,
        projectId,
        title: "Lightbox image fallback",
        status: "in_progress",
        priority: "medium",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: holderIssueId,
      mode: workspaceShape.mode,
      strategyType: workspaceShape.strategyType,
      providerType: workspaceShape.providerType,
      name: "LAC-6283-hero-image-is-broken-on-homepage",
      status: "active",
      branchName: "LAC-6283-hero-image-is-broken-on-homepage",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: holderRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: contenderRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    return {
      companyId,
      agentId,
      environmentId,
      workspaceId,
      holderIssueId,
      contenderIssueId,
      holderRunId,
      contenderRunId,
    };
  }

  function acquireInput(seed: Awaited<ReturnType<typeof seedContendedWorkspace>>, who: "holder" | "contender") {
    return {
      companyId: seed.companyId,
      environmentId: seed.environmentId,
      executionWorkspaceId: seed.workspaceId,
      issueId: who === "holder" ? seed.holderIssueId : seed.contenderIssueId,
      heartbeatRunId: who === "holder" ? seed.holderRunId : seed.contenderRunId,
      leasePolicy: "ephemeral" as const,
      provider: "local",
      metadata: { driver: "local", executionWorkspaceMode: "isolated_workspace" },
    };
  }

  it("refuses a second run an active lease on one git worktree", async () => {
    const seed = await seedContendedWorkspace();

    const holderLease = await svc.acquireLease(acquireInput(seed, "holder"));
    expect(holderLease.status).toBe("active");

    await expect(svc.acquireLease(acquireInput(seed, "contender"))).rejects.toThrow(
      ExecutionWorkspaceLeaseConflictError,
    );

    const active = await svc.listLeases(seed.environmentId, { status: "active" });
    expect(active.map((lease) => lease.id)).toEqual([holderLease.id]);
  });

  it("names the holding run and issue on the conflict so the loser is diagnosable", async () => {
    const seed = await seedContendedWorkspace();
    const holderLease = await svc.acquireLease(acquireInput(seed, "holder"));

    const error = await svc
      .acquireLease(acquireInput(seed, "contender"))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ExecutionWorkspaceLeaseConflictError);
    const conflict = error as ExecutionWorkspaceLeaseConflictError;
    expect(conflict.executionWorkspaceId).toBe(seed.workspaceId);
    expect(conflict.conflictingLeaseId).toBe(holderLease.id);
    expect(conflict.conflictingHeartbeatRunId).toBe(seed.holderRunId);
    expect(conflict.conflictingIssueId).toBe(seed.holderIssueId);
  });

  it("lets the holding run re-acquire its own workspace", async () => {
    const seed = await seedContendedWorkspace();
    await svc.acquireLease(acquireInput(seed, "holder"));

    const second = await svc.acquireLease(acquireInput(seed, "holder"));

    expect(second.status).toBe("active");
    expect(second.heartbeatRunId).toBe(seed.holderRunId);
  });

  it("does not let a lease leaked by a dead run wedge the worktree", async () => {
    const seed = await seedContendedWorkspace();
    await svc.acquireLease(acquireInput(seed, "holder"));

    // The holder was killed without releasing: its lease still reads `active`.
    // Before, that was harmless; an exclusivity check that honoured it would
    // park every later run on this workspace forever.
    await db
      .update(heartbeatRuns)
      .set({ status: "timed_out", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seed.holderRunId));

    const contenderLease = await svc.acquireLease(acquireInput(seed, "contender"));

    expect(contenderLease.status).toBe("active");
    expect(contenderLease.heartbeatRunId).toBe(seed.contenderRunId);
  });

  it("hands the worktree to the next run once the lease is released", async () => {
    const seed = await seedContendedWorkspace();
    const holderLease = await svc.acquireLease(acquireInput(seed, "holder"));
    await svc.releaseLease(holderLease.id);

    const contenderLease = await svc.acquireLease(acquireInput(seed, "contender"));

    expect(contenderLease.status).toBe("active");
    expect(contenderLease.heartbeatRunId).toBe(seed.contenderRunId);
  });

  it("serializes genuinely concurrent acquisitions to exactly one winner", async () => {
    const seed = await seedContendedWorkspace();

    const settled = await Promise.allSettled([
      svc.acquireLease(acquireInput(seed, "holder")),
      svc.acquireLease(acquireInput(seed, "contender")),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ExecutionWorkspaceLeaseConflictError);

    const active = await svc.listLeases(seed.environmentId, { status: "active" });
    expect(active).toHaveLength(1);
  });

  it("still lets two runs share a shared_workspace checkout", async () => {
    const seed = await seedContendedWorkspace({
      mode: "shared_workspace",
      strategyType: "project_primary",
      providerType: "local_fs",
    });

    await svc.acquireLease(acquireInput(seed, "holder"));
    const contenderLease = await svc.acquireLease(acquireInput(seed, "contender"));

    expect(contenderLease.status).toBe("active");
    const active = await svc.listLeases(seed.environmentId, { status: "active" });
    expect(active).toHaveLength(2);
  });

  it("surfaces contention to the run as execution_workspace_lease_conflict, not a generic lease failure", async () => {
    const seed = await seedContendedWorkspace();
    const holderLease = await svc.acquireLease(acquireInput(seed, "holder"));

    // Stand in for the local driver: the real driver call is just a pass-through
    // to environmentService.acquireLease, which is the guard under test.
    const runtime = {
      acquireRunLease: async (input: {
        persistedExecutionWorkspace: { id: string } | null;
        heartbeatRunId: string;
      }) => {
        const lease = await svc.acquireLease({
          companyId: seed.companyId,
          environmentId: seed.environmentId,
          executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
          issueId: seed.contenderIssueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "ephemeral",
          provider: "local",
        });
        return { lease, leaseContext: null };
      },
    } as unknown as Parameters<typeof environmentRunOrchestrator>[1]["environmentRuntime"];

    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });

    const error = await orchestrator
      .acquireForRun({
        companyId: seed.companyId,
        selectedEnvironmentId: seed.environmentId,
        localEnvironmentId: seed.environmentId,
        adapterType: "claude_local",
        issueId: seed.contenderIssueId,
        heartbeatRunId: seed.contenderRunId,
        agentId: seed.agentId,
        persistedExecutionWorkspace: { id: seed.workspaceId, mode: "isolated_workspace" },
      })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EnvironmentRunError);
    const runError = error as EnvironmentRunError;
    expect(runError.code).toBe("execution_workspace_lease_conflict");
    expect(runError.message).toContain(seed.holderRunId);
    expect(runError.message).toContain(holderLease.id);
  });

  it("leaves workspace-less leases concurrent", async () => {
    const seed = await seedContendedWorkspace();

    await svc.acquireLease({ ...acquireInput(seed, "holder"), executionWorkspaceId: null });
    await svc.acquireLease({ ...acquireInput(seed, "contender"), executionWorkspaceId: null });

    const active = await svc.listLeases(seed.environmentId, { status: "active" });
    expect(active).toHaveLength(2);
  });
});
