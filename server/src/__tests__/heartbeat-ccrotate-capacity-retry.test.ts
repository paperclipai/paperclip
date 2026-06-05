import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS, heartbeatService } from "../services/heartbeat.js";
import type {
  CcrotateGateCheckInput,
  CcrotateGateResult,
  CcrotateTierGate,
} from "../services/ccrotate-tier-gate.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "ok",
        resultJson: {},
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ccrotate capacity retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Deterministic gate that always defers with a fixed resumeAt. */
function denyingGate(resumeAt: Date | null): CcrotateTierGate {
  return {
    async checkAdapter(_input: CcrotateGateCheckInput): Promise<CcrotateGateResult> {
      return { allow: false, target: "claude", reason: "ccrotate.no_usable_account", resumeAt };
    },
    _resetForTesting() {},
  };
}

/** Deterministic gate that always allows (pool recovered). */
function allowingGate(): CcrotateTierGate {
  return {
    async checkAdapter(_input: CcrotateGateCheckInput): Promise<CcrotateGateResult> {
      return { allow: true };
    },
    _resetForTesting() {},
  };
}

describeEmbeddedPostgres("heartbeat ccrotate capacity-defer → scheduled retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ccrotate-capacity-retry-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("schedules a capacity retry instead of dropping the wake when the gate defers", async () => {
    const { agentId } = await seedAgent();
    const resumeAt = new Date("2026-04-20T03:02:00.000Z");
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(resumeAt),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
    });

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun, "a heartbeatRuns row should be created instead of dropping the wake").not.toBeNull();
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(resumeAt.toISOString());
    expect(retryRun?.scheduledRetryReason).toBe("ccrotate_capacity");
    // The rate-limit family + retryNotBefore make the existing bounded-retry
    // backoff honor resumeAt as the floor.
    const resultJson = (retryRun?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.errorFamily).toBe("rate_limit_exhausted");
    expect(resultJson.retryNotBefore).toBe(resumeAt.toISOString());

    // The wake is NOT recorded as a terminal `skipped` drop.
    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")))
      .then((rows) => rows[0] ?? null);
    expect(skipped, "the capacity defer must not terminally drop the wake as skipped").toBeNull();
  });

  it("schedules with a bounded fallback delay when the gate returns no resumeAt", async () => {
    const { agentId } = await seedAgent();
    const before = Date.now();
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(null),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system" });

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.status).toBe("scheduled_retry");
    // A null resumeAt must NOT strand the row with a null scheduledRetryAt —
    // the sweep claims `scheduledRetryAt <= now`, which never matches null.
    expect(retryRun?.scheduledRetryAt, "null resumeAt must fall back to a bounded delay, not null").not.toBeNull();
    expect(retryRun!.scheduledRetryAt!.getTime()).toBeGreaterThan(before);
  });

  it("promotes the scheduled capacity retry when due and capacity has returned", async () => {
    const { agentId } = await seedAgent();
    const resumeAt = new Date("2026-04-20T03:02:00.000Z");
    // Defer with an exhausted gate to create the scheduled_retry row...
    const deferring = heartbeatService(db, {
      ccrotateGate: denyingGate(resumeAt),
      skipQueuedRunDispatch: true,
    });
    await deferring.wakeup(agentId, { source: "assignment", triggerDetail: "system" });

    // Before due: still parked.
    const early = await deferring.promoteDueScheduledRetries(new Date("2026-04-20T03:01:59.000Z"));
    expect(early.promoted).toBe(0);

    // Due + capacity recovered: a fresh instance whose gate now allows promotes it.
    const recovered = heartbeatService(db, {
      ccrotateGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });
    const promotion = await recovered.promoteDueScheduledRetries(resumeAt);
    expect(promotion.promoted).toBe(1);

    const promoted = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(promoted?.status).toBe("queued");
  });

  it("re-defers with backoff instead of promoting when capacity is still exhausted at promotion", async () => {
    const { agentId } = await seedAgent();
    const resumeAt = new Date("2026-04-20T03:02:00.000Z");
    const nextResumeAt = new Date("2026-04-20T03:30:00.000Z");
    // Same instance keeps denying — at promotion the re-gate must re-defer,
    // not dispatch a run that would immediately 429.
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(nextResumeAt),
      skipQueuedRunDispatch: true,
    });

    // Seed the scheduled_retry row directly via a deferring wake.
    const seeding = heartbeatService(db, {
      ccrotateGate: denyingGate(resumeAt),
      skipQueuedRunDispatch: true,
    });
    await seeding.wakeup(agentId, { source: "assignment", triggerDetail: "system" });

    const promotion = await heartbeat.promoteDueScheduledRetries(resumeAt);
    expect(promotion.promoted).toBe(0);

    const row = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(row?.status, "still exhausted → stays parked as scheduled_retry").toBe("scheduled_retry");
    expect(row?.scheduledRetryAttempt, "attempt is bumped on re-defer").toBe(1);
    expect(
      row!.scheduledRetryAt!.getTime(),
      "scheduledRetryAt is pushed to the new resumeAt",
    ).toBe(nextResumeAt.getTime());
  });

  it("stops re-deferring and terminates once the retry cap is reached", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = randomUUID();
    const due = new Date("2026-04-20T03:02:00.000Z");
    // A capacity retry that has already exhausted its attempts budget.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAt: due,
      scheduledRetryAttempt: CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS,
      errorCode: "rate_limit_exhausted",
      resultJson: { errorFamily: "rate_limit_exhausted" },
      contextSnapshot: { wakeSource: "assignment" },
    });

    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(new Date("2026-04-20T09:00:00.000Z")),
      skipQueuedRunDispatch: true,
    });
    const promotion = await heartbeat.promoteDueScheduledRetries(due);
    expect(promotion.promoted).toBe(0);

    const row = await db
      .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(row?.status, "exhausted capacity retry must terminate, not stay scheduled_retry").not.toBe(
      "scheduled_retry",
    );
    expect(row?.finishedAt, "terminated run is finished").not.toBeNull();
  });
});
