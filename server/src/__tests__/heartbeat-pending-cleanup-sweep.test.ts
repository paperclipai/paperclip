import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
// The sweep reads at most this many oldest pending_cleanup rows per tick.
const SWEEP_PAGE_SIZE = 20;

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
    environmentId: string | null;
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

  // An orphan ephemeral lease that a failed acquire records. The sweep tears it
  // down through retryPendingSandboxTeardown, not through destroyRunLease.
  async function insertOrphanEphemeralLease(input: {
    companyId: string;
    environmentId: string | null;
    updatedAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      status: "pending_cleanup",
      leasePolicy: "ephemeral",
      provider: "fake",
      providerLeaseId: `sandbox://fake/${id}`,
      cleanupStatus: "failed",
      metadata: { driver: "sandbox", provider: "fake", ...(input.metadata ?? {}) },
      acquiredAt: input.updatedAt,
      lastUsedAt: input.updatedAt,
      releasedAt: input.updatedAt,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    return id;
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

  // Two unified sweeps can overlap on one orphan ephemeral lease. The master
  // sweep is the single owner of the pending_cleanup rows. Its atomic per-attempt
  // claim must let only one sweep tear the sandbox down, and the winning sweep
  // must leave the lease in a final successful state.
  it("test_concurrent_unified_sweeps_tear_an_orphan_down_once", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertOrphanEphemeralLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The orphan teardown succeeds and does not release the lease; the sweep
    // releases it. The counter records how many sweeps reached the teardown.
    let teardownCount = 0;
    const retryPendingSandboxTeardown = vi.fn(async () => {
      teardownCount += 1;
    });
    const runtime = { retryPendingSandboxTeardown } as unknown as HeartbeatEnvironmentRuntime;

    // Two sweeps run on two separate database clients, so they truly overlap.
    // A single client serializes the queries on one connection and hides the
    // race. The second client connects to the same embedded database.
    const dbB = createDb(tempDb!.connectionString);
    try {
      // Warm up the second connection first, so the two sweeps start together.
      await dbB.select({ id: environmentLeases.id }).from(environmentLeases).limit(1);

      const heartbeatA = heartbeatService(db, { environmentRuntime: runtime });
      const heartbeatB = heartbeatService(dbB, { environmentRuntime: runtime });

      const backoffMs = 5 * 60 * 1000;
      const [first, second] = await Promise.all([
        heartbeatA.sweepPendingCleanupLeases({ backoffMs }),
        heartbeatB.sweepPendingCleanupLeases({ backoffMs }),
      ]);

      // Only one sweep claimed the attempt and tore the sandbox down.
      expect(teardownCount).toBe(1);
      expect(first.destroyed + second.destroyed).toBe(1);
    } finally {
      await (dbB as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }

    // The winning sweep left the lease in a final successful state and advanced
    // the attempt count by exactly one.
    const finalRow = await db
      .select({
        status: environmentLeases.status,
        cleanupStatus: environmentLeases.cleanupStatus,
        metadata: environmentLeases.metadata,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe("expired");
    expect(finalRow?.cleanupStatus).toBe("success");
    expect((finalRow?.metadata as Record<string, unknown> | null)?.[ATTEMPTS_KEY]).toBe(1);
  });

  it("test_pending_cleanup_sweep_tears_down_reusable_lease_after_environment_delete", async () => {
    const { companyId } = await seedCompanyAndEnvironment();
    // A reuse_by_environment lease whose environment a delete removed. The
    // schema sets the environment reference to null and preserves the
    // pending_cleanup row, so the lease still points at a live provider sandbox.
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId: null,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The environment row is gone, so the sweep must tear the sandbox down from
    // the recorded lease data through retryPendingSandboxTeardown. It must not
    // call destroyRunLease, which needs the environment. The teardown succeeds
    // and does not release the lease; the sweep releases it.
    const retryPendingSandboxTeardown = vi.fn(async (input: { environment: unknown }) => {
      expect(input.environment).toBeNull();
    });
    const destroyRunLease = vi.fn(async () => null);
    const runtime = { retryPendingSandboxTeardown, destroyRunLease } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);
    expect(retryPendingSandboxTeardown.mock.calls[0]?.[0]).toMatchObject({
      lease: expect.objectContaining({ id: leaseId }),
    });
    expect(destroyRunLease).not.toHaveBeenCalled();

    const finalRow = await db
      .select({ status: environmentLeases.status, cleanupStatus: environmentLeases.cleanupStatus })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe("expired");
    expect(finalRow?.cleanupStatus).toBe("success");
  });

  it("test_pending_cleanup_sweep_keeps_reusable_lease_when_recorded_teardown_fails", async () => {
    const { companyId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId: null,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The recorded-data teardown throws, so the sweep reverts the lease to
    // pending_cleanup for a later retry. The claimed attempt still counts
    // against the cap, so the retries stay bounded.
    const retryPendingSandboxTeardown = vi.fn(async () => {
      throw new Error("provider teardown failed");
    });
    const destroyRunLease = vi.fn(async () => null);
    const runtime = { retryPendingSandboxTeardown, destroyRunLease } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 1, destroyed: 0, capped: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);
    expect(destroyRunLease).not.toHaveBeenCalled();

    const finalRow = await db
      .select({
        status: environmentLeases.status,
        cleanupStatus: environmentLeases.cleanupStatus,
        metadata: environmentLeases.metadata,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe("pending_cleanup");
    expect(finalRow?.cleanupStatus).toBe("failed");
    expect((finalRow?.metadata as Record<string, unknown> | null)?.[ATTEMPTS_KEY]).toBe(1);
  });

  it("test_pending_cleanup_sweep_skips_lease_while_plugin_worker_down_then_retries", async () => {
    const { companyId } = await seedCompanyAndEnvironment();
    // An orphan ephemeral lease that a failed plugin acquire recorded. The sweep
    // tears it down through retryPendingSandboxTeardown.
    const leaseId = await insertOrphanEphemeralLease({
      companyId,
      environmentId: null,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The plugin worker is down at first, then recovers on the second sweep.
    let workerReady = false;
    const isPendingCleanupWorkerReady = vi.fn(async () => workerReady);
    const retryPendingSandboxTeardown = vi.fn(async () => {});
    const destroyRunLease = vi.fn(async () => null);
    const runtime = {
      isPendingCleanupWorkerReady,
      retryPendingSandboxTeardown,
      destroyRunLease,
    } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    // First sweep: the worker is down, so the sweep skips the lease. It never
    // claims an attempt and never runs the teardown.
    const first = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(first).toEqual({ swept: 1, destroyed: 0, capped: 0 });
    expect(isPendingCleanupWorkerReady).toHaveBeenCalledTimes(1);
    expect(retryPendingSandboxTeardown).not.toHaveBeenCalled();
    // The skipped lease consumed no finite attempt.
    expect(await readAttempts(leaseId)).toBe(0);
    const afterSkip = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]?.status);
    expect(afterSkip).toBe("pending_cleanup");

    // Second sweep: the worker recovered, so the sweep claims an attempt and
    // tears the sandbox down.
    workerReady = true;
    const second = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(second).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);

    const finalRow = await db
      .select({ status: environmentLeases.status, cleanupStatus: environmentLeases.cleanupStatus })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe("expired");
    expect(finalRow?.cleanupStatus).toBe("success");
  });

  it("test_pending_cleanup_sweep_never_caps_while_provider_unavailable_then_cleans_up", async () => {
    const { companyId } = await seedCompanyAndEnvironment();
    // An orphan ephemeral lease that a failed plugin acquire recorded. The sweep
    // tears it down through retryPendingSandboxTeardown.
    const leaseId = await insertOrphanEphemeralLease({
      companyId,
      environmentId: null,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The provider stays unavailable for more sweeps than the finite attempt
    // cap. A long plugin reload or a long worker restart looks like this. The
    // probe reports not ready every time, so no sweep claims an attempt.
    let providerReady = false;
    const isPendingCleanupWorkerReady = vi.fn(async () => providerReady);
    const retryPendingSandboxTeardown = vi.fn(async () => {});
    const runtime = {
      isPendingCleanupWorkerReady,
      retryPendingSandboxTeardown,
    } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    // Run one more sweep than the cap. A per-sweep claim would exhaust the cap
    // and strand the sandbox, so this proves the unavailable provider never
    // burns an attempt.
    for (let sweep = 0; sweep < ATTEMPT_CAP + 1; sweep += 1) {
      const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      // The lease is swept and skipped every time; it never caps and never
      // tears down while the provider is unavailable.
      expect(result).toEqual({ swept: 1, destroyed: 0, capped: 0 });
    }
    expect(retryPendingSandboxTeardown).not.toHaveBeenCalled();
    // The unavailable provider consumed no finite attempt across every sweep.
    expect(await readAttempts(leaseId)).toBe(0);
    const afterUnavailable = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]?.status);
    expect(afterUnavailable).toBe("pending_cleanup");

    // The provider recovers, so the next sweep claims the first attempt and
    // tears the sandbox down.
    providerReady = true;
    const recovered = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(recovered).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);

    const finalRow = await db
      .select({ status: environmentLeases.status, cleanupStatus: environmentLeases.cleanupStatus })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]);
    expect(finalRow?.status).toBe("expired");
    expect(finalRow?.cleanupStatus).toBe("success");
  });

  it("test_pending_cleanup_sweep_does_not_let_unavailable_leases_starve_ready_leases", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // Fill one whole page with the oldest leases, and make every one of them
    // unavailable. Their providers are not ready, so the sweep must not tear
    // them down.
    const unavailableIds = new Set<string>();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (let index = 0; index < SWEEP_PAGE_SIZE; index += 1) {
      const id = await insertOrphanEphemeralLease({
        companyId,
        environmentId: null,
        updatedAt: twoHoursAgo,
      });
      unavailableIds.add(id);
    }

    // Add one newer lease with a ready provider. It sorts after the page of
    // unavailable leases, so the first sweep never reaches it.
    const readyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    // The probe reports the ready lease's provider ready and every unavailable
    // lease's provider not ready.
    const isPendingCleanupWorkerReady = vi.fn(
      async ({ lease }: { lease: { id: string } }) => !unavailableIds.has(lease.id),
    );
    const retryPendingSandboxTeardown = vi.fn(async () => {});
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
    const runtime = {
      isPendingCleanupWorkerReady,
      retryPendingSandboxTeardown,
      destroyRunLease,
    } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    // A five-minute backoff keeps every seeded lease eligible, because each one
    // is older than the backoff. A deferred lease bumps its updatedAt to now,
    // so the backoff then excludes it from the next page.
    const backoffMs = 5 * 60 * 1000;

    // First sweep: the page holds only the unavailable leases. The sweep defers
    // all of them and tears none down. The ready lease is not in this page.
    const first = await heartbeat.sweepPendingCleanupLeases({ backoffMs });
    expect(first).toEqual({ swept: SWEEP_PAGE_SIZE, destroyed: 0, capped: 0 });
    expect(retryPendingSandboxTeardown).not.toHaveBeenCalled();
    expect(destroyRunLease).not.toHaveBeenCalled();
    // The deferred leases consumed no finite attempt.
    for (const id of unavailableIds) {
      expect(await readAttempts(id)).toBe(0);
    }

    // Second sweep: the deferred unavailable leases now sit inside the backoff
    // window, so the sweep skips them. The ready lease takes the page slot and
    // tears down. This proves the unavailable leases never starve the ready
    // lease.
    const second = await heartbeat.sweepPendingCleanupLeases({ backoffMs });
    expect(second.destroyed).toBe(1);
    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    expect(destroyRunLease.mock.calls[0]?.[0]).toMatchObject({
      lease: expect.objectContaining({ id: readyLeaseId }),
    });

    const readyStatus = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, readyLeaseId))
      .then((rows) => rows[0]?.status);
    expect(readyStatus).toBe("expired");

    // The unavailable leases stay in pending_cleanup for a later retry.
    const stillPending = await db
      .select({ id: environmentLeases.id })
      .from(environmentLeases)
      .where(eq(environmentLeases.status, "pending_cleanup"))
      .then((rows) => rows.map((row) => row.id));
    expect(new Set(stillPending)).toEqual(unavailableIds);
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

  // Run `inject` exactly once, right before the sweep's first UPDATE on the
  // environmentLeases table runs. The sweep's first update is always its claim
  // (the retry claim or the cap-warning claim). This lets a test place a
  // concurrent writer between the sweep's read and its claim.
  function injectBeforeFirstLeaseClaim(inject: () => Promise<void>): { restore: () => void } {
    const realUpdate = db.update.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const builder = (realUpdate as (t: unknown) => unknown)(table) as {
        set: (values: unknown) => unknown;
      };
      if (table === environmentLeases && !injected) {
        const realSet = builder.set.bind(builder);
        builder.set = (values: unknown) => {
          const afterSet = realSet(values) as {
            returning: (...args: unknown[]) => unknown;
          };
          if (!injected) {
            injected = true;
            const realReturning = afterSet.returning.bind(afterSet);
            afterSet.returning = (...args: unknown[]) =>
              (async () => {
                await inject();
                return realReturning(...args);
              })();
          }
          return afterSet;
        };
      }
      return builder;
    }) as unknown as typeof db.update);
    return { restore: () => spy.mockRestore() };
  }

  // Read the full metadata object of a lease.
  async function readMetadata(leaseId: string): Promise<Record<string, unknown> | null> {
    return db
      .select({ metadata: environmentLeases.metadata })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => (rows[0]?.metadata as Record<string, unknown> | null) ?? null);
  }

  // A provider or plugin destroy rejection can carry a credential in its `name`
  // or `code`, not only its message. The per-lease retry log must never
  // serialize any error-derived string.
  it("test_pending_cleanup_retry_log_omits_sentinel_in_error_name_and_code", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy rejects with a credential-shaped sentinel in both the error
    // name and the error code.
    const sentinel = "Bearer sk-SENTINEL-a1b2c3";
    const rejection = new Error("provider destroy failed");
    rejection.name = `ProviderDestroyError ${sentinel}`;
    (rejection as { code?: string }).code = `EPROVIDER ${sentinel}`;
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

    // No error-derived string reaches the log. The sentinel never appears, and
    // no error field is present.
    expect(JSON.stringify(record)).not.toContain(sentinel);
    expect(record).not.toHaveProperty("err");
    expect(record).not.toHaveProperty("errorName");
    expect(record).not.toHaveProperty("errorCode");
    expect(record).not.toHaveProperty("message");
    expect(record).not.toHaveProperty("stack");
    expect(record).not.toHaveProperty("cause");

    // The log carries only fixed, locally generated fields.
    expect(record).toMatchObject({
      leaseId,
      environmentId,
      attempts: 1,
      errorKind: "destroy_failed",
    });
  });

  // The outer sweep catch logs a failure of the sweep itself. It must log a
  // constant errorKind only, never an error-derived string in the name or code.
  it("test_pending_cleanup_sweep_failure_log_omits_sentinel_in_error_name_and_code", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Make the sweep itself throw. The lease query rejects with an error that
    // carries a credential-shaped sentinel in both the name and the message. The
    // reaper's own queries pass through, so only the sweep fails.
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
            failure.name = `SweepQueryError ${sentinel}`;
            (failure as { code?: string }).code = `ESWEEP ${sentinel}`;
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
      expect(record).not.toHaveProperty("errorName");
      expect(record).not.toHaveProperty("errorCode");
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("stack");
      expect(record).toMatchObject({ errorKind: "sweep_failed" });
    } finally {
      selectSpy.mockRestore();
    }
  });

  // The claim writes only its own attempts key with `jsonb_set`. A concurrent
  // writer that sets an unrelated metadata key between the sweep's read and its
  // claim must keep that key. A full copied-metadata write would lose it.
  it("test_pending_cleanup_claim_preserves_unrelated_concurrent_metadata_key", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();
    const leaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy fails, so the lease stays pending_cleanup and the test can
    // read the final metadata.
    const destroyRunLease = vi.fn(async () => null);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(
        destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // A concurrent writer sets an unrelated key right before the claim runs.
    const hook = injectBeforeFirstLeaseClaim(async () => {
      await db
        .update(environmentLeases)
        .set({
          metadata: sql`jsonb_set(coalesce(${environmentLeases.metadata}, '{}'::jsonb), array['concurrentKey'], to_jsonb('keep-me'::text), true)`,
        })
        .where(eq(environmentLeases.id, leaseId));
    });

    try {
      const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(result).toEqual({ swept: 1, destroyed: 0, capped: 0 });
    } finally {
      hook.restore();
    }

    // The claim advanced its own attempts key and kept the concurrent key.
    const metadata = await readMetadata(leaseId);
    expect(metadata?.[ATTEMPTS_KEY]).toBe(1);
    expect(metadata?.concurrentKey).toBe("keep-me");
  });

  // A provider can write a malformed value under the attempts key. The guarded
  // cast must read it as zero, not throw. One malformed lease must never abort
  // the page sweep, so the sweep still processes the other leases on the page.
  it("test_pending_cleanup_malformed_retry_metadata_does_not_abort_sweep", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The malformed lease sorts first, so a throw would abort before the sweep
    // reaches the healthy lease.
    const malformedLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 120 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: "corrupt" },
    });
    const healthyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy fails, so both leases stay pending_cleanup and the test can
    // count the retries.
    const destroyedLeaseIds: string[] = [];
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      destroyedLeaseIds.push(lease.id);
      return null;
    });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // The sweep resolves; the malformed cast does not throw.
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.swept).toBe(2);

    // The sweep still processed the healthy lease.
    expect(destroyedLeaseIds).toContain(healthyLeaseId);

    // The malformed attempts value normalized to a real number on the claim.
    const malformedMetadata = await readMetadata(malformedLeaseId);
    expect(malformedMetadata?.[ATTEMPTS_KEY]).toBe(1);
  });

  // The cap warning fires only for a pending_cleanup lease at or above the cap.
  // A lease that leaves pending_cleanup between the read and the claim must get
  // no warn-flag write, because the claim carries a status predicate.
  it("test_pending_cleanup_cap_warning_requires_pending_cleanup_status_and_cap", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // A lease at the cap. It leaves pending_cleanup right before the warn claim.
    const cappedLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: ATTEMPT_CAP },
    });

    const destroyRunLease = vi.fn(async () => null);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(
        destroyRunLease as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // A concurrent path moves the lease out of pending_cleanup right before the
    // warn claim runs.
    const hook = injectBeforeFirstLeaseClaim(async () => {
      await db
        .update(environmentLeases)
        .set({ status: "expired" })
        .where(eq(environmentLeases.id, cappedLeaseId));
    });

    try {
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    } finally {
      hook.restore();
    }

    // The lease left pending_cleanup, so the warn claim wrote no flag.
    const metadata = await readMetadata(cappedLeaseId);
    expect(metadata?.[CAP_WARNED_KEY]).not.toBe(true);

    // The cap warning did not log.
    const capWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(
        (call) =>
          call[1] === "environment lease reached the pending_cleanup retry cap; left for manual cleanup",
      );
    expect(capWarnings.length).toBe(0);

    // A lease below the cap gets no warn flag either. The retry path never
    // reaches the cap branch.
    const belowCapLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: ATTEMPT_CAP - 1 },
    });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    const belowCapMetadata = await readMetadata(belowCapLeaseId);
    expect(belowCapMetadata?.[CAP_WARNED_KEY]).not.toBe(true);
  });

  // Override a lease metadata root with a raw JSON value. The insert helper
  // always writes an object root, so a scalar or array root test needs a raw
  // update. The value binds as text and casts to jsonb, so `"5"` writes a number
  // scalar root and `"[1,2,3]"` writes an array root.
  async function setRawMetadataRoot(leaseId: string, rawJson: string): Promise<void> {
    await db
      .update(environmentLeases)
      .set({ metadata: sql`${rawJson}::jsonb` })
      .where(eq(environmentLeases.id, leaseId));
  }

  // A provider can write a negative attempt count. The SQL reader and the
  // TypeScript reader both clamp a negative value to zero, so the claim predicate
  // matches. The lease still claims one attempt and the destroy still runs.
  it("test_pending_cleanup_negative_attempts_metadata_normalizes_and_lease_still_destroys", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The negative-attempts lease sorts first. A thrown or mismatched claim would
    // strand it before the sweep reaches the healthy lease.
    const negativeLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 120 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: -3 },
    });
    const healthyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy succeeds and moves each lease out of pending_cleanup.
    const destroyedLeaseIds: string[] = [];
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      destroyedLeaseIds.push(lease.id);
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
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // The sweep resolves; the negative value does not strand the lease.
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.swept).toBe(2);

    // The negative-attempts lease claimed one attempt and destroyed.
    expect(destroyedLeaseIds).toContain(negativeLeaseId);
    expect(destroyedLeaseIds).toContain(healthyLeaseId);
    expect(result.destroyed).toBe(2);

    // The negative value normalized to zero, so the claim advanced it to one.
    const negativeMetadata = await readMetadata(negativeLeaseId);
    expect(negativeMetadata?.[ATTEMPTS_KEY]).toBe(1);

    const negativeStatus = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, negativeLeaseId))
      .then((rows) => rows[0]?.status);
    expect(negativeStatus).toBe("expired");
  });

  // A provider can write a finite number outside the 32-bit integer range. The
  // SQL reader computes as numeric and clamps to the cap, so the `::int` cast
  // never runs on the stored value. The sweep does not throw, and the malformed
  // lease normalizes into the cap behavior.
  it("test_pending_cleanup_out_of_range_attempts_metadata_does_not_abort_sweep", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The out-of-range lease sorts first. A thrown cast would abort before the
    // sweep reaches the healthy lease.
    const outOfRangeLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 120 * 60 * 1000),
      metadata: { [ATTEMPTS_KEY]: 1e300 },
    });
    const healthyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy fails, so the healthy lease stays pending_cleanup and the test
    // can confirm the sweep reached it.
    const destroyedLeaseIds: string[] = [];
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      destroyedLeaseIds.push(lease.id);
      return null;
    });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // The sweep resolves; the out-of-range value does not abort the page.
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.swept).toBe(2);

    // The value clamped to the cap, so the lease took the cap branch, not a
    // destroy. The warn-once flag is set exactly once.
    expect(result.capped).toBe(1);
    expect(destroyedLeaseIds).not.toContain(outOfRangeLeaseId);
    const outOfRangeMetadata = await readMetadata(outOfRangeLeaseId);
    expect(outOfRangeMetadata?.[CAP_WARNED_KEY]).toBe(true);

    // The sweep still processed the healthy lease.
    expect(destroyedLeaseIds).toContain(healthyLeaseId);
  });

  // A provider can write a scalar metadata root. `jsonb_set` fails on a
  // non-object root, so the reader falls back to an empty object. The sweep does
  // not throw, and the lease still claims one attempt and destroys.
  it("test_pending_cleanup_scalar_metadata_root_does_not_abort_sweep", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The scalar-root lease sorts first. A failed `jsonb_set` would abort before
    // the sweep reaches the healthy lease.
    const scalarLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 120 * 60 * 1000),
    });
    await setRawMetadataRoot(scalarLeaseId, "5");
    const healthyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy succeeds and moves each lease out of pending_cleanup.
    const destroyedLeaseIds: string[] = [];
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      destroyedLeaseIds.push(lease.id);
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
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // The sweep resolves; the scalar root does not break the claim write.
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.swept).toBe(2);
    expect(result.destroyed).toBe(2);
    expect(destroyedLeaseIds).toContain(scalarLeaseId);
    expect(destroyedLeaseIds).toContain(healthyLeaseId);

    // The claim replaced the scalar root with an object that holds one attempt.
    const scalarMetadata = await readMetadata(scalarLeaseId);
    expect(scalarMetadata?.[ATTEMPTS_KEY]).toBe(1);
  });

  // A provider can write an array metadata root. `jsonb_set` fails on a
  // non-object root, so the reader falls back to an empty object. The sweep does
  // not throw, and the lease still claims one attempt and destroys.
  it("test_pending_cleanup_array_metadata_root_does_not_abort_sweep", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The array-root lease sorts first. A failed `jsonb_set` would abort before
    // the sweep reaches the healthy lease.
    const arrayLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 120 * 60 * 1000),
    });
    await setRawMetadataRoot(arrayLeaseId, "[1, 2, 3]");
    const healthyLeaseId = await insertPendingCleanupLease({
      companyId,
      environmentId,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The destroy succeeds and moves each lease out of pending_cleanup.
    const destroyedLeaseIds: string[] = [];
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      destroyedLeaseIds.push(lease.id);
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
      environmentRuntime: fakeRuntime(
        destroyRunLease as unknown as HeartbeatEnvironmentRuntime["destroyRunLease"],
      ),
    });

    // The sweep resolves; the array root does not break the claim write.
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.swept).toBe(2);
    expect(result.destroyed).toBe(2);
    expect(destroyedLeaseIds).toContain(arrayLeaseId);
    expect(destroyedLeaseIds).toContain(healthyLeaseId);

    // The claim replaced the array root with an object that holds one attempt.
    const arrayMetadata = await readMetadata(arrayLeaseId);
    expect(arrayMetadata?.[ATTEMPTS_KEY]).toBe(1);
  });

  it("flushes the in-process orphan buffer before the read, so a freshly landed row is swept the same tick", async () => {
    const { companyId, environmentId } = await seedCompanyAndEnvironment();

    // The flush lands one durable orphan row, exactly as the runtime buffer does
    // after the database recovers. The sweep must run this flush before it reads
    // the rows, so the same tick tears the freshly-landed orphan down.
    const flushDeferredOrphanCleanups = vi.fn(async () => {
      await insertOrphanEphemeralLease({
        companyId,
        environmentId,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      return { recovered: 1, pending: 0 };
    });
    // The recorded-data teardown succeeds, so the sweep releases the lease.
    const retryPendingSandboxTeardown = vi.fn(async () => {});
    const runtime = {
      flushDeferredOrphanCleanups,
      retryPendingSandboxTeardown,
    } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    // The flush ran once before the read, so the row it landed is visible to the
    // same sweep and tears down through the recorded-data teardown path.
    expect(flushDeferredOrphanCleanups).toHaveBeenCalledTimes(1);
    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });

    const rows = await db.select().from(environmentLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("expired");
    expect(rows[0]?.cleanupStatus).toBe("success");
  });
});
