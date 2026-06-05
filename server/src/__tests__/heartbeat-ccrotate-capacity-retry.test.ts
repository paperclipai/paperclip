import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

    // Exhaustion files one operator-visible escalation issue for the stuck pool.
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "ccrotate_capacity_exhausted")));
    expect(escalations.length, "exhaustion files exactly one escalation issue").toBe(1);
    expect(escalations[0]?.originId, "escalation is keyed on the ccrotate target").toBe("claude");
    expect(escalations[0]?.priority).toBe("high");
    expect(escalations[0]?.status).toBe("todo");
  });

  it("coalesces escalation to one issue per pool when multiple agents exhaust the same target", async () => {
    const { companyId, agentId: agentA } = await seedAgent();
    const due = new Date("2026-04-20T03:02:00.000Z");
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(new Date("2026-04-20T09:00:00.000Z")),
      skipQueuedRunDispatch: true,
    });

    const insertExhaustedRetry = async (agentId: string) =>
      db.insert(heartbeatRuns).values({
        id: randomUUID(),
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

    // First agent exhausts → first escalation.
    await insertExhaustedRetry(agentA);
    await heartbeat.promoteDueScheduledRetries(due);

    // A second agent in the SAME company exhausts the SAME pool → must coalesce
    // onto the existing open escalation, not spam a duplicate.
    const agentB = randomUUID();
    await db.insert(agents).values({
      id: agentB,
      companyId,
      name: "ClaudeCoderB",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await insertExhaustedRetry(agentB);
    await heartbeat.promoteDueScheduledRetries(due);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "ccrotate_capacity_exhausted")));
    expect(
      escalations.length,
      "both agents exhausting the same pool yield ONE coalesced escalation",
    ).toBe(1);
    expect(escalations[0]?.originId).toBe("claude");
  });

  it("enforces one open escalation per pool at the DB level (partial unique index)", async () => {
    // The sequential coalescing above is only safe because the SELECT sees the
    // prior INSERT; concurrent sweeps could both miss and both insert. The
    // partial unique index is what makes the guarantee real, so assert it
    // directly. PEN-382 (Ally review #307).
    const { companyId } = await seedAgent();
    const base = {
      companyId,
      title: "ccrotate pool exhausted — claude",
      originKind: "ccrotate_capacity_exhausted",
      originId: "claude",
    };

    // First open escalation inserts fine.
    await db.insert(issues).values({ id: randomUUID(), status: "todo", ...base });

    // A second OPEN escalation for the same pool is rejected by the index —
    // this is the concurrent-race case the app-level SELECT can't cover.
    // drizzle wraps the driver error, so unwrap to assert the real pg cause.
    let dupError: unknown;
    try {
      await db.insert(issues).values({ id: randomUUID(), status: "in_progress", ...base });
    } catch (error) {
      dupError = error;
    }
    expect(dupError, "second open duplicate must be rejected by the unique index").toBeDefined();
    const cause = ((dupError as { cause?: unknown })?.cause ?? dupError) as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
    };
    expect(cause.code, "rejection is a unique-violation (23505)").toBe("23505");
    expect(
      cause.constraint ?? cause.constraint_name ?? "",
      "violated index is the ccrotate-exhaustion partial unique index",
    ).toBe("issues_active_ccrotate_capacity_exhaustion_uq");

    // A done duplicate is allowed — the index is partial (excludes done/cancelled),
    // so a fresh outage after recovery can open a new escalation.
    await expect(
      db.insert(issues).values({ id: randomUUID(), status: "done", ...base }),
    ).resolves.toBeDefined();
  });
});
