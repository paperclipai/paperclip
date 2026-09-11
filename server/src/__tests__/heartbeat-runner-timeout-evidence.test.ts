import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runner timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("launcher timeout evidence on the legacy process adapter path", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runner-timeout-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runner-timeout-"));
  }, 20_000);

  afterEach(async () => {
    await db.update(agents).set({ status: "paused" });
    await db.update(issues).set({ status: "cancelled" });
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns);
    for (const run of runs) {
      if (run.status === "running" || run.status === "queued") await heartbeat.cancelRun(run.id);
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
  });

  afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueComments);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(budgetPolicies);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function writeScript(name: string, source: string): Promise<string> {
    const scriptPath = path.join(fixtureDir, name);
    await fs.writeFile(scriptPath, source, "utf8");
    return scriptPath;
  }

  async function seedFixture(input: { adapterConfig: Record<string, unknown> }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Runner timeout project" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ContainedRunner",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: input.adapterConfig,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Runner timeout issue",
      description: "Fixture issue for launcher timeout continuation.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "responsible-user",
      identifier: `T-${issueId.slice(0, 6)}`,
    });
    return { companyId, projectId, agentId, issueId };
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  function timeoutContinuationWakes(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.idempotencyKey} LIKE 'runner_timeout_continuation:%'`,
        ),
      );
  }

  it("continues a launcher-timed-out run in its checkpoint session through the bounded continuation", async () => {
    // The launcher times the run out itself (its wall clock is shorter than
    // native's), so the child exits 124 and reports the structured envelope.
    const timeoutScript = await writeScript("launcher-timeout.mjs", `
import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(path.join(fixtureDir, "checkpoint-started"))};
if (existsSync(marker)) {
  // Keep the real successor alive until the test cancels it; no guessed sleep.
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
writeFileSync(marker, "");
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: "run_timeout",
  status: "timed_out",
  runId: process.env.PAPERCLIP_RUN_ID,
  sessionId: "paperclip-fixture-lane",
  modelStarted: true,
  resumable: true,
  progress: { requests: 9, denials: 0, lastEventAt: "2026-03-19T00:04:00.000Z" },
  exitCode: 124,
}) + "\\n");
process.exit(124);
}
`);
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [timeoutScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
      },
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // A launcher-issued timeout is a timeout, not an adapter failure, and the
    // validated envelope is persisted as the run's resumable evidence.
    expect(finishedRun?.status).toBe("timed_out");
    expect(finishedRun?.errorCode).toBe("timeout");
    expect(
      (finishedRun?.resultJson as Record<string, unknown> | null)?.runnerTimeout,
    ).toMatchObject({
      sessionId: "paperclip-fixture-lane",
      modelStarted: true,
      resumable: true,
      progress: { requests: 9, denials: 0, lastRequestAt: "2026-03-19T00:04:00.000Z" },
    });

    await expect.poll(
      () => timeoutContinuationWakes(fixture.companyId, fixture.agentId),
      { timeout: 10_000 },
    ).toHaveLength(1);
    const wakes = await timeoutContinuationWakes(fixture.companyId, fixture.agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `runner_timeout_continuation:${fixture.issueId}:${run!.id}:1`,
    );

    // The continuation resumes the SAME session and advances the bounded
    // attempt counter instead of restarting the task at attempt zero.
    const continuation = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, fixture.companyId),
        eq(heartbeatRuns.retryOfRunId, run!.id),
      ))
      .then((rows) => rows[0] ?? null);
    expect(continuation?.continuationAttempt).toBe(1);
    expect(continuation?.contextSnapshot ?? {}).toMatchObject({
      runnerTimeoutContinuation: true,
      resumeFromCheckpoint: true,
      resumeSessionId: "paperclip-fixture-lane",
    });

    // A second sweep must not mint a second wake for the same attempt.
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await timeoutContinuationWakes(fixture.companyId, fixture.agentId)).toHaveLength(1);
  }, 60_000);

  it("uses both bounded continuations then escalates without a generic restart", async () => {
    const script = await writeScript("repeated-timeout.mjs", `
process.stdout.write(JSON.stringify({
  schemaVersion: 1, kind: "run_timeout", status: "timed_out", exitCode: 124,
  runId: process.env.PAPERCLIP_RUN_ID, sessionId: "bounded-checkpoint",
  modelStarted: true, resumable: true, progress: { requests: 1, denials: 0 },
}) + "\\n");
process.exit(124);
`);
    const fixture = await seedFixture({
      adapterConfig: { command: process.execPath, args: [script], cwd: fixtureDir, timeoutSec: 30 },
    });
    await heartbeat.invoke(fixture.agentId, "assignment", { issueId: fixture.issueId, wakeReason: "issue_assigned" }, "system");
    const listRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId));
    await expect.poll(async () => (await listRuns()).filter((run) => run.status === "timed_out").length, { timeout: 15_000 }).toBe(3);
    await heartbeat.drainActiveRunExecutions();
    expect((await listRuns()).map((run) => run.continuationAttempt).sort()).toEqual([0, 1, 2]);
    expect(await timeoutContinuationWakes(fixture.companyId, fixture.agentId)).toHaveLength(2);
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(await listRuns()).toHaveLength(3);
  }, 60_000);

  it("keeps a bare launcher 124 an ordinary failure without a resumable continuation", async () => {
    const bareScript = await writeScript("bare-124.mjs", `
process.stdout.write("mid-turn worker output\\n");
process.exit(124);
`);
    const fixture = await seedFixture({
      adapterConfig: {
        command: process.execPath,
        args: [bareScript],
        cwd: fixtureDir,
        timeoutSec: 30,
        graceSec: 5,
      },
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // The reserved exit code alone decides nothing: without the run_timeout
    // envelope this stays an ordinary failure with no resumable evidence.
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.errorCode).toBe("adapter_failed");
    expect(
      (finishedRun?.resultJson as Record<string, unknown> | null)?.runnerTimeout,
    ).toBeUndefined();

    await heartbeat.reconcileStrandedAssignedIssues();
    // No bounded session continuation may be fabricated from a bare code.
    expect(await timeoutContinuationWakes(fixture.companyId, fixture.agentId)).toHaveLength(0);
  }, 60_000);
});
