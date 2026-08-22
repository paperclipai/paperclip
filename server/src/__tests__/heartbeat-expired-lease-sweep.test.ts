import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { logger } from "../middleware/logger.ts";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres expired lease sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The sweep releases at most this many expired leases per tick.
const SWEEP_PAGE_SIZE = 20;
const HOUR_MS = 60 * 60 * 1000;

describeEmbeddedPostgres("heartbeat sweepExpiredRunLeases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-expired-lease-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    // The shared `local` environment is intentionally left in place: the schema
    // bootstrap owns it, and a partial unique index allows only one.
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndEnvironment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // A partial unique index allows exactly one `local` environment per
    // instance, and the schema bootstrap already creates it. Reuse that row
    // instead of inserting a second one.
    const existingLocal = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
    if (!existingLocal) {
      await db.insert(environments).values({
        id: environmentId,
        name: "Local",
        driver: "local",
        status: "active",
        config: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return { companyId, agentId, environmentId: existingLocal ?? environmentId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      trigger: "timer",
      createdAt: new Date(Date.now() - 6 * HOUR_MS),
      updatedAt: new Date(Date.now() - 6 * HOUR_MS),
    } as never);
    return id;
  }

  async function insertActiveLease(input: {
    companyId: string;
    environmentId: string;
    heartbeatRunId: string | null;
    expiresAt: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    const acquiredAt = new Date(Date.now() - 6 * HOUR_MS);
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      heartbeatRunId: input.heartbeatRunId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      expiresAt: input.expiresAt,
      metadata: { driver: "local" },
      acquiredAt,
      lastUsedAt: acquiredAt,
      createdAt: acquiredAt,
      updatedAt: acquiredAt,
    });
    return id;
  }

  /**
   * A runtime whose `releaseRunLeases` behaves like the real one: it flips every
   * active lease for the run and records the caller's reason. The test asserts
   * on the persisted row, so the fake must actually write.
   */
  function fakeRuntime(): {
    runtime: HeartbeatEnvironmentRuntime;
    releaseRunLeases: ReturnType<typeof vi.fn>;
  } {
    const releaseRunLeases = vi.fn(
      async (
        heartbeatRunId: string,
        status: string,
        _onError: unknown,
        failureReason?: string,
      ) => {
        const rows = await db
          .update(environmentLeases)
          .set({
            status,
            releasedAt: new Date(),
            updatedAt: new Date(),
            cleanupStatus: "success",
            ...(failureReason ? { failureReason } : {}),
          })
          .where(eq(environmentLeases.heartbeatRunId, heartbeatRunId))
          .returning();
        return rows.map((lease) => ({ lease }));
      },
    );
    return {
      runtime: { releaseRunLeases } as unknown as HeartbeatEnvironmentRuntime,
      releaseRunLeases,
    };
  }

  it("test_expired_lease_sweep_releases_lease_of_terminal_run", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAndEnvironment();
    const runId = await insertRun({ companyId, agentId, status: "succeeded" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepExpiredRunLeases();

    expect(result).toEqual({ swept: 1, released: 1, deferred: 0, skippedWithoutRun: 0 });
    expect(releaseRunLeases).toHaveBeenCalledTimes(1);
    expect(releaseRunLeases.mock.calls[0]?.[0]).toBe(runId);
    expect(releaseRunLeases.mock.calls[0]?.[1]).toBe("expired");

    // The row must say why it left `active`. A swept lease that reads like an
    // ordinary release is indistinguishable from one the run closed itself,
    // which is the diagnostic gap this whole change exists to close.
    const row = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("expired");
    expect(row?.failureReason).toContain("lease_expired");
  });

  // The load-bearing guard. Expiry alone must never release a lease: a run that
  // legitimately outlives its TTL still owns its environment, and tearing it out
  // mid-run is a worse failure than the leak this sweep repairs.
  it("test_expired_lease_sweep_leaves_lease_of_live_run_untouched", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAndEnvironment();
    const runningId = await insertRun({ companyId, agentId, status: "running" });
    const queuedId = await insertRun({ companyId, agentId, status: "queued" });
    const runningLease = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runningId,
      expiresAt: new Date(Date.now() - 24 * HOUR_MS),
    });
    const queuedLease = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: queuedId,
      expiresAt: new Date(Date.now() - 24 * HOUR_MS),
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepExpiredRunLeases();

    expect(result).toEqual({ swept: 0, released: 0, deferred: 0, skippedWithoutRun: 0 });
    expect(releaseRunLeases).not.toHaveBeenCalled();

    for (const leaseId of [runningLease, queuedLease]) {
      const status = await db
        .select({ status: environmentLeases.status })
        .from(environmentLeases)
        .where(eq(environmentLeases.id, leaseId))
        .then((rows) => rows[0]?.status);
      expect(status).toBe("active");
    }
  });

  it("test_expired_lease_sweep_ignores_unexpired_and_null_expiry_leases", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAndEnvironment();
    const runId = await insertRun({ companyId, agentId, status: "failed" });
    // Still inside its TTL.
    const future = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    // A legacy row from before the acquire side stamped an expiry. The sweep
    // must not treat "no recorded expiry" as "expired" -- that predicate would
    // have released every one of the 6,000 historical rows at once.
    const legacy = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      expiresAt: null,
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepExpiredRunLeases();

    expect(result).toEqual({ swept: 0, released: 0, deferred: 0, skippedWithoutRun: 0 });
    expect(releaseRunLeases).not.toHaveBeenCalled();
    for (const leaseId of [future, legacy]) {
      const status = await db
        .select({ status: environmentLeases.status })
        .from(environmentLeases)
        .where(eq(environmentLeases.id, leaseId))
        .then((rows) => rows[0]?.status);
      expect(status).toBe("active");
    }
  });

  // A lease whose run row was deleted has a null heartbeat_run_id, so
  // releaseRunLeases cannot reach it. The sweep counts and logs those rather
  // than dropping them silently: a silent omission reads as full coverage.
  it("test_expired_lease_sweep_reports_leases_with_no_run", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepExpiredRunLeases();

    expect(result).toEqual({ swept: 0, released: 0, deferred: 0, skippedWithoutRun: 1 });
    expect(releaseRunLeases).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { count: 1 },
      "expired leases with no heartbeat run are not swept by this path",
    );
  });

  // Head-of-line blocking. A lease whose release keeps failing keeps its
  // `expires_at`, so an oldest-expired-first page would hand the sweep the
  // identical failing rows on every tick and nothing behind them would ever be
  // reached. The deferral touch is what rotates them out of the way.
  it("test_expired_lease_sweep_makes_progress_past_a_full_page_of_failures", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAndEnvironment();

    // A full page of leases whose release always fails, all expired long ago so
    // they sort ahead of the victim below on any expiry-ordered scan.
    const stuckRuns = new Set<string>();
    for (let index = 0; index < SWEEP_PAGE_SIZE; index += 1) {
      const runId = await insertRun({ companyId, agentId, status: "failed" });
      stuckRuns.add(runId);
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: runId,
        expiresAt: new Date(Date.now() - 48 * HOUR_MS),
      });
    }

    // The lease that must not be starved: expired, but more recently.
    const victimRun = await insertRun({ companyId, agentId, status: "succeeded" });
    const victimLease = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: victimRun,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const failing = vi.fn(async (heartbeatRunId: string, ...rest: unknown[]) => {
      if (stuckRuns.has(heartbeatRunId)) throw new Error("driver teardown refused");
      return await (releaseRunLeases as unknown as (...args: unknown[]) => Promise<unknown>)(
        heartbeatRunId,
        ...rest,
      );
    });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: { releaseRunLeases: failing } as unknown as HeartbeatEnvironmentRuntime,
    });

    // Tick one: the failing page fills the sweep, so the victim is not reached.
    const first = await heartbeat.sweepExpiredRunLeases();
    expect(first.swept).toBe(SWEEP_PAGE_SIZE);
    expect(first.released).toBe(0);
    expect(first.deferred).toBe(SWEEP_PAGE_SIZE);
    expect(
      await db
        .select({ status: environmentLeases.status })
        .from(environmentLeases)
        .where(eq(environmentLeases.id, victimLease))
        .then((rows) => rows[0]?.status),
    ).toBe("active");

    // Tick two: the deferred failures now sort last, so the victim is reached
    // and released. Without the deferral this is the same page as tick one.
    const second = await heartbeat.sweepExpiredRunLeases();
    expect(second.released).toBe(1);
    expect(
      await db
        .select({ status: environmentLeases.status })
        .from(environmentLeases)
        .where(eq(environmentLeases.id, victimLease))
        .then((rows) => rows[0]?.status),
    ).toBe("expired");
  });

  it("test_expired_lease_sweep_batches_one_release_per_run_and_honours_page_size", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAndEnvironment();

    // Two expired leases on one run must produce one release call, not two:
    // releaseRunLeases is keyed by run and closes both.
    const sharedRun = await insertRun({ companyId, agentId, status: "cancelled" });
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: sharedRun,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: sharedRun,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    const { runtime, releaseRunLeases } = fakeRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const batched = await heartbeat.sweepExpiredRunLeases();
    expect(batched.swept).toBe(2);
    expect(releaseRunLeases).toHaveBeenCalledTimes(1);
    expect(batched.released).toBe(2);

    // Now seed more eligible leases than one page holds, each on its own run.
    releaseRunLeases.mockClear();
    for (let index = 0; index < SWEEP_PAGE_SIZE + 2; index += 1) {
      const runId = await insertRun({ companyId, agentId, status: "timed_out" });
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: runId,
        expiresAt: new Date(Date.now() - HOUR_MS),
      });
    }

    const paged = await heartbeat.sweepExpiredRunLeases();
    expect(paged.swept).toBe(SWEEP_PAGE_SIZE);
    expect(releaseRunLeases).toHaveBeenCalledTimes(SWEEP_PAGE_SIZE);
  });
});
