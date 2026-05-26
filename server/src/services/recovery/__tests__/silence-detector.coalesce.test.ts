import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createDb,
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

describeEmbeddedPostgres("silence-detector coalesce window", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-silence-detector-coalesce-");
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

  it("creates exactly one evaluation issue across two consecutive scans", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, runId } = await seedSilentRun({
      db,
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const first = await recovery.scanSilentActiveRuns({ now, companyId });
    const second = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.originId).toBe(runId);
  });
});
