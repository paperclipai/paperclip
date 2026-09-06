import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import {
  heartbeatService,
  leaseReleaseStatusForRunStatus,
  type HeartbeatEnvironmentRuntime,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminalize-before-release tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// This file is a characterization test. It pins the CURRENT run-teardown order
// in server/src/services/heartbeat.ts:16586-16607: the teardown finally
// terminalizes the run FIRST, then releases the environment lease using the
// terminalized status. The production order is:
//   latestRun = await terminalizeRunOnLeaseRelease(latestRun);   // :16593 first
//   await releaseEnvironmentLeasesForRun({ status: latestRun?.status, ... }); // :16601 second
//
// The enclosing teardown finally is not reasonably invokable in isolation: it
// lives deep in the heartbeat run body and needs a full sandbox, adapter, and
// workspace bring-up to reach. So this test drives the two real production
// functions in the same order against the embedded database:
// `terminalizeRunOnLeaseRelease` and `releaseEnvironmentLeasesForRun`. It thus
// executes the real lease-release boundary: the terminalized run status flows
// through the real run-status → lease-status mapping
// (`leaseReleaseStatusForRunStatus`) and the real environment orchestrator
// (`envOrchestrator.releaseForRun`) down to the runtime leaf. The test injects a
// fake `environmentRuntime` that records the mapped lease status at that leaf, so
// a wrong terminal state or a broken mapping fails the suite.
//
// The two additive test seams keep production behavior unchanged. The service now
// exposes `releaseEnvironmentLeasesForRun` (next to the existing
// `terminalizeRunOnLeaseRelease`), and `leaseReleaseStatusForRunStatus` is now
// exported for the direct mapping assertions below.
describeEmbeddedPostgres("heartbeat teardown terminalizes the run before releasing the lease", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminalize-before-release-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { issueStatus: string; runStatus: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminalize before release",
      status: input.issueStatus,
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);

    return { companyId, agentId, issueId, runId, run };
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  // Drive the two real production functions in the teardown order at
  // heartbeat.ts:16586-16607 and report what the real release step observes.
  // Terminalize runs first. Then `releaseEnvironmentLeasesForRun` runs with the
  // terminalized run status. That real call maps the run status through
  // `leaseReleaseStatusForRunStatus` and passes it to the real environment
  // orchestrator, which reaches the runtime leaf. The injected fake
  // `environmentRuntime` records the run id and the mapped lease status at that
  // leaf, so the test observes the actual boundary, not a reproduction.
  async function runTeardownSequenceObservingRelease(input: {
    runId: string;
    companyId: string;
    agentId: string;
    providerResourceDisposition?: "keep_running" | "stop_and_retain" | "destroy";
  }) {
    const { runId, companyId, agentId } = input;
    const releaseLeafCalls: Array<{ runId: string; status: string }> = [];
    const ordering: string[] = [];
    const fakeEnvironmentRuntime = {
      // The orchestrator's `releaseForRun` calls this leaf with the mapped lease
      // status. There are no seeded leases, so return an empty release set.
      releaseRunLeases: async (
        heartbeatRunId: string,
        status: "released" | "expired" | "failed",
      ) => {
        ordering.push(`release:${heartbeatRunId}`);
        releaseLeafCalls.push({ runId: heartbeatRunId, status });
        return [];
      },
    } as unknown as HeartbeatEnvironmentRuntime;
    const heartbeat = heartbeatService(db, {
      environmentRuntime: fakeEnvironmentRuntime,
      closeWarmNativeSessionsForRun: async ({ runId }) => {
        ordering.push(`close:${runId}`);
        return { closed: 1, busy: 0, failed: 0 };
      },
    });

    let latestRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const statusBeforeTerminalize = latestRun?.status ?? null;
    if (latestRun) latestRun = await heartbeat.terminalizeRunOnLeaseRelease(latestRun);
    // The status production passes into releaseEnvironmentLeasesForRun (:16605).
    const statusThreadedToRelease = latestRun?.status ?? null;
    // The run row as the later release step observes it in the database.
    const dbStatusAtRelease = await runStatus(runId);

    // Execute the real release step exactly as the teardown does at :16601.
    await heartbeat.releaseEnvironmentLeasesForRun({
      runId,
      companyId,
      agentId,
      status: statusThreadedToRelease,
      providerResourceDisposition: input.providerResourceDisposition,
    });
    const orchestratorObservedRunId = releaseLeafCalls.at(-1)?.runId ?? null;
    const orchestratorObservedLeaseStatus = releaseLeafCalls.at(-1)?.status ?? null;

    return {
      statusBeforeTerminalize,
      statusThreadedToRelease,
      dbStatusAtRelease,
      releaseCallCount: releaseLeafCalls.length,
      orchestratorObservedRunId,
      orchestratorObservedLeaseStatus,
      ordering,
      terminalRun: latestRun,
    };
  }

  it("closes a warm native session before destroying its terminal lease", async () => {
    const { companyId, agentId, runId } = await seed({ issueStatus: "done", runStatus: "running" });
    const observed = await runTeardownSequenceObservingRelease({
      runId,
      companyId,
      agentId,
      providerResourceDisposition: "destroy",
    });

    expect(observed.ordering).toEqual([`close:${runId}`, `release:${runId}`]);
    expect(observed.releaseCallCount).toBe(1);
  });

  it("does not destroy a terminal lease while its warm native session is busy", async () => {
    const { companyId, agentId, runId } = await seed({ issueStatus: "done", runStatus: "running" });
    const releaseRunLeases = vi.fn(async () => []);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: { releaseRunLeases } as unknown as HeartbeatEnvironmentRuntime,
      closeWarmNativeSessionsForRun: async () => ({ closed: 0, busy: 1, failed: 0 }),
    });

    await heartbeat.releaseEnvironmentLeasesForRun({
      runId,
      companyId,
      agentId,
      status: "succeeded",
      providerResourceDisposition: "destroy",
    });

    expect(releaseRunLeases).not.toHaveBeenCalled();
  });

  it("terminalizes a running run to succeeded before release when the issue reached done", async () => {
    const { companyId, agentId, issueId, runId } = await seed({ issueStatus: "done", runStatus: "running" });

    const observed = await runTeardownSequenceObservingRelease({ runId, companyId, agentId });

    // The run was still running before terminalize, but release observes the
    // terminalized status, proving terminalize ran first.
    expect(observed.statusBeforeTerminalize).toBe("running");
    expect(observed.statusThreadedToRelease).toBe("succeeded");
    expect(observed.dbStatusAtRelease).toBe("succeeded");

    // The real orchestrator ran once and received the run id plus the mapped
    // lease status for a succeeded run.
    expect(observed.releaseCallCount).toBe(1);
    expect(observed.orchestratorObservedRunId).toBe(runId);
    expect(observed.orchestratorObservedLeaseStatus).toBe("released");

    // The issue outcome is preserved and the lifecycle event records the reason.
    const issueStatus = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status);
    expect(issueStatus).toBe("done");

    const event = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("lease release");
    expect((event?.payload as { terminalStatus?: string } | null)?.terminalStatus).toBe("succeeded");
  });

  it("terminalizes a running run to interrupted before release when the issue is not terminal", async () => {
    const { companyId, agentId, runId } = await seed({ issueStatus: "in_progress", runStatus: "running" });

    const observed = await runTeardownSequenceObservingRelease({ runId, companyId, agentId });

    expect(observed.statusBeforeTerminalize).toBe("running");
    expect(observed.statusThreadedToRelease).toBe("interrupted");
    expect(observed.dbStatusAtRelease).toBe("interrupted");

    // An interrupted run maps to a normal lease release.
    expect(observed.releaseCallCount).toBe(1);
    expect(observed.orchestratorObservedLeaseStatus).toBe("released");

    const row = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("interrupted");
    expect(row?.errorCode).toBe("lease_released_before_terminal");
  });

  it("terminalizes a still-queued run to interrupted before release", async () => {
    // A queued run holds a lease but never reached running. Release must observe a
    // terminal status, not the queued phantom-live status.
    const { companyId, agentId, runId } = await seed({ issueStatus: "in_progress", runStatus: "queued" });

    const observed = await runTeardownSequenceObservingRelease({ runId, companyId, agentId });

    expect(observed.statusBeforeTerminalize).toBe("queued");
    expect(observed.statusThreadedToRelease).toBe("interrupted");
    expect(observed.dbStatusAtRelease).toBe("interrupted");
    expect(observed.orchestratorObservedLeaseStatus).toBe("released");
  });

  it("threads an already-terminal run's status through unchanged and writes no new event", async () => {
    // When another path already made the run terminal, terminalize is a no-op, so
    // release still observes that authoritative terminal status.
    const { companyId, agentId, runId } = await seed({ issueStatus: "done", runStatus: "failed" });

    const observed = await runTeardownSequenceObservingRelease({ runId, companyId, agentId });

    expect(observed.statusBeforeTerminalize).toBe("failed");
    expect(observed.statusThreadedToRelease).toBe("failed");
    expect(observed.dbStatusAtRelease).toBe("failed");

    // A failed run maps to a failed lease release at the orchestrator.
    expect(observed.orchestratorObservedLeaseStatus).toBe("failed");

    const eventCount = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows.length);
    expect(eventCount).toBe(0);
  });
});

