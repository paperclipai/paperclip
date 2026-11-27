import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";

vi.mock("../local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

describe.skipIf(!runControlPostgresSupport.supported)("cancellation event append failure", () => {
  let db: Db;
  const { fixture } = setupRunControlDatabase("paperclip-cancel-event-failure", value => { db = value; });
  beforeAll(async () => { await db.execute(sql`set client_min_messages to warning`); });
  it.each(["queued", "running"] as const)("finishes cancelling a %s run when its lifecycle event append fails", async status => {
    const { company, agent } = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "assignment", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status, runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), wakeupRequestId: wake.id }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Release after Stop",
      status: "in_progress", assigneeAgentId: agent.id, executionRunId: run.id,
      executionAgentNameKey: "controlled-agent", executionLockedAt: new Date() }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } })
      .where(eq(heartbeatRuns.id, run.id));
    const deps = callbacks(db);
    vi.mocked(deps.wakeQueue.releaseIssueExecution).mockImplementation(createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "operator",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    }));
    vi.mocked(deps.appendRunEvent).mockRejectedValueOnce(new Error("Synthetic event append failure"));

    await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, undefined, {
      suppressImmediateRecovery: true,
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(await deps.getRun(run.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0])
      .toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0])
      .toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(deps.finalizeAgentStatus).toHaveBeenCalledExactlyOnceWith(agent.id, "cancelled", undefined, { wasFirstHeartbeat: undefined });
    expect(deps.startNextQueuedRunForAgent).toHaveBeenCalledExactlyOnceWith(agent.id);
  });
});
