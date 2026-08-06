/**
 * VIR-296 — Fix A + Fix B-light + Fix D-obs acceptance tests.
 *
 * Covers the ownership zombie window approved in ADR-0001
 * (VIR-295/#document-adr rev `7e10b0c4`, CTO sign-off):
 *
 * - Fix A: when an issue's `executionRunId`/`checkoutRunId` points at a
 *   heartbeat_run whose DB row is still `running` but whose in-memory
 *   process handle is gone (no `runningProcesses` entry, dead PID),
 *   `clearExecutionRunIfTerminal`/`clearCheckoutRunIfTerminal` promote it to
 *   `failed`/`process_lost` and let the existing terminal path clear the lock.
 * - Fix B-light: `enqueueProcessLossRetry` no longer migrates `executionRunId`
 *   to the retry run at enqueue time, so a retry that dies before checkout
 *   does not leave the issue pointing at a terminal run.
 * - Fix D-obs: `sweepStaleIssueLocks` emits `zombie_executionRunId_detected`
 *   WARN logs and reports `zombieRefs` for any issue referencing a
 *   terminal/missing heartbeat_run.
 *
 * These are runtime/backend integration tests; no QA browser/mobile path
 * applies (runtime/server scope per VIR-296 out-of-scope notes).
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres VIR-296 zombie fix tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("VIR-296 zombie ownership fix (ADR-0001 Fix A + Fix B-light + Fix D-obs)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-vir296-zombie-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    // Defensive: in case any test registered a fake handle.
    runningProcesses.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgent(adapterType: string = "opencode_local") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip VIR-296",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    status: string,
    extra: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "manual",
      ...extra,
    });
    return runId;
  }

  // ---------------------------------------------------------------- Fix A ---

  it("Fix A: clearExecutionRunIfTerminal clears executionRunId when the referenced run is DB-running but its process handle is lost", async () => {
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const zombieRunId = await seedRun(companyId, agentId, "running", {
      startedAt: new Date(),
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 zombie executionRunId handle-lost",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: zombieRunId,
      executionRunId: zombieRunId,
      executionLockedAt: new Date(),
    });

    // No handle in `runningProcesses` and no live PID → isRunHandleLost is true.
    expect(runningProcesses.has(zombieRunId)).toBe(false);

    const svc = issueService(db);
    const cleared = await svc.clearExecutionRunIfTerminal(issueId);
    expect(cleared).toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });

    // The zombie run was promoted to failed/process_lost by the recovery path.
    const runRow = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, zombieRunId))
      .then((rows) => rows[0]);
    expect(runRow.status).toBe("failed");
    expect(runRow.errorCode).toBe("process_lost");
  });

  it("Fix A: clearExecutionRunIfTerminal preserves a live running run whose handle is present", async () => {
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const liveRunId = await seedRun(companyId, agentId, "running", { startedAt: new Date() });
    runningProcesses.set(liveRunId, {
      child: { pid: 4321 } as any,
      graceSec: 1,
      processGroupId: null,
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 live executionRunId — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
      executionLockedAt: new Date(),
    });

    const svc = issueService(db);
    const cleared = await svc.clearExecutionRunIfTerminal(issueId);
    expect(cleared).toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row.executionRunId).toBe(liveRunId);
  });

  it("Fix A: assertCheckoutOwner allows mutation when executionRunId points at a handle-lost running run (no 409)", async () => {
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const zombieRunId = await seedRun(companyId, agentId, "running", { startedAt: new Date() });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 mutate after recovery",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: zombieRunId,
      executionRunId: zombieRunId,
      executionLockedAt: new Date(),
    });

    const svc = issueService(db);
    const freshRunId = await seedRun(companyId, agentId, "running", { startedAt: new Date() });
    runningProcesses.set(freshRunId, {
      child: { pid: 9999 } as any,
      graceSec: 1,
      processGroupId: null,
    });

    // The next checkout by the live run should adopt ownership. This is the
    // mutate-path that used to wedge on 409 in the zombie window. assertCheckout
    // of an `in_progress` issue owned by the same agent must NOT throw a 409.
    const checkedOut = await svc
      .checkout(issueId, agentId, ["in_progress"], freshRunId)
      .catch((err: any) => err);
    expect(checkedOut).toBeDefined();
    expect((checkedOut as any)?.message).not.toBe("Issue run ownership conflict");
    // After adoption executionRunId is moved to the fresh live run.
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row.executionRunId).toBe(freshRunId);
  });

  // -------------------------------------------------------- Fix B-light -----

  it("Fix B-light: enqueueProcessLossRetry does not point executionRunId at the retry run until checkout", async () => {
    // The retry path is exercised through reapOrphanedRuns when a run goes dead
    // and is retried. We seed a dead running run (no handle, dead PID) and
    // verify that after the reaper schedules a retry the issue's executionRunId
    // is NOT pointing at the retry run's id — it should remain the original
    // (terminal) run or null, with only checkoutRunId cleared.
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const deadRunId = await seedRun(companyId, agentId, "running", {
      startedAt: new Date(),
      processPid: 1, // bogus pid, definitely not alive
      processGroupId: null,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 retry does not migrate executionRunId",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: deadRunId,
      executionRunId: deadRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    // After reap: the dead run must be terminal.
    const deadRow = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deadRunId))
      .then((rows) => rows[0]);
    expect(deadRow.status).toBe("failed");
    expect(deadRow.errorCode).toBe("process_lost");

    // A retry run may have been queued. Regardless, the issue must NOT point
    // executionRunId at any newly-created retry run id — it should either be
    // null (released by releaseIssueExecutionAndPromote) or still the dead
    // run id (B-light never migrated it). We accept either, but explicitly
    // reject a pointer to a *different running* retry run id (the old buggy
    // behavior).
    const issueRow = await db
      .select({
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow.checkoutRunId).toBeNull();
    const allRunIds = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map((r) => r.id);
    // Find any run that is NOT the dead run and check executionRunId never points to a *retry* run
    for (const otherRunId of allRunIds) {
      if (otherRunId !== deadRunId && otherRunId === issueRow.executionRunId) {
        // If executionRunId points at a new run, that means migration happened — Fix B-light violation.
        throw new Error(
          `Fix B-light violated: executionRunId was migrated to retry run ${otherRunId} (issue ${issueId})`,
        );
      }
    }
  });

  // --------------------------------------------------------- Fix D-obs ------

  it("Fix D-obs: sweepStaleIssueLocks emits zombieRefs and WARN when issues reference terminal runs", async () => {
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const failedRunId = await seedRun(companyId, agentId, "failed", { finishedAt: new Date() });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 zombie detector",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(Array.isArray(result.zombieRefs)).toBe(true);
    expect(result.zombieRefs.length).toBeGreaterThan(0);
    const match = result.zombieRefs.find((z) => z.issueId === issueId && z.runId === failedRunId);
    expect(match).toBeDefined();
    expect(match.runStatus).toBe("failed");

    expect(result.cleared).toBe(1);
  });

  it("Fix D-obs: sweepStaleIssueLocks reports no zombieRefs when no issue references a terminal/missing run", async () => {
    const { companyId, agentId } = await seedCompanyAgent("opencode_local");
    const liveRunId = await seedRun(companyId, agentId, "running", { startedAt: new Date() });
    runningProcesses.set(liveRunId, {
      child: { pid: 1234 } as any,
      graceSec: 1,
      processGroupId: null,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VIR-296 no zombie refs",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(0);
    expect(result.zombieRefs).toEqual([]);
  });
});
