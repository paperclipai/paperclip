import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cancelActiveForAgent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for cancelActiveForAgentInternal (agent pause/terminate,
// non-invokable-agent, and budget-pause cancellation sweeps all funnel through
// it). It used to select every run in a cancellable status and then write
// "cancelled" to each one unconditionally, counting the rows it *found*
// rather than the rows it actually moved. A run that finished through the
// normal path between that select and the write got silently clobbered, and
// the finalization that already legitimately claimed the row then lost its
// own compare-and-set (status no longer "running") and skipped its task
// session persistence - the "agent loses context between turns" symptom. The
// fix routes every run through the same compare-and-set path the
// control-plane Stop endpoint uses (cancelRunInternal) and counts only the
// runs that actually transitioned.
describeEmbeddedPostgres("cancelActiveForAgentInternal", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-cancel-active-for-agent-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedRun(opts: {
    companyId: string;
    agentId: string;
    status: "queued" | "running" | "scheduled_retry";
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.status,
      contextSnapshot: { wakeReason: "test" },
    });
    return runId;
  }

  it("cancels every active run for the agent and reports the number actually cancelled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const otherAgentId = await seedAgent(companyId);

    const runningId = await seedRun({ companyId, agentId, status: "running" });
    const queuedId = await seedRun({ companyId, agentId, status: "queued" });
    const otherAgentRunId = await seedRun({ companyId, agentId: otherAgentId, status: "running" });

    const result = await heartbeat.cancelInvocationsForAgents(
      [agentId],
      "Cancelled due to agent pause",
    );

    expect(result.runsCancelled).toBe(2);

    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId[runningId].status).toBe("cancelled");
    expect(byId[queuedId].status).toBe("cancelled");
    // A different agent's run in the same company is untouched.
    expect(byId[otherAgentRunId].status).toBe("running");
  });

  it("does not clobber a run that wins the race to finish, and does not count it as cancelled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun({ companyId, agentId, status: "running" });

    // Two real connections, so the cancellation sweep and the "adapter just
    // finished" write truly overlap instead of serializing on one client.
    const dbB = createDb(tempDb!.connectionString);
    try {
      // Warm up the second connection first so both sides start together.
      await dbB.select({ id: heartbeatRuns.id }).from(heartbeatRuns).limit(1);

      const [cancelOutcome, finalizationRows] = await Promise.all([
        heartbeat.cancelInvocationsForAgents([agentId], "Cancelled due to agent pause"),
        // Stand-in for the normal finalization path's own compare-and-set
        // write (setRunStatusIfRunning), without needing to drive a whole
        // adapter execution just to race it.
        dbB
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")))
          .returning({ id: heartbeatRuns.id }),
      ]);

      const [finalRow] = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      // Read which side's compare-and-set actually matched the row, instead
      // of inferring the winner from the final persisted status. Under the
      // old blind-write bug, the cancellation sweep could overwrite a row
      // *after* the finalization's own CAS already won it - so a final
      // status of "cancelled" alone does not prove the sweep's CAS won too.
      // Asserting against finalizationRows (empty unless the finalization's
      // own `WHERE status = 'running'` matched) catches that regression even
      // when the finalization-then-overwrite interleaving occurs.
      const finalizationWon = finalizationRows.length > 0;
      if (finalizationWon) {
        // The finalization's own compare-and-set matched the row. The
        // cancellation sweep must not have clobbered that outcome afterward,
        // and must not report this run as cancelled.
        expect(finalRow.status).toBe("succeeded");
        expect(finalRow.errorCode).toBeNull();
        expect(cancelOutcome.runsCancelled).toBe(0);
      } else {
        // The cancellation sweep's compare-and-set won first, so the
        // finalization's own write found zero matching rows. The sweep must
        // report exactly the one run it actually moved.
        expect(finalRow.status).toBe("cancelled");
        expect(cancelOutcome.runsCancelled).toBe(1);
      }
    } finally {
      await (dbB as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  });
});