// Pin the real run-status → lease-release-status mapping the teardown threads
// into the environment orchestrator (heartbeat.ts:16601-16606). The database
// tests above reach the "released" and "failed" branches; this direct test also
// pins the "expired" and "timed_out" branches. It needs no database, so it runs
// on every host.
describe("run-status to lease-release-status mapping", () => {
  it("maps each terminal run status to the lease-release status the orchestrator receives", () => {
    // A normal or in-progress run releases the lease.
    expect(leaseReleaseStatusForRunStatus("succeeded")).toBe("released");
    expect(leaseReleaseStatusForRunStatus("interrupted")).toBe("released");
    expect(leaseReleaseStatusForRunStatus("running")).toBe("released");
    expect(leaseReleaseStatusForRunStatus("queued")).toBe("released");
    expect(leaseReleaseStatusForRunStatus(null)).toBe("released");
    expect(leaseReleaseStatusForRunStatus(undefined)).toBe("released");
    // A failed or timed-out run marks the lease release as failed.
    expect(leaseReleaseStatusForRunStatus("failed")).toBe("failed");
    expect(leaseReleaseStatusForRunStatus("timed_out")).toBe("failed");
    // A cancelled run expires the lease.
    expect(leaseReleaseStatusForRunStatus("cancelled")).toBe("expired");
  });
});
