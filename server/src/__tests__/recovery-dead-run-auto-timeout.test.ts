import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
    `Skipping embedded Postgres dead-run auto-timeout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// A pid that is (almost) certainly not a live process on the test host. isPidAlive
// does `process.kill(pid, 0)`, which throws ESRCH for a nonexistent pid.
const DEAD_PID = 2_147_483_646;

describeEmbeddedPostgres("recovery autoTimeoutDeadSilentRuns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dead-run-timeout-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function enable() {
    vi.stubEnv("PAPERCLIP_DEAD_RUN_AUTO_TIMEOUT", "true");
  }

  async function seedCompanyAndAgent(adapterType: string) {
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
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRunningRun(input: {
    companyId: string;
    agentId: string;
    processPid: number | null;
    ageMs?: number;
  }) {
    const runId = randomUUID();
    const staleAt = new Date(Date.now() - (input.ageMs ?? 60 * 60 * 1000)); // 1h silent by default
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      invocationSource: "manual",
      processPid: input.processPid ?? undefined,
      startedAt: staleAt,
      createdAt: staleAt,
    });
    return runId;
  }

  async function seedLockedIssue(input: { companyId: string; agentId: string; runId: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Locked by a dead run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.runId,
      executionRunId: input.runId,
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
  }

  it("is a no-op while the feature flag is off (ships dark)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    const runId = await seedRunningRun({ companyId, agentId, processPid: DEAD_PID });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoTimeoutDeadSilentRuns();

    expect(result).toEqual({ scanned: 0, timedOut: 0, runIds: [] });
    expect((await runStatus(runId))?.status).toBe("running");
  });

  it("times out a provably-dead silent run, and the sweep then clears its lock in the same tick", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    const runId = await seedRunningRun({ companyId, agentId, processPid: DEAD_PID });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const heartbeat = heartbeatService(db);
    const timedOut = await heartbeat.autoTimeoutDeadSilentRuns();
    expect(timedOut.timedOut).toBe(1);
    expect(timedOut.runIds).toEqual([runId]);

    const run = await runStatus(runId);
    expect(run?.status).toBe("timed_out");
    expect(run?.errorCode).toBe("dead_run_auto_timeout");

    // The existing terminal-gated sweep — same recovery tick — now releases the lock.
    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.cleared).toBe(1);
    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.action, "heartbeat.dead_run_auto_timed_out"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("heartbeat.dead_run_auto_timed_out");

    // Agent freed to idle so it can pick up new work.
    const agent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    expect(agent?.status).toBe("idle");
  });

  it("never times out a healthy-but-quiet run whose pid is still alive (OTL-131 guard)", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    // The test process itself is alive — a live pid must never be timed out,
    // no matter how long it has been silent.
    const runId = await seedRunningRun({ companyId, agentId, processPid: process.pid });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const heartbeat = heartbeatService(db);
    for (let tick = 0; tick < 3; tick++) {
      const result = await heartbeat.autoTimeoutDeadSilentRuns();
      expect(result.timedOut).toBe(0);
    }

    expect((await runStatus(runId))?.status).toBe("running");
    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock?.checkoutRunId).toBe(runId); // lock retained
  });

  it("skips a silent run with no process metadata — death cannot be proven", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    const runId = await seedRunningRun({ companyId, agentId, processPid: null });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoTimeoutDeadSilentRuns();

    expect(result.scanned).toBe(1);
    expect(result.timedOut).toBe(0);
    expect((await runStatus(runId))?.status).toBe("running");
  });

  it("skips non-sessioned-local adapters even with a dead pid", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("cursor_cloud");
    const runId = await seedRunningRun({ companyId, agentId, processPid: DEAD_PID });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoTimeoutDeadSilentRuns();

    expect(result.timedOut).toBe(0);
    expect((await runStatus(runId))?.status).toBe("running");
  });

  it("ignores runs that are not yet silent past the TTL", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    // Only 5s of silence — well under the 15m default TTL.
    const runId = await seedRunningRun({ companyId, agentId, processPid: DEAD_PID, ageMs: 5_000 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoTimeoutDeadSilentRuns();

    expect(result.scanned).toBe(0);
    expect((await runStatus(runId))?.status).toBe("running");
  });

  it("is idempotent — a second pass finds nothing left to time out", async () => {
    enable();
    const { companyId, agentId } = await seedCompanyAndAgent("claude_local");
    const runId = await seedRunningRun({ companyId, agentId, processPid: DEAD_PID });
    await seedLockedIssue({ companyId, agentId, runId });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.autoTimeoutDeadSilentRuns();
    const second = await heartbeat.autoTimeoutDeadSilentRuns();
    expect(first.timedOut).toBe(1);
    expect(second.timedOut).toBe(0);
  });
});
