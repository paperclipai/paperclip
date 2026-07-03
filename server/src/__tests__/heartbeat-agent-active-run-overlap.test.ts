import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent active-run overlap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Agent-level run-overlap guard — timer-source wakes must not pile up against an agent
// that already has a queued/running/scheduled_retry heartbeat_run. These tests cover the
// two layers:
//   B.1 — tickTimers pre-skips agents with active runs so enqueueWakeup is not invoked.
//   B.2 — enqueueWakeup defends against the same condition for any timer-source caller.
describeEmbeddedPostgres("agent active-run overlap guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-agent-active-run-overlap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Use TRUNCATE CASCADE to wipe all referencing tables (agent_runtime_state,
    // execution_workspaces, etc.) — listing tables explicitly with db.delete() runs
    // into FK violations from rows that orchestration writes through the run path.
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRun(opts: {
    runStatus: "queued" | "running" | "scheduled_retry";
    runInvocationSource?: string;
    runIssueId?: string | null;
    lastHeartbeatMinutesAgo?: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = opts.runIssueId === undefined ? randomUUID() : opts.runIssueId;
    const now = new Date();
    const lastHeartbeatAt = new Date(
      now.getTime() - (opts.lastHeartbeatMinutesAgo ?? 10) * 60_000,
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Overlap Co",
      status: "active",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Overlap Worker",
      role: "engineer",
      status: opts.runStatus === "running" ? "running" : "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      lastHeartbeatAt,
    });

    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Active work",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
    }

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: opts.runStatus,
      invocationSource: opts.runInvocationSource ?? "assignment",
      triggerDetail: "system",
      startedAt: opts.runStatus === "running" ? lastHeartbeatAt : null,
      processStartedAt: opts.runStatus === "running" ? lastHeartbeatAt : null,
      lastOutputAt: opts.runStatus === "running" ? lastHeartbeatAt : null,
      contextSnapshot: issueId ? { issueId } : {},
      logBytes: 0,
    });

    return { companyId, agentId, runId, issueId };
  }

  it("B.1: tickTimers skips agents that already have a running run", async () => {
    const { agentId, runId } = await seedAgentWithRun({ runStatus: "running" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date());

    // The agent was checked (passed invokability + heartbeat policy gates) but the
    // active-run pre-filter prevented enqueueWakeup from being invoked, so no new run
    // was queued behind the active one.
    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const runsForAgent = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.id === runId || row.status === "queued"));
    // Only the original active run exists; no new queued run was created.
    expect(runsForAgent).toHaveLength(1);
    expect(runsForAgent[0]?.id).toBe(runId);
  });

  it("B.1: tickTimers skips agents that already have a queued run", async () => {
    await seedAgentWithRun({ runStatus: "queued" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date());

    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const allRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns);
    // No additional rows beyond the seeded queued run should exist.
    expect(allRuns.length).toBe(1);
  });

  it("B.1: tickTimers still enqueues for agents with no active run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Idle Co",
      status: "active",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
      lastHeartbeatAt: new Date(now.getTime() - 5 * 60_000),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now);

    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("B.2: wakeup with source=timer is skipped when the agent has an active issue_assigned run", async () => {
    const { agentId, runId } = await seedAgentWithRun({
      runStatus: "running",
      runInvocationSource: "assignment",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: new Date().toISOString(),
      },
    });

    // Skipped — no new run is queued behind the active issue_assigned run.
    expect(result).toBeNull();

    const allRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.id).toBe(runId);

    const skippedWakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        source: agentWakeupRequests.source,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.filter((row) => row.source === "timer"));
    expect(skippedWakeups).toHaveLength(1);
    expect(skippedWakeups[0]).toMatchObject({
      status: "skipped",
      reason: "agent.has_active_run",
    });
  });

  it("B.2: wakeup with non-timer source is NOT skipped by the active-run guard", async () => {
    // Cross-task non-timer wakes (e.g. user-driven cross-issue wakes) must keep their
    // existing semantics — only same-scope coalescing applies, and the active-run guard
    // is intentionally scoped to source=timer.
    const { agentId } = await seedAgentWithRun({
      runStatus: "running",
      runInvocationSource: "assignment",
      runIssueId: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "user_wake",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: {},
    });

    // Either a new run is queued (different scope) or the wake coalesces into the
    // active run via same-scope semantics — both are valid; the assertion is that the
    // active-run guard does NOT silently skip this non-timer wake.
    const skippedActiveRunGuard = await db
      .select({
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.reason === "agent.has_active_run"));
    expect(skippedActiveRunGuard).toBeUndefined();
    expect(result).not.toBeNull();
  });
});
