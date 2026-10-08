import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  WAKE_EQUIVALENCE_PAYLOAD_KEY,
  buildWakeEquivalenceFingerprint,
  formatBlockerState,
  readWakeRequestIssueScope,
  stampWakeEquivalencePayload,
} from "../services/wake-request-coalescing.ts";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: null,
          provider: "test",
          model: "test-model",
        };
      },
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wake coalescing integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake request coalescing admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wake-request-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedIssue(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Coalesce ${prefix}`,
      status: "active",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${prefix}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${prefix}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  it("coalesces concurrent equivalent wakes onto one run without crossing scope", async () => {
    const primary = await seedIssue("CAA");
    const other = await seedIssue("CAB");
    const payload = { mutation: "monitor_check" };
    const fingerprint = buildWakeEquivalenceFingerprint({
      companyId: primary.companyId,
      agentId: primary.agentId,
      issueId: primary.issueId,
      ownerAgentId: primary.agentId,
      issueStatus: "in_progress",
      issueStatusVersion: 0,
      blockerState: formatBlockerState({
        known: true,
        ready: true,
        unresolvedBlockerIssueIds: [],
        blockedTransitionAt: null,
      }),
      targetSha: null,
      headSha: null,
      nextAction: null,
      payload,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: primary.companyId,
      agentId: primary.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      status: "queued",
      runId,
      payload: stampWakeEquivalencePayload(payload, {
        v: 1,
        fingerprint,
        issueId: primary.issueId,
      }),
      requestedByActorType: "system",
      requestedByActorId: "wake-coalescing-test",
    });

    const heartbeat = heartbeatService(db);
    const conflictingIssueId = randomUUID();
    const wake = (
      scope: { agentId: string; issueId: string },
      payload: Record<string, unknown>,
    ) => heartbeat.wakeup(scope.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      payload,
      contextSnapshot: { issueId: scope.issueId, taskId: scope.issueId },
      requestedByActorType: "system",
      requestedByActorId: "wake-coalescing-test",
    });

    const results = await Promise.all([
      wake(primary, { mutation: "monitor_check" }),
      wake(primary, { mutation: "monitor_check" }),
      wake(primary, { mutation: "monitor_check", issueId: conflictingIssueId }),
      wake(primary, { mutation: "monitor_check" }),
      wake(other, { mutation: "monitor_check" }),
    ]);

    const primaryRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, primary.companyId),
      eq(heartbeatRuns.agentId, primary.agentId),
    ));
    const otherRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, other.companyId));
    expect(primaryRuns).toHaveLength(1);
    expect(otherRuns).toHaveLength(1);
    expect(otherRuns[0]?.id).not.toBe(primaryRuns[0]?.id);
    expect(results.filter((run) => run?.id === primaryRuns[0]?.id)).toHaveLength(4);
    expect(results.filter((run) => run?.id === otherRuns[0]?.id)).toHaveLength(1);

    const primaryWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, primary.companyId));
    const owner = primaryWakes.filter((row) => row.status === "queued" || row.status === "claimed");
    const coalesced = primaryWakes.filter((row) => row.status === "coalesced");
    expect(owner).toHaveLength(1);
    expect(coalesced).toHaveLength(4);
    expect(owner[0]?.coalescedCount).toBe(4);
    expect(owner[0]?.runId).toBe(primaryRuns[0]?.id);
    expect(coalesced.every((row) => row.runId === primaryRuns[0]?.id)).toBe(true);

    for (const row of primaryWakes) {
      const payload = row.payload ?? {};
      expect(payload.issueId).toBe(primary.issueId);
      expect(readWakeRequestIssueScope(payload)).toBe(primary.issueId);
      expect(payload[WAKE_EQUIVALENCE_PAYLOAD_KEY]).toMatchObject({
        v: 1,
        issueId: primary.issueId,
      });
    }

    const otherWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, other.companyId));
    expect(otherWakes).toHaveLength(1);
    expect(otherWakes[0]?.status === "queued" || otherWakes[0]?.status === "claimed").toBe(true);
    expect(otherWakes[0]?.payload?.issueId).toBe(other.issueId);

    const logged = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, primary.companyId),
      eq(activityLog.action, "wakeup.coalesced"),
    ));
    expect(logged).toHaveLength(4);
    expect(logged.every((row) => !("incomingReason" in (row.details ?? {})))).toBe(true);
  }, 30_000);

  it("admits a new run when the matching wake still looks pending but its run is terminal", async () => {
    const scope = await seedIssue("CAC");
    const payload = { mutation: "monitor_check" };
    const fingerprint = buildWakeEquivalenceFingerprint({
      companyId: scope.companyId,
      agentId: scope.agentId,
      issueId: scope.issueId,
      ownerAgentId: scope.agentId,
      issueStatus: "in_progress",
      issueStatusVersion: 0,
      blockerState: formatBlockerState({
        known: true,
        ready: true,
        unresolvedBlockerIssueIds: [],
        blockedTransitionAt: null,
      }),
      payload,
    });
    const finishedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: finishedRunId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {},
      finishedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: scope.companyId,
      agentId: scope.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      status: "queued",
      runId: finishedRunId,
      coalescedCount: 0,
      payload: stampWakeEquivalencePayload(payload, {
        v: 1,
        fingerprint,
        issueId: scope.issueId,
      }),
      requestedByActorType: "system",
      requestedByActorId: "wake-coalescing-test",
    });

    const run = await heartbeatService(db).wakeup(scope.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      payload,
      contextSnapshot: { issueId: scope.issueId, taskId: scope.issueId },
      requestedByActorType: "system",
      requestedByActorId: "wake-coalescing-test",
    });

    expect(run?.id).toBeTruthy();
    expect(run?.id).not.toBe(finishedRunId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, scope.companyId));
    expect(runs.map((row) => row.id).sort()).toEqual([finishedRunId, run!.id].sort());
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, scope.companyId));
    const stale = wakes.find((row) => row.runId === finishedRunId && row.status === "queued");
    expect(stale?.coalescedCount).toBe(0);
    expect(wakes.some((row) => row.status === "coalesced" && row.runId === finishedRunId)).toBe(false);
    expect(wakes.some((row) => row.runId === run!.id && (row.status === "queued" || row.status === "claimed"))).toBe(true);
  }, 30_000);
});
