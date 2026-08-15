import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
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
    `Skipping embedded Postgres pending_cleanup sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The sweep reads and writes its retry state under these lease metadata keys.
const ATTEMPTS_KEY = "pendingCleanupRetryAttempts";
const CAP_WARNED_KEY = "pendingCleanupRetryCapWarned";
const ATTEMPT_CAP = 5;

describeEmbeddedPostgres("heartbeat sweepPendingCleanupLeases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-cleanup-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndEnvironment() {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Fake Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, environmentId };
  }

  async function insertPendingCleanupLease(input: {
    companyId: string;
    environmentId: string;
    updatedAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      status: "pending_cleanup",
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: `sandbox://fake/${id}`,
      cleanupStatus: "failed",
      metadata: { driver: "sandbox", ...(input.metadata ?? {}) },
      acquiredAt: input.updatedAt,
      lastUsedAt: input.updatedAt,
      releasedAt: input.updatedAt,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  function fakeRuntime(
    destroyRunLease: HeartbeatEnvironmentRuntime["destroyRunLease"],
  ): HeartbeatEnvironmentRuntime {
    return { destroyRunLease } as unknown as HeartbeatEnvironmentRuntime;
  }

  it("test_pending_cleanup_sweep_retries_and_destroys_lease", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy succeeds on retry and moves the lease out of pending_cleanup.
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      const now = new Date();
      const row = await db
        .update(environmentLeases)
        .set({ status: "expired", cleanupStatus: "success", updatedAt: now })
        .where(eq(environmentLeases.id, lease.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? { ...row, status: "expired" as const } : null;
    });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"]),
    });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    expect(destroyRunLease.mock.calls[0]?.[0]).toMatchObject({
      failureReason: "pending_cleanup_retry",
      lease: expect.objectContaining({ id: leaseId }),
    });

    const status = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]?.status);
    expect(status).toBe("expired");
  });

  it("test_pending_cleanup_sweep_respects_backoff_and_page_size", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // A lease touched inside the backoff window is not eligible yet.
    await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(),
    });

    const destroyRunLease = vi.fn(async () => null);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"]),
    });

    const backoffResult = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 5 * 60 * 1000 });
    expect(backoffResult.swept).toBe(0);
    expect(destroyRunLease).not.toHaveBeenCalled();

    // Seed more eligible leases than one page holds. The sweep processes one
    // page only.
    const eligibleCount = 22;
    for (let index = 0; index < eligibleCount; index += 1) {
      await insertPendingCleanupLease({
        companyId,
        environmentId,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
    }

    const pageResult = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 5 * 60 * 1000 });
    expect(pageResult.swept).toBe(20);
    expect(destroyRunLease).toHaveBeenCalledTimes(20);
  });

  it("test_pending_cleanup_sweep_stops_at_attempt_cap_and_warns_once", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: ATTEMPT_CAP },
    });

    const destroyRunLease = vi.fn(async () => null);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"]),
    });

    const first = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(first).toEqual({ swept: 1, destroyed: 0, capped: 1 });
    // A capped lease is not retried.
    expect(destroyRunLease).not.toHaveBeenCalled();

    const metadataAfterFirst = await db
      .select({ metadata: environmentLeases.metadata })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]?.metadata as Record<string, unknown> | null);
    expect(metadataAfterFirst?.[CAP_WARNED_KEY]).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);

    // A second sweep warns no more; the lease keeps its warned flag.
    const second = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(second).toEqual({ swept: 1, destroyed: 0, capped: 1 });
    expect(destroyRunLease).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  // Two sweep ticks can overlap. Without an atomic claim, both read the same
  // attempt count, both destroy the same lease, and the retry cap counts one
  // attempt for two destroys. The atomic claim must let only one sweep destroy
  // the lease per attempt.
  it("test_pending_cleanup_overlapping_sweeps_destroy_lease_once", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy fails, so the lease stays in pending_cleanup. The counter
    // records how many sweeps reached the destroy for this lease.
    let destroyCount = 0;
    const destroyRunLease = vi.fn(async () => {
      destroyCount += 1;
      return null;
    });

    // Two sweeps run on two separate database clients, so they truly overlap.
    // A single client serializes the queries on one connection and hides the
    // race. The second client connects to the same embedded database.
    const dbB = createDb(tempDb!.connectionString);
    try {
      // Warm up the second connection first. A cold connection would add setup
      // latency and let the first sweep finish before the second sweep reads.
      await dbB.select({ id: environmentLeases.id }).from(environmentLeases).limit(1);

      const heartbeatA = heartbeatService(db, {
        environmentRuntime: fakeRuntime(
          destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
        ),
      });
      const heartbeatB = heartbeatService(dbB, {
        environmentRuntime: fakeRuntime(
          destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
        ),
      });

      // Both sweeps use the production backoff and run at the same time.
      const backoffMs = 5 * 60 * 1000;
      const [first, second] = await Promise.all([
        heartbeatA.sweepPendingCleanupLeases({ backoffMs }),
        heartbeatB.sweepPendingCleanupLeases({ backoffMs }),
      ]);

      // Only one sweep claimed the attempt and destroyed the lease.
      expect(destroyCount).toBe(1);
      expect(first.destroyed + second.destroyed).toBe(0);
    } finally {
      await (dbB as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }

    // The attempt count advanced by exactly one; the cap is not exceeded.
    const metadata = await db
      .select({ metadata: environmentLeases.metadata, status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect((metadata?.metadata as Record<string, unknown> | null)?.[ATTEMPTS_KEY]).toBe(1);
    expect(metadata?.status).toBe("pending_cleanup");
  });

  // Read the current retry attempt count from a lease's metadata.
  async function readAttempts(leaseId: string): Promise<number> {
    const metadata = await db
      .select({ metadata: environmentLeases.metadata })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]?.metadata as Record<string, unknown> | null);
    const value = metadata?.[ATTEMPTS_KEY];
    return typeof value === "number" ? value : 0;
  }

  // Run two sweeps at the same time on two separate database clients, so they
  // truly overlap. A single client serializes the queries on one connection and
  // hides the race. The second client connects to the same embedded database.
  // The caller reuses the returned destroy spy to count the real destroys.
  async function runOverlappingSweeps(
    destroyRunLease: HeartbeatEnvironmentRuntime["destroyRunLease"],
    backoffMs: number,
  ): Promise<void> {
    const dbB = createDb(tempDb!.connectionString);
    try {
      // Warm up the second connection first. A cold connection would add setup
      // latency and let the first sweep finish before the second sweep reads.
      await dbB.select({ id: environmentLeases.id }).from(environmentLeases).limit(1);

      const heartbeatA = heartbeatService(db, {
        environmentRuntime: fakeRuntime(destroyRunLease),
      });
      const heartbeatB = heartbeatService(dbB, {
        environmentRuntime: fakeRuntime(destroyRunLease),
      });

      await Promise.all([
        heartbeatA.sweepPendingCleanupLeases({ backoffMs }),
        heartbeatB.sweepPendingCleanupLeases({ backoffMs }),
      ]);
    } finally {
      await (dbB as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  }

  // Two overlapping sweeps read the same pending_cleanup lease. The atomic claim
  // must let only one sweep destroy the sandbox. This test runs the two sweeps
  // on two clients, then asserts a single destroy and a single attempt
  // increment.
  it("test_concurrent_sweeps_destroy_a_lease_at_most_once", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy fails, so the lease stays in pending_cleanup and the test can
    // read the final attempt count.
    const destroyRunLease = vi.fn(async () => null);

    await runOverlappingSweeps(
      destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
      5 * 60 * 1000,
    );

    // Only one sweep wins the claim, so the destroy runs once and the attempt
    // count advances by one.
    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    expect(await readAttempts(leaseId)).toBe(1);
  });

  // A lost increment lets the real attempt count pass the cap: two destroys run
  // but the counter advances by one. The atomic claim prevents the lost
  // increment. This test starts a lease at cap - 1, overlaps two sweeps, then
  // asserts one destroy, one increment to the cap, and at most one cap warning.
  it("test_concurrent_sweeps_never_exceed_attempt_cap", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: ATTEMPT_CAP - 1 },
    });

    // The destroy fails, so the lease stays in pending_cleanup and the test can
    // read the final attempt count.
    const destroyRunLease = vi.fn(async () => null);

    await runOverlappingSweeps(
      destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
      5 * 60 * 1000,
    );

    // One real retry ran, so the count advances by one to the cap and never
    // passes it.
    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    const attempts = await readAttempts(leaseId);
    expect(attempts).toBe(ATTEMPT_CAP);
    expect(attempts).toBeLessThanOrEqual(ATTEMPT_CAP);

    // The cap warning logs at most once across the overlap.
    const capWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(
        (call) =>
          call[1] === "environment lease reached the pending_cleanup retry cap; left for manual cleanup",
      );
    expect(capWarnings.length).toBeLessThanOrEqual(1);
  });

  // A provider or plugin destroy rejection can carry a bearer credential in its
  // message. The per-lease retry log must never serialize that raw error.
  it("test_pending_cleanup_retry_log_omits_error_secrets", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy rejects with a credential-shaped sentinel in the message.
    const sentinel = "Bearer sk-SENTINEL-a1b2c3";
    const rejection = new Error(`provider destroy failed: ${sentinel}`);
    rejection.name = "ProviderDestroyError";
    (rejection as { code?: string }).code = "EPROVIDER";
    const destroyRunLease = vi.fn(async () => {
      throw rejection;
    });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result).toEqual({ swept: 1, destroyed: 0, capped: 0 });
    expect(destroyRunLease).toHaveBeenCalledTimes(1);

    const retryCall = vi
      .mocked(logger.warn)
      .mock.calls.find((call) => call[1] === "pending_cleanup lease retry failed");
    expect(retryCall).toBeDefined();
    const record = retryCall?.[0] as Record<string, unknown>;

    // The record omits the raw error. It never contains the sentinel.
    expect(JSON.stringify(record)).not.toContain(sentinel);
    expect(record).not.toHaveProperty("err");
    expect(record).not.toHaveProperty("message");
    expect(record).not.toHaveProperty("stack");
    expect(record).not.toHaveProperty("cause");

    // The record still carries the stable, non-sensitive fields.
    expect(record).toMatchObject({
      leaseId,
      environmentId,
      attempts: 1,
      errorName: "ProviderDestroyError",
      errorCode: "EPROVIDER",
    });
  });

  // The outer sweep catch logs a failure of the sweep itself. It must log only
  // the allowlisted error identity, never the raw error.
  it("test_pending_cleanup_sweep_failure_log_omits_error_secrets", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Make the sweep itself throw. The lease query rejects with a
    // credential-shaped sentinel in the message. The reaper's own queries pass
    // through, so only the sweep fails.
    const sentinel = "Bearer sk-SENTINEL-d4e5f6";
    const realSelect = db.select.bind(db);
    const selectSpy = vi
      .spyOn(db, "select")
      .mockImplementation((...args: Parameters<typeof db.select>) => {
        const builder = realSelect(...args);
        const realFrom = builder.from.bind(builder);
        (builder as { from: unknown }).from = (table: unknown) => {
          if (table === environmentLeases) {
            const failure = new Error(`sweep query failed: ${sentinel}`);
            failure.name = "SweepQueryError";
            throw failure;
          }
          return realFrom(table as Parameters<typeof realFrom>[0]);
        };
        return builder;
      });

    try {
      const destroyRunLease = vi.fn(async () => null);
      const heartbeat = heartbeatService(db, {
        environmentRuntime: fakeRuntime(
          destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
        ),
      });

      // The reaper isolates the sweep, so the reaper itself resolves.
      await expect(heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).resolves.toBeDefined();

      const sweepCall = vi
        .mocked(logger.error)
        .mock.calls.find((call) => call[1] === "pending_cleanup lease sweep failed");
      expect(sweepCall).toBeDefined();
      const record = sweepCall?.[0] as Record<string, unknown>;

      expect(JSON.stringify(record)).not.toContain(sentinel);
      expect(record).not.toHaveProperty("err");
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("stack");
      expect(record).toMatchObject({ errorName: "SweepQueryError" });
    } finally {
      selectSpy.mockRestore();
    }
  });
});
