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
    `Skipping embedded Postgres orphaned active lease sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat sweepOrphanedActiveLeases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphaned-active-lease-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentAndEnvironment() {
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Fake Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" },
    });
    return { companyId, agentId, environmentId };
  }

  async function insertHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    status: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status,
      nextEventSeq: 1,
    });
    return id;
  }

  async function insertActiveLease(input: {
    companyId: string;
    environmentId: string | null;
    heartbeatRunId: string | null;
    updatedAt: Date;
    provider?: string;
    providerLeaseId?: string;
    status?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      heartbeatRunId: input.heartbeatRunId,
      status: input.status ?? "active",
      leasePolicy: "reuse_by_environment",
      provider: input.provider ?? "fake",
      providerLeaseId: input.providerLeaseId ?? `sandbox://fake/${id}`,
      acquiredAt: input.updatedAt,
      lastUsedAt: input.updatedAt,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  async function leaseRow(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  const oldEnough = () => new Date(Date.now() - 60 * 60 * 1000);

  it("test_flips_an_active_lease_when_its_run_is_failed", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 1 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("pending_cleanup");
  });

  it("test_keeps_an_active_lease_when_its_run_is_running", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "running" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("active");
  });

  it("test_flips_an_active_lease_when_its_heartbeat_run_id_is_null", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 1 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("pending_cleanup");
  });

  it("test_keeps_an_active_lease_when_its_updated_at_is_inside_the_backoff_window", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("active");
  });

  it("test_keeps_a_retained_lease_unchanged", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("retained");
  });

  it("test_skips_a_lease_when_another_live_lease_holds_the_same_provider_lease_id", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const sharedProviderLeaseId = "sandbox://fake/shared-resource";
    const orphanedLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      providerLeaseId: sharedProviderLeaseId,
    });
    // A second lease still owns the same physical sandbox resource.
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
      providerLeaseId: sharedProviderLeaseId,
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(orphanedLeaseId);
    expect(row?.status).toBe("active");
  });

  it("test_defers_a_guarded_lease_instead_of_leaving_it_at_the_front_of_the_page", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const sharedProviderLeaseId = "sandbox://fake/shared-resource";
    const orphanedLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      providerLeaseId: sharedProviderLeaseId,
    });
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
      providerLeaseId: sharedProviderLeaseId,
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    const row = await leaseRow(orphanedLeaseId);
    expect(row?.status).toBe("active");
    // The guard moved the row's `updatedAt` forward, so a fresh backoff
    // cutoff no longer selects it. The exact value is not the point; only
    // that it moved out of the stale range the sweep reads by.
    expect(row!.updatedAt.getTime()).toBeGreaterThan(oldEnough().getTime());
  });

  it("test_a_full_page_of_guarded_leases_does_not_starve_a_later_eligible_orphan", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const veryOld = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const staleButNewer = new Date(Date.now() - 60 * 60 * 1000);

    // Fill one full sweep page (ORPHANED_ACTIVE_LEASE_SWEEP_PAGE_SIZE = 20)
    // with orphan candidates that are each guarded by a live second owner of
    // the same provider resource. Every guarded row is older than the
    // eligible orphan below, so an unbounded query would return them first
    // on every tick.
    for (let i = 0; i < 20; i += 1) {
      const providerLeaseId = `sandbox://fake/guarded-${i}`;
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: null,
        updatedAt: veryOld,
        providerLeaseId,
      });
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: null,
        updatedAt: new Date(),
        providerLeaseId,
        status: "retained",
      });
    }

    // This orphan has no other owner, so it is eligible for cleanup. It
    // sorts behind the 20 guarded rows because it is newer than them, so
    // the first sweep page does not reach it.
    const eligibleLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: staleButNewer,
    });

    const heartbeat = heartbeatService(db);

    const firstTick = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });
    expect(firstTick).toEqual({ recovered: 0 });
    const eligibleAfterFirstTick = await leaseRow(eligibleLeaseId);
    expect(eligibleAfterFirstTick?.status).toBe("active");

    // The guarded rows moved out of the stale page on the first tick, so
    // the second tick reaches the eligible orphan behind them.
    const secondTick = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });
    expect(secondTick).toEqual({ recovered: 1 });
    const eligibleAfterSecondTick = await leaseRow(eligibleLeaseId);
    expect(eligibleAfterSecondTick?.status).toBe("pending_cleanup");
  });

  it("test_writes_a_failure_reason_on_each_flipped_lease", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    const row = await leaseRow(leaseId);
    expect(row?.failureReason).toBeTruthy();
  });

  it("test_stops_the_recovered_sandbox_on_the_same_reaper_tick", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

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
      environmentRuntime: {
        destroyRunLease,
      } as unknown as HeartbeatEnvironmentRuntime,
    });

    // The periodic timer call uses a five-minute staleness threshold. The
    // lease is older than that window, so the recovery flip and the
    // pending_cleanup teardown both run in this one call.
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("expired");
  });

  it("test_stops_the_recovered_sandbox_on_the_startup_call", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

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
      environmentRuntime: {
        destroyRunLease,
      } as unknown as HeartbeatEnvironmentRuntime,
    });

    // The startup call uses a zero staleness threshold, so the new sweep and
    // the existing pending_cleanup sweep both act without a backoff delay,
    // and the recovered lease reaches the provider teardown in this one call.
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(destroyRunLease).toHaveBeenCalledTimes(1);
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("expired");
  });

  it("test_logs_a_distinct_error_kind_and_no_exception_field_when_the_sweep_fails", async () => {
    const sentinel = "Bearer sk-SENTINEL-a1b2c3";
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
      const heartbeat = heartbeatService(db, {
        environmentRuntime: {
          destroyRunLease: vi.fn(async () => null),
        } as unknown as HeartbeatEnvironmentRuntime,
      });

      // The reaper isolates the sweep, so the reaper itself still resolves.
      await expect(heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).resolves.toBeDefined();

      const sweepCall = vi
        .mocked(logger.error)
        .mock.calls.find((call) => call[1] === "orphaned active environment lease sweep failed");
      expect(sweepCall).toBeDefined();
      const record = sweepCall?.[0] as Record<string, unknown>;

      expect(JSON.stringify(record)).not.toContain(sentinel);
      expect(record).not.toHaveProperty("err");
      expect(record).not.toHaveProperty("errorName");
      expect(record).not.toHaveProperty("errorCode");
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("stack");
      expect(record).toMatchObject({ errorKind: "orphaned_active_lease_sweep_failed" });
    } finally {
      selectSpy.mockRestore();
    }
  });
});
