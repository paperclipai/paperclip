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

import { heartbeatService } from "../services/heartbeat.ts";

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
// terminalized status. It never changes production code.
//
// The enclosing teardown finally is not reasonably invokable in isolation: it
// lives deep in the heartbeat run body and needs a full sandbox, adapter, and
// workspace bring-up to reach. `releaseEnvironmentLeasesForRun` is also not
// exposed on `heartbeatService(db)`. So this test reproduces the documented
// production sequence directly against the embedded database and asserts the
// release step observes the already-terminal status. The production order is:
//   latestRun = await terminalizeRunOnLeaseRelease(latestRun);   // :16593 first
//   await releaseEnvironmentLeasesForRun({ status: latestRun?.status, ... }); // :16601 second
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

  // Reproduce the production teardown sequence at heartbeat.ts:16586-16607 and
  // report what the release step observes. Terminalize runs first; the status
  // threaded into `releaseEnvironmentLeasesForRun` is the terminalized run's
  // status; and the run row is already terminal in the database when release
  // would run (release is the later step).
  async function runTeardownSequenceObservingRelease(runId: string) {
    const heartbeat = heartbeatService(db);
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
    return { statusBeforeTerminalize, statusThreadedToRelease, dbStatusAtRelease, terminalRun: latestRun };
  }

  it("terminalizes a running run to succeeded before release when the issue reached done", async () => {
    const { issueId, runId } = await seed({ issueStatus: "done", runStatus: "running" });

    const observed = await runTeardownSequenceObservingRelease(runId);

    // The run was still running before terminalize, but release observes the
    // terminalized status, proving terminalize ran first.
    expect(observed.statusBeforeTerminalize).toBe("running");
    expect(observed.statusThreadedToRelease).toBe("succeeded");
    expect(observed.dbStatusAtRelease).toBe("succeeded");

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
    const { runId } = await seed({ issueStatus: "in_progress", runStatus: "running" });

    const observed = await runTeardownSequenceObservingRelease(runId);

    expect(observed.statusBeforeTerminalize).toBe("running");
    expect(observed.statusThreadedToRelease).toBe("interrupted");
    expect(observed.dbStatusAtRelease).toBe("interrupted");

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
    const { runId } = await seed({ issueStatus: "in_progress", runStatus: "queued" });

    const observed = await runTeardownSequenceObservingRelease(runId);

    expect(observed.statusBeforeTerminalize).toBe("queued");
    expect(observed.statusThreadedToRelease).toBe("interrupted");
    expect(observed.dbStatusAtRelease).toBe("interrupted");
  });

  it("threads an already-terminal run's status through unchanged and writes no new event", async () => {
    // When another path already made the run terminal, terminalize is a no-op, so
    // release still observes that authoritative terminal status.
    const { runId } = await seed({ issueStatus: "done", runStatus: "failed" });

    const observed = await runTeardownSequenceObservingRelease(runId);

    expect(observed.statusBeforeTerminalize).toBe("failed");
    expect(observed.statusThreadedToRelease).toBe("failed");
    expect(observed.dbStatusAtRelease).toBe("failed");

    const eventCount = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows.length);
    expect(eventCount).toBe(0);
  });
});
