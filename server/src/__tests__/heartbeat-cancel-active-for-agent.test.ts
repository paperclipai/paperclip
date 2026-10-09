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
    expect(byId[otherAgentRunId].status).toBe("running");
  });

  it("does not clobber a run that wins the race to finish, and does not count it as cancelled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun({ companyId, agentId, status: "running" });

    const dbB = createDb(tempDb!.connectionString);
    try {
      await dbB.select({ id: heartbeatRuns.id }).from(heartbeatRuns).limit(1);

      const [cancelOutcome, finalizationRows] = await Promise.all([
        heartbeat.cancelInvocationsForAgents([agentId], "Cancelled due to agent pause"),
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

      const finalizationWon = finalizationRows.length > 0;
      if (finalizationWon) {
        expect(finalRow.status).toBe("succeeded");
        expect(finalRow.errorCode).toBeNull();
        expect(cancelOutcome.runsCancelled).toBe(0);
      } else {
        expect(finalRow.status).toBe("cancelled");
        expect(cancelOutcome.runsCancelled).toBe(1);
      }
    } finally {
      await (dbB as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  });
});
