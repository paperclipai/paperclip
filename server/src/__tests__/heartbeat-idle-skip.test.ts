import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Idle-skip test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat idle-skip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(db: ReturnType<typeof createDb>, runId: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (run && ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
}

async function heartbeatSideEffectFingerprint(db: ReturnType<typeof createDb>) {
  const [active, events, activity, leases, runtimeServices] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
    db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
    db.select({ count: sql<number>`count(*)` }).from(activityLog),
    db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
    db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
  ]);

  return [
    active[0]?.count ?? 0,
    events[0]?.count ?? 0,
    activity[0]?.count ?? 0,
    leases[0]?.count ?? 0,
    runtimeServices[0]?.count ?? 0,
  ].join(":");
}

async function waitForHeartbeatSideEffectsSettled(
  db: ReturnType<typeof createDb>,
  timeoutMs = 5_000,
  quietMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const current = await heartbeatSideEffectFingerprint(db);
    const activeCount = Number(current.split(":")[0] ?? 0);
    if (current !== previous || activeCount > 0) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for heartbeat side effects to settle");
}

describeEmbeddedPostgres("heartbeat idle skip", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-idle-skip-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitForHeartbeatSideEffectsSettled(db);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    idleSkipEnabled?: boolean;
    heartbeatEnabled?: boolean;
    intervalSec?: number;
    lastHeartbeatAt?: Date | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-12T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: input.heartbeatEnabled ?? true,
          intervalSec: input.intervalSec ?? 60,
          maxConcurrentRuns: 1,
          wakeOnDemand: true,
          idleSkip: {
            enabled: input.idleSkipEnabled ?? false,
          },
        },
      },
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt ?? new Date(now.getTime() - 120_000),
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, agentId };
  }

  async function seedAssignedIssue(input: {
    companyId: string;
    agentId: string;
    status: string;
    hiddenAt?: Date | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Assigned ${input.status} issue`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber: 1,
      identifier: `IDL-${issueId.slice(0, 8).toUpperCase()}`,
      hiddenAt: input.hiddenAt ?? null,
    });
    return issueId;
  }

  it("skips timer wakeups before creating a run when idleSkip is enabled and the agent has no active assigned issues", async () => {
    const { agentId } = await seedAgent({ idleSkipEnabled: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: { source: "scheduler" },
    });

    expect(result).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);

    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup).toMatchObject({
      source: "timer",
      status: "skipped",
      reason: "heartbeat.idle_skip.no_work",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    expect(wakeup.finishedAt).toBeInstanceOf(Date);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.lastHeartbeatAt?.getTime()).toBeGreaterThan(new Date("2026-04-12T09:58:00.000Z").getTime());
  });

  it("coalesces timer wakeups instead of idle-skipping while an unscoped run is active", async () => {
    const { companyId, agentId } = await seedAgent({ idleSkipEnabled: true });
    const runningRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      contextSnapshot: { source: "scheduler" },
    });

    expect(result?.id).toBe(runningRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "coalesced",
      reason: "heartbeat_timer",
      runId: runningRunId,
    });
    expect(wakeups.some((wakeup) => wakeup.reason === "heartbeat.idle_skip.no_work")).toBe(false);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runningRunId));
  });

  it("does not skip timer wakeups when idleSkip is disabled", async () => {
    const { agentId } = await seedAgent({ idleSkipEnabled: false });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(db, run!.id);
    expect(finished?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it.each(["todo", "in_progress", "in_review", "blocked"])(
    "does not skip timer wakeups when the agent has an assigned %s issue",
    async (status) => {
      const { companyId, agentId } = await seedAgent({ idleSkipEnabled: true });
      await seedAssignedIssue({ companyId, agentId, status });
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
      });

      expect(run).not.toBeNull();
      await waitForRunToFinish(db, run!.id);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores hidden assigned issues when deciding whether a timer wake has work", async () => {
    const { companyId, agentId } = await seedAgent({ idleSkipEnabled: true });
    await seedAssignedIssue({
      companyId,
      agentId,
      status: "todo",
      hiddenAt: new Date("2026-04-12T09:59:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup.reason).toBe("heartbeat.idle_skip.no_work");
  });

  it("does not apply idleSkip to on-demand wakeups", async () => {
    const { agentId } = await seedAgent({ idleSkipEnabled: true });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_ping",
    });

    expect(run).not.toBeNull();
    await waitForRunToFinish(db, run!.id);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not apply idleSkip to targeted timer wakeups", async () => {
    const { companyId, agentId } = await seedAgent({ idleSkipEnabled: true });
    const issueId = await seedAssignedIssue({ companyId, agentId, status: "backlog" });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    expect(run).not.toBeNull();
    await waitForRunToFinish(db, run!.id);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("lets tickTimers record an idle skip and advance the timer baseline", async () => {
    const { agentId } = await seedAgent({
      idleSkipEnabled: true,
      intervalSec: 60,
      lastHeartbeatAt: new Date("2026-04-12T09:58:00.000Z"),
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-12T10:00:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(tickAt.getTime());
  });
});
