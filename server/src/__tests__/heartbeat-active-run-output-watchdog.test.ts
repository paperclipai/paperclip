import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
  heartbeatService,
} from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged stale-run evaluation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

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

async function cancelActiveRunsForCleanup(db: ReturnType<typeof createDb>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (activeRuns.length === 0) return;
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by active-run watchdog test cleanup",
      })
      .where(inArray(heartbeatRuns.id, runIds));
    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by active-run watchdog test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-run output watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("active-run output watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-output-watchdog-");
    db = createDb(tempDb.connectionString);
  });

  // scanSilentActiveRuns -> enqueueWakeup -> startNextQueuedRunForAgent
  // fires `void executeRun(...)` background work that the test never awaits
  // (heartbeat.ts ~line 7304). PR #55 added cancelActiveRunsForCleanup +
  // single-confirm waitForHeartbeatIdle, but verify_canary run 26014448824
  // still deadlocked on TRUNCATE for 3 tests — the postRun lifecycle hook
  // (heartbeat.ts:6568) continues writes after status update because it
  // doesn't observe the cancellation flag. Mirrors the proven pattern in
  // heartbeat-stale-queue-invalidation.test.ts: reset the mock so any
  // in-flight resolution returns the inert default, clear runningProcesses
  // defensively, cancel active runs, then triple-confirm idle (3×50ms
  // consecutive idle reads) + 50ms settle before TRUNCATE.
  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Acknowledged stale-run evaluation.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun(opts: { now: Date; ageMs: number; withOutput?: boolean; logChunk?: string }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const lastOutputAt = opts.withOutput ? new Date(opts.now.getTime() - 5 * 60 * 1000) : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long running implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt,
      lastOutputSeq: opts.withOutput ? 3 : 0,
      lastOutputStream: opts.withOutput ? "stdout" : null,
      contextSnapshot: { issueId },
      stdoutExcerpt: "OPENAI_API_KEY=sk-test-secret-value should not leak",
      logBytes: 0,
    });
    if (opts.logChunk) {
      const store = getRunLogStore();
      const handle = await store.begin({ companyId, agentId: coderId, runId });
      const logBytes = await store.append(handle, {
        stream: "stdout",
        chunk: opts.logChunk,
        ts: startedAt.toISOString(),
      });
      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          logBytes,
        })
        .where(eq(heartbeatRuns.id, runId));
    }
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, managerId, coderId, issueId, runId, issuePrefix };
  }

  it("creates one medium-priority evaluation issue for a suspicious silent run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const first = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const second = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(1);
    expect(["todo", "in_progress"]).toContain(evaluations[0]?.status);
    expect(evaluations[0]).toMatchObject({
      priority: "medium",
      assigneeAgentId: managerId,
      originId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
    });
    expect(evaluations[0]?.description).toContain("Decision Checklist");
    expect(evaluations[0]?.description).not.toContain("sk-test-secret-value");
  });

  it("redacts sensitive values from actual run-log evidence", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const leakedJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const leakedGithubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const { companyId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      logChunk: [
        "Authorization: Bearer live-bearer-token-value",
        `POST payload {"apiKey":"json-secret-value","token":"${leakedJwt}"}`,
        `GITHUB_TOKEN=${leakedGithubToken}`,
      ].join("\n"),
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    await heartbeat.scanSilentActiveRuns({ now, companyId });

    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.description).toContain("***REDACTED***");
    expect(evaluation?.description).not.toContain("live-bearer-token-value");
    expect(evaluation?.description).not.toContain("json-secret-value");
    expect(evaluation?.description).not.toContain(leakedJwt);
    expect(evaluation?.description).not.toContain(leakedGithubToken);
  });

  it("raises critical stale-run evaluations and blocks the source issue", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, issueId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.priority).toBe("high");

    const [blocker] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, issueId)));
    expect(blocker?.issueId).toBe(evaluation?.id);

    const [source] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(source?.status).toBe("blocked");
  });

  it("does not file a review when the source issue is already blocked", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, issueId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result).toMatchObject({ created: 0, escalated: 0, existing: 0, skipped: 1 });

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(0);
  });

  it("skips snoozed runs and healthy noisy runs", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const stale = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const noisy = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      withOutput: true,
    });
    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId: stale.companyId,
      runId: stale.runId,
      decision: "snooze",
      snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      reason: "Intentional quiet run",
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const staleResult = await heartbeat.scanSilentActiveRuns({ now, companyId: stale.companyId });
    const noisyResult = await heartbeat.scanSilentActiveRuns({ now, companyId: noisy.companyId });

    expect(staleResult).toMatchObject({ created: 0, snoozed: 1 });
    expect(noisyResult).toMatchObject({ scanned: 0, created: 0 });
  });

  it("records watchdog decisions through recovery owner authorization", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: randomUUID() },
        decision: "continue",
        evaluationIssueId,
        reason: "not my recovery issue",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "snooze",
      evaluationIssueId,
      reason: "Long compile with no output",
      snoozedUntil,
    });

    expect(decision).toMatchObject({
      runId,
      evaluationIssueId,
      decision: "snooze",
      createdByAgentId: managerId,
    });
    await expect(recovery.buildRunOutputSilence({
      id: runId,
      companyId,
      status: "running",
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      createdAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
    }, now)).resolves.toMatchObject({
      level: "snoozed",
      snoozedUntil,
      evaluationIssueId,
    });
  });

  it("re-arms continue decisions after the default quiet window", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "continue",
      evaluationIssueId,
      reason: "Current evidence is acceptable; keep watching.",
      now,
    });
    const rearmAt = new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);
    expect(decision).toMatchObject({
      runId,
      evaluationIssueId,
      decision: "continue",
      createdByAgentId: managerId,
    });
    expect(decision.snoozedUntil?.toISOString()).toBe(rearmAt.toISOString());

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));

    const beforeRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() - 60_000),
      companyId,
    });
    expect(beforeRearm).toMatchObject({ created: 0, snoozed: 1 });

    const afterRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() + 60_000),
      companyId,
    });
    expect(afterRearm.created).toBe(1);
    expect(afterRearm.evaluationIssueIds[0]).not.toBe(evaluationIssueId);

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations.filter((issue) => !["done", "cancelled"].includes(issue.status))).toHaveLength(1);
  });

  it("rejects agent watchdog decisions using issues not bound to the target run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, coderId, runId, issuePrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId,
      title: "Assigned but unrelated",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 20,
      identifier: `${issuePrefix}-20`,
    });

    const otherRunId = randomUUID();
    const otherEvaluationIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {},
      logBytes: 0,
    });
    await db.insert(issues).values({
      id: otherEvaluationIssueId,
      companyId,
      title: "Other run evaluation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 21,
      identifier: `${issuePrefix}-21`,
      originKind: "stale_active_run_evaluation",
      originId: otherRunId,
      originFingerprint: `stale_active_run:${companyId}:${otherRunId}`,
    });

    const attempts = [
      { decision: "continue" as const, evaluationIssueId: unrelatedIssueId },
      { decision: "dismissed_false_positive" as const, evaluationIssueId: unrelatedIssueId },
      {
        decision: "snooze" as const,
        evaluationIssueId: unrelatedIssueId,
        snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      },
      { decision: "continue" as const, evaluationIssueId: otherEvaluationIssueId },
    ];

    for (const attempt of attempts) {
      await expect(
        recovery.recordWatchdogDecision({
          runId,
          actor: { type: "agent", agentId: managerId },
          reason: "malicious or stale binding",
          ...attempt,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));
    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "closed evaluation should not authorize",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates createdByRunId before storing watchdog decisions", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "client supplied another agent run",
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: managerRunId,
      companyId,
      agentId: managerId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: now,
      processStartedAt: now,
      lastOutputAt: now,
      lastOutputSeq: 1,
      lastOutputStream: "stdout",
      contextSnapshot: {},
      logBytes: 0,
    });

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId, runId: managerRunId },
      decision: "continue",
      evaluationIssueId,
      reason: "valid current actor run",
      createdByRunId: randomUUID(),
    });
    expect(decision.createdByRunId).toBe(managerRunId);
  });
});
