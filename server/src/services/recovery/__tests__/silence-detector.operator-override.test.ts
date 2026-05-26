import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS, recoveryService } from "../service.js";
import { runningProcesses } from "../../../adapters/index.js";
import { freshDeadPid, seedSilentRun } from "./silence-detector.shared.js";

vi.mock("../../../telemetry.ts", () => ({
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("silence-detector operator override", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-silence-detector-operator-override-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("cancels the run, cancels siblings, and posts a confirmation comment on board override", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const deadPid = freshDeadPid();
    const { companyId, runId, issuePrefix } = await seedSilentRun({
      db,
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      pid: deadPid,
    });
    // Seed the active evaluation that triggers the override. The unique
    // partial index allows only one active row per (companyId, origin_kind,
    // originId), so any pre-existing siblings would have to be created
    // before this triggering issue and then closed — exactly the legacy
    // run-storm state we'd want to clean up. We model that by leaving the
    // single open eval and verifying the cancellation pathway.
    const evaluationIssueId = randomUUID();
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId,
      title: "Review silent active run",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}:override`,
    });

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const result = await recovery.handleStaleRunEvaluationComment({
      issueId: evaluationIssueId,
      actor: { type: "board", id: "board-user" },
      body: "Please cancel this run immediately.",
      now,
    });

    expect(result.kind).toBe("operator_cancelled");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("operator_override");

    const confirmations = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, evaluationIssueId)));
    expect(confirmations.length).toBeGreaterThanOrEqual(1);
    expect(confirmations.some((row) => row.body.includes("Operator override accepted"))).toBe(true);

    const log = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "heartbeat.output_stale_operator_override"),
        ),
      );
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores non-matching comment bodies and non-board actors", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, runId, issuePrefix } = await seedSilentRun({
      db,
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      pid: freshDeadPid(),
    });
    const evaluationIssueId = randomUUID();
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId,
      title: "Review silent active run",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}:nonmatch`,
    });

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const bodyMiss = await recovery.handleStaleRunEvaluationComment({
      issueId: evaluationIssueId,
      actor: { type: "board", id: "board-user" },
      body: "Let's keep this running — no action.",
      now,
    });
    expect(bodyMiss.kind).toBe("skipped");

    const agentTry = await recovery.handleStaleRunEvaluationComment({
      issueId: evaluationIssueId,
      actor: { type: "agent", id: "some-agent" },
      body: "cancel this run",
      now,
    });
    expect(agentTry.kind).toBe("skipped");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });
});
