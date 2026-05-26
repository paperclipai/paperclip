import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createDb,
  heartbeatRunSilenceState,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS, recoveryService } from "../service.js";
import { seedSilentRun } from "./silence-detector.shared.js";

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

describeEmbeddedPostgres("silence-detector exponential backoff", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-silence-detector-backoff-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
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

  it("grows backoff multiplier on repeated false positives and resets on recovery action", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, runId } = await seedSilentRun({
      db,
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    // Drive three full create→close→observe cycles. After each close, a
    // follow-up scan in the closed window observes the close and bumps the
    // backoff multiplier. We advance scanAt past the backoff cap each step so
    // we don't hit backoff_skipped before the close-observation scan runs.
    let scanAt = now;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Create scan: either creates eval#N or falls through after a prior close.
      const created = await recovery.scanSilentActiveRuns({ now: scanAt, companyId });
      expect(created.created + created.existing + created.suppressed).toBeGreaterThanOrEqual(1);

      const [evaluation] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stale_active_run_evaluation"),
            sql`${issues.status} not in ('done', 'cancelled')`,
          ),
        );
      expect(evaluation).toBeTruthy();
      const closedAt = new Date(scanAt.getTime() + 60_000);
      await db
        .update(issues)
        .set({ status: "done", completedAt: closedAt, updatedAt: closedAt })
        .where(eq(issues.id, evaluation!.id));

      // Observation scan: advance past backoff window and trigger the
      // suppressed branch which bumps the multiplier.
      scanAt = new Date(scanAt.getTime() + 8 * 60 * 60 * 1000);
      const observe = await recovery.scanSilentActiveRuns({ now: scanAt, companyId });
      expect(observe.suppressed).toBe(1);

      // Skip past backoff again before the next create scan.
      scanAt = new Date(scanAt.getTime() + 8 * 60 * 60 * 1000);
    }

    const [state] = await db
      .select()
      .from(heartbeatRunSilenceState)
      .where(and(eq(heartbeatRunSilenceState.companyId, companyId), eq(heartbeatRunSilenceState.runId, runId)));
    expect(state).toBeTruthy();
    expect(state!.backoffMultiplier).toBeGreaterThanOrEqual(8);
    expect(state!.consecutiveFalsePositives).toBeGreaterThanOrEqual(3);
    expect(state!.nextEligibleScanAt).toBeTruthy();

    // A snooze recovery action resets the backoff.
    await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "board" },
      decision: "snooze",
      snoozedUntil: new Date(scanAt.getTime() + 60 * 60 * 1000),
      now: new Date(scanAt.getTime() + 60_000),
    });
    const [resetState] = await db
      .select()
      .from(heartbeatRunSilenceState)
      .where(and(eq(heartbeatRunSilenceState.companyId, companyId), eq(heartbeatRunSilenceState.runId, runId)));
    expect(resetState!.backoffMultiplier).toBe(1);
    expect(resetState!.consecutiveFalsePositives).toBe(0);
    expect(resetState!.nextEligibleScanAt).toBeNull();
  });
});
