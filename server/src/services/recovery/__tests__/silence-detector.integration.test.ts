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

describeEmbeddedPostgres("silence-detector full end-to-end", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-silence-detector-integration-");
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

  it("never creates more than one open evaluation across coalesce + backoff + auto-cancel", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const deadPid = freshDeadPid();
    const { companyId, issueId, runId } = await seedSilentRun({
      db,
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      pid: deadPid,
    });
    runningProcesses.delete(runId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    // Critical + dead pid: scan should auto-cancel the run directly.
    const result = await recovery.scanSilentActiveRuns({ now, companyId });
    expect(result.auto_cancelled).toBe(1);
    expect(result.created).toBe(0);
    expect(result.existing).toBe(0);

    const evaluations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stale_active_run_evaluation"),
        ),
      );
    expect(evaluations).toHaveLength(0);

    const [source] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(source?.executionRunId).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");

    // Subsequent scans should find no candidate (run is terminal) and no
    // silence-state row should be left to gate future runs.
    const secondPass = await recovery.scanSilentActiveRuns({ now: new Date(now.getTime() + 60_000), companyId });
    expect(secondPass).toMatchObject({ scanned: 0, created: 0, auto_cancelled: 0 });

    const states = await db
      .select()
      .from(heartbeatRunSilenceState)
      .where(eq(heartbeatRunSilenceState.companyId, companyId));
    // Auto-cancel path does not create a silence-state row because no eval
    // issue ever needs to be coalesced for a cancelled run.
    expect(states).toHaveLength(0);
  });
});
