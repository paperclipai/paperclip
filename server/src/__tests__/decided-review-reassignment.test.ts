import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueApprovals,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { executionBlockerPredicate, getExecutionBlocker } from "../services/execution-blocker.js";
import { hasLiveLegacyController, legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { runningProcesses } from "../adapters/index.js";
import { issueService } from "../services/issues.js";
import {
  buildDecidedReviewContinuationWakeup,
  continueDecidedReviewReassignments,
  type DecidedReviewScan,
  currentSubmissionIdentity,
  findConsumption,
  proveDecidedReviewContinuation,
  selectDecidedReviewSource,
} from "../services/decided-review-reassignment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decided review continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CONTROLLER_HELPER = fileURLToPath(new URL("./helpers/legacy-controller-process.ts", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describeEmbeddedPostgres("decided review continuation after an expected reviewer reassignment stop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let scratch: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const priorInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
  // Every process a test starts, killed in afterEach whatever the outcome.
  const ownedPids = new Set<number>();
  const ownedGroups = new Set<number>();
  const ownedChildren = new Set<ChildProcess>();

  beforeAll(async () => {
    // Route handlers build their own heartbeat service from process.env. A
    // local worktree marker would suppress the scheduling under test.
    delete process.env.PAPERCLIP_IN_WORKTREE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decided-review-");
    db = createDb(tempDb.connectionString);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-decided-review-"));
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 30_000);

  async function killOwned() {
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    for (const group of ownedGroups) { try { process.kill(-group, "SIGKILL"); } catch { /* gone */ } }
    for (const pid of ownedPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    for (const child of ownedChildren) child.kill("SIGKILL");
    await waitFor(() => [...ownedPids].every(pid => !isAlive(pid)), 5_000, "owned processes to exit").catch(() => undefined);
    ownedPids.clear(); ownedGroups.clear(); ownedChildren.clear();
  }

  afterEach(async () => {
    await killOwned();
    await heartbeat.drainActiveRunExecutions();
    await db.delete(environmentLeases);
    await db.delete(issueRecoveryActions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await tempDb?.cleanup();
    await fs.rm(scratch, { recursive: true, force: true });
    if (priorInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
    else process.env.PAPERCLIP_IN_WORKTREE = priorInWorktree;
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as any).actor = actor; next(); });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  // Synthetic fixture: an issue already in review. The reviewer uses a local
  // sessioned adapter whose CLI is a script the test controls: it waits for a
  // gate file, then exits 0 without output, so losing its parent cannot break
  // it with SIGPIPE. Probe invocations (no turn arguments) exit at once.
  async function seedReview() {
    const companyId = randomUUID();
    const userId = randomUUID();
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const prefix = `DR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const gate = path.join(scratch, `${randomUUID()}.gate`);
    const cli = path.join(scratch, `${randomUUID()}-reviewer-cli.cjs`);
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require("node:fs");
if (!process.argv.includes("--output-format")) process.exit(0);
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.exit(0); } }, 25);
`, "utf8");
    await fs.chmod(cli, 0o755);
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, runtimeConfig: {}, permissions: {} },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "gemini_local",
        adapterConfig: { engine: "cli", command: cli, cwd: scratch }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review the change", status: "in_review", priority: "medium",
      assigneeAgentId: reviewerId, issueNumber: 1, identifier: `${prefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }] }] },
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId }, returnAssignee: { type: "agent", agentId: authorId },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0,
      },
    });
    return { companyId, userId, authorId, reviewerId, issueId, stageId, gate, cli };
  }
  type Fixture = Awaited<ReturnType<typeof seedReview>>;

  /** Declared synthetic: a running legacy reviewer whose controller crashed.
   * The child is real and owns its process group; the controller boot id is
   * foreign and its lease already expired, as test 1 produces with real time. */
  async function seedDetachedLegacyReviewerRun(f: Fixture) {
    const child = spawn(f.cli, ["--output-format", "stream-json"], { detached: true, stdio: "ignore" });
    ownedChildren.add(child); ownedPids.add(child.pid!); ownedGroups.add(child.pid!);
    const runId = randomUUID();
    const wakeId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.reviewerId, source: "assignment",
      triggerDetail: "system", reason: "execution_review_requested", payload: { issueId: f.issueId }, status: "claimed", runId, claimedAt: startedAt });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: f.companyId, agentId: f.reviewerId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", wakeupRequestId: wakeId, runtimeMode: "legacy", runtimeModeResolvedAt: startedAt, startedAt,
      executionStage: "dispatching", processPid: child.pid!, processGroupId: child.pid!, processStartedAt: startedAt,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() - 1_000),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" },
      responsibleUserId: f.userId,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    return { runId, pid: child.pid!, processGroupId: child.pid! };
  }

  /** Declared seeded: an unrelated newer run of the reviewer on the issue
   * that was dispatched, started and finished. Test 1a checks its shape. */
  async function seedStartedUnrelatedRun(f: Fixture) {
    const wakeId = randomUUID();
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.reviewerId, source: "automation",
      triggerDetail: "system", reason: "issue_commented", payload: { issueId: f.issueId }, status: "completed", runId: id, finishedAt: new Date() });
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.reviewerId, invocationSource: "automation",
      triggerDetail: "system", status: "succeeded", wakeupRequestId: wakeId, runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
      startedAt: new Date(), finishedAt: new Date(), responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" } });
    return id;
  }

  /** Production: the reaper finds a live child without an owning controller. */
  async function reapToDetached(runId: string) {
    await heartbeat.reapOrphanedRuns();
    const run = await heartbeat.getRun(runId);
    expect(run).toMatchObject({ status: "running", errorCode: "process_detached" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some(event => (event.payload as Record<string, unknown> | null)?.ownedProcessHandle === false)).toBe(true);
  }

  /** Production: the reviewer requests changes as R, which reassigns the task
   * to the author and stops R through the same mutation. */
  async function recordDecision(f: Fixture, runId: string) {
    const response = await request(app({ type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.reviewerId, runId }))
      .patch(`/api/issues/${f.issueId}`).send({ status: "in_progress", comment: "Please handle the empty input case." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const run = (await heartbeat.getRun(runId))!;
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(run.resultJson).toMatchObject({ reassignmentStopConfirmed: true, issueMutationStopId: expect.any(String),
      cancellation: { source: "control_plane", expected: true } });
    const [decision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(decision).toMatchObject({ createdByRunId: runId, outcome: "changes_requested", actorAgentId: f.reviewerId });
    // The real cancel-time hold exists, and source revalidation retires it when
    // the task moves to the author.
    const [cancelTimeHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.fingerprint, `legacy-execution:${runId}`));
    expect(cancelTimeHold).toMatchObject({ status: "cancelled" });
    return decision!;
  }

  /** The explicit physical stop. Records whether the cancel already ended the
   * child; otherwise the gate opens and the child exits on its own. Afterwards
   * nothing blocks the task. */
  async function stopReviewerChild(f: Fixture, pid: number, processGroupId: number) {
    const endedByCancel = !isAlive(pid) && !isAlive(-processGroupId);
    await fs.writeFile(f.gate, "open");
    await waitFor(() => !isAlive(pid) && !isAlive(-processGroupId), 5_000, "reviewer child to exit");
    // Production: the lease sweeps release what the dead controller held.
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    return { endedByCancel };
  }

  /** Production: the decision woke the author, whose real run resubmits.
   * The reported incident shows no reviewer run between the resubmission and
   * the Board comment, so its review request was never admitted. Declared
   * stand-in for that unobserved cause: the scheduling gate suppresses the
   * request (a skipped receipt, no run). Without it the request starts a
   * reviewer run and nothing needs recovery. */
  async function resubmitWithSuppressedReviewRequest(f: Fixture) {
    let authorRunId = "";
    // When the decision landed while R's detached child still ran, the
    // author's decision wake was skipped behind it. The production stranded
    // assignee scan wakes the author once nothing blocks the task.
    if (!(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.authorId))).length) {
      await scan();
      await heartbeat.resumeQueuedRuns();
    }
    await waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, f.authorId), eq(heartbeatRuns.status, "running"),
      ));
      authorRunId = run?.id ?? "";
      return Boolean(run?.processPid);
    }, 10_000, "the author's run to start").catch(async error => {
      const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
        .from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.authorId));
      const wakes = await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason, error: agentWakeupRequests.error })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.authorId));
      throw new Error(`${(error as Error).message}: ${JSON.stringify({ runs, wakes })}`);
    });
    const resubmittedAt = new Date();
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    try {
      const response = await request(app({ type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.authorId, runId: authorRunId }))
        .patch(`/api/issues/${f.issueId}`).send({ status: "done", comment: "Handled the empty input case." });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // The route sends the review request after responding.
      await waitFor(async () => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, f.reviewerId), eq(agentWakeupRequests.reason, "heartbeat.scheduling_suppressed"),
      ))).length === 1, 5_000, "the suppressed review request");
    } finally {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    }
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewerId });
    expect(await heartbeat.getRun(authorRunId)).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(await reviewerRunsAfter(f, resubmittedAt)).toEqual([]);
    return { resubmittedAt, authorRunId };
  }

  async function snapshotReviewHistory(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    return {
      executionState: task!.executionState,
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))
        .orderBy(asc(issueExecutionDecisions.createdAt)),
    };
  }

  async function reviewerRunsAfter(f: Fixture, after: Date) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, f.reviewerId), gt(heartbeatRuns.createdAt, after),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
    )).orderBy(asc(heartbeatRuns.createdAt));
  }

  async function scan() { return heartbeat.reconcileStrandedAssignedIssues(); }
  async function sweep() { return settleUnrecoverableExecutions(db); }
  async function pass() { return continueDecidedReviewReassignments(db, heartbeat.wakeup); }

  /** Let every admitted run finish, then let release/promotion settle. */
  async function drain(f: Fixture) {
    await waitFor(async () => {
      const live = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
        sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
      ));
      return live.length === 0;
    }, 15_000, "issue runs to finish");
    await heartbeat.drainActiveRunExecutions();
    const deferred = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`,
    ));
    expect(deferred).toEqual([]);
  }

  /** Execution holds that keep reviewer dispatch blocked. */
  async function blockingHolds(f: Fixture) {
    return db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, f.issueId), executionBlockerPredicate(),
    ));
  }

  /** Exactly one reviewer turn was admitted for the resubmission. A turn
   * that ends without a decision keeps baseline follow-ups (retries of that
   * turn); those descend from it and are not further continuations. Parked
   * attempts the stale gate cancelled before dispatch never ran. */
  async function expectOneSuccessor(f: Fixture, after: Date) {
    const runs = (await reviewerRunsAfter(f, after)).filter(run => run.errorCode !== "execution_reconciliation_required");
    const roots = runs.filter(run => !run.retryOfRunId);
    expect(roots).toHaveLength(1);
    const successor = roots[0]!;
    const lineage = new Set([successor.id]);
    for (const run of runs) if (run.retryOfRunId && lineage.has(run.retryOfRunId)) lineage.add(run.id);
    expect(runs.filter(run => !lineage.has(run.id))).toEqual([]);
    expect(successor.contextSnapshot?.decidedReviewContinuation).toBeTruthy();
    return successor;
  }

  async function expectSingleContinuation(f: Fixture, input: {
    resubmittedAt: Date; history: Awaited<ReturnType<typeof snapshotReviewHistory>>; sourceRunId: string;
  }) {
    const successor = await expectOneSuccessor(f, input.resubmittedAt);
    expect(successor.contextSnapshot).toMatchObject({
      forceFreshSession: true,
      decidedReviewContinuation: { sourceRunId: input.sourceRunId, decisionId: input.history.decisions.at(-1)!.id },
    });
    expect(successor.contextSnapshot).not.toHaveProperty("previousRunId");
    expect(await blockingHolds(f)).toEqual([]);
    const settled = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ));
    expect(settled.length).toBeGreaterThan(0);
    for (const hold of settled) {
      expect(hold.evidence.decidedReviewContinuation).toMatchObject({ sourceRunId: input.sourceRunId, successorRunId: successor.id });
    }
    expect(await db.select().from(issueComments).where(and(
      eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "user"),
    ))).toEqual([]);
    expect(await snapshotReviewHistory(f)).toEqual(input.history);
    return successor;
  }

  it("continues the review once after a detached reviewer recorded its decision and was stopped by reassignment", async () => {
    const f = await seedReview();
    // Real launch in a separate controller process, so its in-memory process
    // tracking and lease renewal really disappear when that process dies.
    const controller = spawn(process.execPath, ["--import", "tsx", CONTROLLER_HELPER], {
      cwd: SERVER_ROOT,
      stdio: ["ignore", "pipe", "inherit", "ipc"],
      env: { ...process.env, PAPERCLIP_IN_WORKTREE: "", DECIDED_REVIEW_DATABASE_URL: tempDb!.connectionString,
        DECIDED_REVIEW_AGENT_ID: f.reviewerId, DECIDED_REVIEW_ISSUE_ID: f.issueId },
    });
    ownedChildren.add(controller); ownedPids.add(controller.pid!);
    const ready = await new Promise<{ runId: string; pid: number; processGroupId: number }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("controller did not report a running reviewer")), 30_000);
      controller.stdout!.on("data", chunk => {
        buffer += String(chunk);
        const line = buffer.split("\n").find(entry => entry.trim().startsWith("{"));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
      controller.once("exit", code => { clearTimeout(timer); reject(new Error(`controller exited early: ${code}`)); });
    });
    ownedPids.add(ready.pid); ownedGroups.add(ready.processGroupId);
    const runId = ready.runId;
    // This process never launched R, and the controller still owns it.
    expect(runningProcesses.has(runId)).toBe(false);
    const launched = (await heartbeat.getRun(runId))!;
    expect(await hasLiveLegacyController(db, launched)).toBe(true);

    const controllerExit = new Promise(resolve => controller.once("exit", resolve));
    controller.kill("SIGKILL");
    await controllerExit;
    expect(isAlive(ready.pid)).toBe(true);
    expect(isAlive(-ready.processGroupId)).toBe(true);
    const leaseAtKill = (await heartbeat.getRun(runId))!.controllerLeaseExpiresAt;
    await waitFor(async () => !(await hasLiveLegacyController(db, (await heartbeat.getRun(runId))!)), 75_000, "controller lease to expire");
    expect((await heartbeat.getRun(runId))!.controllerLeaseExpiresAt).toEqual(leaseAtKill);

    await reapToDetached(runId);
    expect(await heartbeat.getRun(runId)).toMatchObject({ processPid: ready.pid, processGroupId: ready.processGroupId });

    await recordDecision(f, runId);
    await stopReviewerChild(f, ready.pid, ready.processGroupId);
    await sweep();
    const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
    const history = await snapshotReviewHistory(f);

    await scan();
    await pass();
    // Admitted while still in review: the sweep has nothing left to block.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe("in_review");
    await sweep();
    await drain(f);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
    await drain(f);

    await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: runId });
  }, 120_000);

  it("restores and continues a review the sweep blocked for the decided reviewer", async () => {
    const f = await seedReview();
    const r = await seedDetachedLegacyReviewerRun(f);
    await reapToDetached(r.runId);
    await recordDecision(f, r.runId);
    await stopReviewerChild(f, r.pid, r.processGroupId);
    // The environment has not finished releasing, so the stop is not proved yet.
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" }).returning();
    const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
    const history = await snapshotReviewHistory(f);

    await scan();
    await sweep();
    const [blocked] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(blocked!.status).toBe("blocked");
    const [hold] = await blockingHolds(f);
    expect(hold!.evidence.reviewHoldBlock).toEqual({
      runId: r.runId, statusVersion: blocked!.statusVersion, previousStatus: "in_review",
      stageId: f.stageId, lastDecisionId: history.decisions[0]!.id,
    });
    await pass();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe("blocked");
    expect(await reviewerRunsAfter(f, resubmittedAt)).toEqual([]);

    await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease!.id));
    await pass();
    const [restored] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(restored!.status).toBe("in_review");
    expect(restored!.executionState).toEqual(history.executionState);
    await drain(f);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
    await drain(f);
    await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: r.runId });
  }, 60_000);

  it.each([
    ["the task was already blocked", async (f: Fixture) => {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    }],
    ["the stopped reviewer run is native", async (_f: Fixture, runId: string) => patchRun(runId, () => ({ runtimeMode: "native" }))],
  ])("records no review projection receipt when %s", async (_label, change) => {
    const f = await seedReview();
    const r = await seedDetachedLegacyReviewerRun(f);
    await reapToDetached(r.runId);
    await recordDecision(f, r.runId);
    await stopReviewerChild(f, r.pid, r.processGroupId);
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" });
    await resubmitWithSuppressedReviewRequest(f);
    await scan();
    expect(await blockingHolds(f)).toHaveLength(1);
    const [held] = await blockingHolds(f);
    expect(held!.evidence.runId).toBe(r.runId);
    await change(f, r.runId);
    await sweep();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, held!.id));
    expect((await readTask(f)).status).toBe("blocked");
    expect(hold!.evidence.automaticRecovery).toMatchObject({ policy: "preserve_without_replay_v1" });
    expect(hold!.evidence).not.toHaveProperty("reviewHoldBlock");
  }, 60_000);

  it.each(["held by the decided reviewer only", "also held by a pre-fix hold on the parked attempt"])(
    "keeps the decided reviewer as the source when parked attempts exist (%s)",
    async (variant) => {
      const f = await seedReview();
      const r = await seedDetachedLegacyReviewerRun(f);
      await reapToDetached(r.runId);
      await recordDecision(f, r.runId);
      await stopReviewerChild(f, r.pid, r.processGroupId);
      const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" }).returning();
      const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
      const history = await snapshotReviewHistory(f);
      await scan();
      const [rHold] = await blockingHolds(f);
      expect(rHold!.evidence.runId).toBe(r.runId);

      // Declared seeded: a reviewer attempt already queued when the hold is
      // observed. Its cancellation runs through the real dispatch gate.
      const seedQueued = async () => {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.reviewerId, invocationSource: "assignment",
          triggerDetail: "system", status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" },
          responsibleUserId: f.userId });
        return id;
      };
      const q1 = await seedQueued();
      await heartbeat.resumeQueuedRuns();
      const cancelledQ1 = (await heartbeat.getRun(q1))!;
      expect(cancelledQ1).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null });
      expect(cancelledQ1.resultJson).toMatchObject({ stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        executionWait: { issueId: f.issueId, recoveryActionId: rHold!.id } });
      if (variant !== "held by the decided reviewer only") {
        // Declared seeded: the hold pre-fix scans put on the parked attempt.
        await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
          status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: f.reviewerId,
          cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${q1}`,
          nextAction: "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing.",
          evidence: { runId: q1, originalFailureCode: "execution_reconciliation_required", adapterRecovery: "unsupported_or_unknown", attempt: 1,
            automaticRecovery: { policy: "preserve_without_replay_v1", runId: q1, replay: "blocked", actionOutcome: "unknown", recordedAt: new Date().toISOString() } },
          resolvedAt: new Date() });
        const q2 = await seedQueued();
        const gateBlocker = await getExecutionBlocker(db, f.companyId, f.issueId);
        await heartbeat.resumeQueuedRuns();
        const cancelledQ2 = (await heartbeat.getRun(q2))!;
        expect(cancelledQ2).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required" });
        // Chained to whichever hold the gate returned.
        expect(cancelledQ2.resultJson).toMatchObject({ executionWait: { issueId: f.issueId, recoveryActionId: gateBlocker!.recoveryActionId } });
      }
      const holdIdsBefore = (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(row => row.id);

      for (let i = 0; i < 3; i += 1) await scan();
      await sweep();
      await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease!.id));
      await heartbeat.resumeQueuedRuns();
      await pass();
      await drain(f);
      for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
      await drain(f);

      const created = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.sourceIssueId, f.issueId), sql`${issueRecoveryActions.fingerprint} like 'legacy-execution:%'`,
      ));
      expect(created.filter(hold => !holdIdsBefore.includes(hold.id))).toEqual([]);
      const successor = await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: r.runId });
      for (const hold of created.filter(row => row.evidence.decidedReviewContinuation && row.evidence.runId !== r.runId)) {
        expect(hold.evidence.automaticRecovery).toMatchObject({ actionOutcome: "not_performed" });
        expect(hold.evidence.decidedReviewContinuation).toMatchObject({ successorRunId: successor.id });
      }
    },
    60_000,
  );

  /** Shared base for the remaining cases: the seeded detached R recorded its
   * decision and stopped, the author resubmitted, and R's environment lease is
   * still held, so the post-resubmission scan holds R exactly as today. */
  async function heldBase() {
    const f = await seedReview();
    const r = await seedDetachedLegacyReviewerRun(f);
    await reapToDetached(r.runId);
    const decision = await recordDecision(f, r.runId);
    await stopReviewerChild(f, r.pid, r.processGroupId);
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" }).returning();
    const { resubmittedAt, authorRunId } = await resubmitWithSuppressedReviewRequest(f);
    const history = await snapshotReviewHistory(f);
    await scan();
    const [hold] = await blockingHolds(f);
    expect(hold!.evidence.runId).toBe(r.runId);
    const releaseLease = async () => {
      await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease!.id));
    };
    return { f, r, decision, hold: hold!, resubmittedAt, authorRunId, history, releaseLease };
  }
  type HeldBase = Awaited<ReturnType<typeof heldBase>>;

  /** Reviewer runs that executed (or wait to) after the resubmission. Parked
   * attempts the stale gate cancelled before dispatch are not turns. */
  async function reviewerTurnsAfter(f: Fixture, after: Date) {
    return (await reviewerRunsAfter(f, after)).filter(run => run.errorCode !== "execution_reconciliation_required");
  }

  async function expectHeldWithoutSuccessor(b: HeldBase, seededRunIds: string[] = []) {
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); }
    expect((await blockingHolds(b.f)).length).toBeGreaterThan(0);
    expect((await reviewerTurnsAfter(b.f, b.resubmittedAt)).filter(run => !seededRunIds.includes(run.id))).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, b.f.issueId), sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ))).toEqual([]);
  }

  async function readTask(f: Fixture) {
    return (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  }

  /** The real sweep projects the held review to blocked and records its receipt. */
  async function sweepToBlocked(b: HeldBase) {
    await sweep();
    const blocked = await readTask(b.f);
    expect(blocked.status).toBe("blocked");
    const receipt = (await blockingHolds(b.f))[0]!.evidence.reviewHoldBlock as { statusVersion: number };
    expect(receipt.statusVersion).toBe(blocked.statusVersion);
    return receipt;
  }

  it.each([
    ["a human reasserts blocked", async (b: HeldBase) => {
      await issueService(db).update(b.f.issueId, { status: "blocked" });
    }],
    ["a human unblocks, then blocks again", async (b: HeldBase) => {
      await issueService(db).update(b.f.issueId, { status: "in_review" });
      await issueService(db).update(b.f.issueId, { status: "blocked" });
    }],
    ["a human sets a blocker", async (b: HeldBase) => {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: b.f.companyId, title: "Blocker", status: "todo", priority: "medium",
        issueNumber: 2, identifier: `${b.f.issueId.slice(0, 4)}-2` });
      await issueService(db).update(b.f.issueId, { blockedByIssueIds: [blockerId] });
    }],
    ["the task is reassigned away and back", async (b: HeldBase) => {
      await issueService(db).update(b.f.issueId, { assigneeAgentId: b.f.authorId });
      await issueService(db).update(b.f.issueId, { assigneeAgentId: b.f.reviewerId });
    }],
  ])("keeps a sweep-blocked review held after %s", async (_label, change) => {
    const b = await heldBase();
    const receipt = await sweepToBlocked(b);
    await change(b);
    await b.releaseLease();
    await expectHeldWithoutSuccessor(b);
    const task = await readTask(b.f);
    expect(task.status).toBe("blocked");
    expect(task.statusVersion).not.toBe(receipt.statusVersion);
  }, 60_000);

  it("keeps a pre-fix block without a projection receipt held", async () => {
    const b = await heldBase();
    await sweepToBlocked(b);
    // Declared seeded: the same hold as written by the pre-fix sweep, which had no receipt.
    for (const hold of await blockingHolds(b.f)) {
      const { reviewHoldBlock: _receipt, ...evidence } = hold.evidence;
      await db.update(issueRecoveryActions).set({ evidence }).where(eq(issueRecoveryActions.id, hold.id));
    }
    await b.releaseLease();
    await expectHeldWithoutSuccessor(b);
    expect((await readTask(b.f)).status).toBe("blocked");
  }, 60_000);

  /** Declared seeded reviewer run on the issue, newer than R. */
  async function seedReviewerRun(b: HeldBase, values: Partial<typeof heartbeatRuns.$inferInsert>) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: b.f.companyId, agentId: b.f.reviewerId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued", contextSnapshot: { issueId: b.f.issueId, taskId: b.f.issueId, wakeReason: "execution_review_requested" },
      responsibleUserId: b.f.userId, ...values });
    return id;
  }

  it.each([
    ["a newer reviewer run that started", async (b: HeldBase) =>
      seedReviewerRun(b, { status: "succeeded", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date() })],
    ["a newer reviewer run cancelled for another reason", async (b: HeldBase) =>
      seedReviewerRun(b, { status: "cancelled", runtimeMode: "legacy", errorCode: "cancelled", finishedAt: new Date() })],
    ["a parked attempt chained to a foreign hold", async (b: HeldBase) => {
      await seedReviewerRun(b, { status: "cancelled", runtimeMode: "legacy", errorCode: "execution_reconciliation_required", finishedAt: new Date(),
        resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
          executionWait: { issueId: b.f.issueId, recoveryActionId: randomUUID() } } });
    }],
    ["a queued run of another agent on the issue", async (b: HeldBase) => {
      await db.insert(heartbeatRuns).values({ companyId: b.f.companyId, agentId: b.f.authorId, invocationSource: "assignment",
        triggerDetail: "system", status: "queued", contextSnapshot: { issueId: b.f.issueId }, responsibleUserId: b.f.userId });
    }],
    ["another cause's execution hold on the issue", async (b: HeldBase) => {
      // Only one hold per issue may be active, so the foreign one is resolved but still blocks replay.
      await db.insert(issueRecoveryActions).values({ companyId: b.f.companyId, sourceIssueId: b.f.issueId, kind: "active_run_watchdog",
        status: "resolved", outcome: "blocked", resolvedAt: new Date(), ownerType: "board", returnOwnerAgentId: b.f.reviewerId,
        cause: "uncertain_provider_action", fingerprint: `other:${randomUUID()}`, nextAction: "Reconcile the provider action.",
        evidence: { runId: randomUUID(), automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" } } });
    }],
    ["a parked attempt whose environment lease is not released", async (b: HeldBase) => {
      const q = await seedReviewerRun(b, {});
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(q)).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required" });
      await db.insert(environmentLeases).values({ companyId: b.f.companyId, issueId: b.f.issueId, heartbeatRunId: q, provider: "local" });
    }],
  ])("keeps the review held for %s", async (_label, change) => {
    const b = await heldBase();
    const seeded = await change(b);
    await b.releaseLease();
    await expectHeldWithoutSuccessor(b, typeof seeded === "string" ? [seeded] : []);
  }, 60_000);

  async function patchRun(runId: string, change: (run: typeof heartbeatRuns.$inferSelect) => Partial<typeof heartbeatRuns.$inferInsert>) {
    const run = (await heartbeat.getRun(runId))!;
    await db.update(heartbeatRuns).set(change(run)).where(eq(heartbeatRuns.id, runId));
  }

  async function patchState(b: HeldBase, change: Record<string, unknown>) {
    const task = await readTask(b.f);
    await db.update(issues).set({ executionState: { ...(task.executionState as Record<string, unknown>), ...change } as any })
      .where(eq(issues.id, b.f.issueId));
  }

  it.each([
    ["1: the task is not in review", async (b: HeldBase) => {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, b.f.issueId));
    }],
    ["2: the current stage is not a review", async (b: HeldBase) => patchState(b, { currentStageType: "approval" })],
    ["2: there is no current stage", async (b: HeldBase) => patchState(b, { currentStageId: null })],
    ["2: another agent is the current participant", async (b: HeldBase) => patchState(b, {
      currentParticipant: { type: "agent", agentId: b.f.authorId },
    })],
    ["3: no last decision is recorded", async (b: HeldBase) => patchState(b, { lastDecisionId: null })],
    ["3: the decision was recorded by another agent's run", async (b: HeldBase) => {
      await db.update(issueExecutionDecisions).set({ createdByRunId: b.authorRunId }).where(eq(issueExecutionDecisions.id, b.decision.id));
    }],
    ["4: no resubmission follows the decision", async (b: HeldBase) => {
      await db.delete(activityLog).where(and(eq(activityLog.entityId, b.f.issueId), eq(activityLog.action, "issue.updated"),
        eq(activityLog.actorId, b.f.authorId)));
    }],
  ])("has no submission identity when only condition %s", async (_label, change) => {
    const b = await heldBase();
    expect(await readIdentity(b.f)).toEqual({ decisionId: b.decision.id, resubmissionActivityId: expect.any(String) });
    await change(b);
    expect(await readIdentity(b.f)).toBeNull();
  }, 60_000);

  const failingClause: Record<string, string> = {
    "the decision was recorded by another run": "selector_decision_run_not_participant",
    "the decision is not the last decision": "selector_decision_not_changes_requested",
    "the decision predates the stop": "P3_decision_provenance",
    "a newer decision exists for the stage": "P3_later_decision",
    "the author never resubmitted": "P5_no_resubmission",
    "the resubmission came from the stopped reviewer run": "P5_no_resubmission",
    "a user cancelled the reviewer": "P1_not_expected_reassignment_stop",
    "the reviewer ended for another reason": "P1_not_expected_reassignment_stop",
    "the reassignment stop is not confirmed": "P1_not_expected_reassignment_stop",
    "the reviewer process is still alive": "P2_process_running",
    "the reviewer's environment lease is not released": "P2_lease_unreleased",
    "a pending interaction awaits a person": "P6_decision_pending",
    "a linked approval awaits a person": "P6_decision_pending",
    "a blocking dependency is unresolved": "P6_dependency",
    "another agent is the current participant": "selector_decision_run_not_participant",
    "the current stage is an approval": "P4_not_pending_review",
    "the hold is already being reconciled": "P7_already_owned",
    "the hold records a workspace restore failure": "P7_already_owned",
    "the task is done": "P4_task_closed",
    "the task is cancelled": "P4_task_closed",
  };

  it.each([
    ["the decision was recorded by another run", async (b: HeldBase) => {
      await db.update(issueExecutionDecisions).set({ createdByRunId: b.authorRunId }).where(eq(issueExecutionDecisions.id, b.decision.id));
    }],
    ["the decision is not the last decision", async (b: HeldBase) => patchState(b, { lastDecisionId: null })],
    ["the decision predates the stop", async (b: HeldBase) => {
      const run = (await heartbeat.getRun(b.r.runId))!;
      await db.update(issueExecutionDecisions).set({ createdAt: new Date(run.finishedAt!.getTime() - 1_000) })
        .where(eq(issueExecutionDecisions.id, b.decision.id));
    }],
    ["a newer decision exists for the stage", async (b: HeldBase) => {
      const { id: _id, ...decision } = b.decision;
      await db.insert(issueExecutionDecisions).values({ ...decision, createdAt: new Date() });
    }],
    ["the author never resubmitted", async (b: HeldBase) => {
      await db.delete(activityLog).where(and(eq(activityLog.entityId, b.f.issueId), eq(activityLog.action, "issue.updated"),
        eq(activityLog.actorId, b.f.authorId)));
    }],
    ["the resubmission came from the stopped reviewer run", async (b: HeldBase) => {
      await db.update(activityLog).set({ runId: b.r.runId }).where(and(eq(activityLog.entityId, b.f.issueId),
        eq(activityLog.action, "issue.updated"), eq(activityLog.actorId, b.f.authorId)));
    }],
    ["a user cancelled the reviewer", async (b: HeldBase) => patchRun(b.r.runId, run => ({
      resultJson: { ...run.resultJson, cancellation: { ...(run.resultJson!.cancellation as object), initiator: { type: "user", id: b.f.userId } } },
    }))],
    ["the reviewer ended for another reason", async (b: HeldBase) => patchRun(b.r.runId, () => ({ errorCode: "cancelled" }))],
    ["the reassignment stop is not confirmed", async (b: HeldBase) => patchRun(b.r.runId, run => {
      const { reassignmentStopConfirmed: _confirmed, ...resultJson } = run.resultJson!;
      return { resultJson };
    })],
    ["the reviewer process is still alive", async (b: HeldBase) => {
      const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      ownedChildren.add(alive); ownedPids.add(alive.pid!); ownedGroups.add(alive.pid!);
      await patchRun(b.r.runId, () => ({ processPid: alive.pid!, processGroupId: alive.pid! }));
    }],
    ["the reviewer's environment lease is not released", async (_b: HeldBase) => "keep_lease" as const],
    ["a pending interaction awaits a person", async (b: HeldBase) => {
      await db.insert(issueThreadInteractions).values({ companyId: b.f.companyId, issueId: b.f.issueId, kind: "request_confirmation",
        status: "pending", payload: { version: 1, prompt: "Proceed?" } as any });
    }],
    ["a linked approval awaits a person", async (b: HeldBase) => {
      const [approval] = await db.insert(approvals).values({ companyId: b.f.companyId, type: "hire_agent",
        payload: {} }).returning();
      await db.insert(issueApprovals).values({ companyId: b.f.companyId, issueId: b.f.issueId, approvalId: approval!.id });
    }],
    ["a blocking dependency is unresolved", async (b: HeldBase) => {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: b.f.companyId, title: "Dependency", status: "todo", priority: "medium",
        issueNumber: 2, identifier: `${b.f.issueId.slice(0, 4)}-2` });
      await db.insert(issueRelations).values({ companyId: b.f.companyId, issueId: blockerId, relatedIssueId: b.f.issueId, type: "blocks" });
    }],
    ["another agent is the current participant", async (b: HeldBase) => patchState(b, {
      currentParticipant: { type: "agent", agentId: b.f.authorId },
    })],
    ["the current stage is an approval", async (b: HeldBase) => patchState(b, { currentStageType: "approval" })],
    ["the hold is already being reconciled", async (b: HeldBase) => {
      await db.update(issueRecoveryActions).set({ evidence: { ...b.hold.evidence, executionReconciliation: { recordedAt: new Date().toISOString() } } })
        .where(eq(issueRecoveryActions.id, b.hold.id));
    }],
    ["the hold records a workspace restore failure", async (b: HeldBase) => {
      await db.update(issueRecoveryActions).set({ evidence: { ...b.hold.evidence, workspaceRestoreFailure: "restore_unsafe_archive" } })
        .where(eq(issueRecoveryActions.id, b.hold.id));
    }],
    ["the task is done", async (b: HeldBase) => { await db.update(issues).set({ status: "done" }).where(eq(issues.id, b.f.issueId)); }],
    ["the task is cancelled", async (b: HeldBase) => { await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, b.f.issueId)); }],
  ])("does not continue when %s", async (label, change) => {
    const b = await heldBase();
    const keep = await change(b);
    if (keep !== "keep_lease") await b.releaseLease();
    const proof = await proveDecidedReviewContinuation(db, { task: await readTask(b.f) });
    // Each counter-example fails at its own proof clause or selection rule.
    expect(proof.kind === "hold" ? proof.reason : proof.kind).toBe(failingClause[label]);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); }
    expect(await reviewerTurnsAfter(b.f, b.resubmittedAt)).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, b.f.issueId), sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ))).toEqual([]);
    const task = await readTask(b.f);
    if (!["done", "cancelled"].includes(task.status)) expect((await blockingHolds(b.f)).length).toBeGreaterThan(0);
  }, 60_000);


  /** The author's review request exactly as the route's private stage-wake
   * builder produced it, rebuilt from its durable suppressed receipt. */
  async function authorReviewRequest(f: Fixture) {
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.reviewerId), eq(agentWakeupRequests.reason, "heartbeat.scheduling_suppressed"),
    ));
    const { heartbeatSkip: _skip, ...payload } = receipt!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ issueId: f.issueId, mutation: "update" });
    return {
      source: receipt!.source as "assignment", triggerDetail: receipt!.triggerDetail as "system",
      reason: "execution_review_requested", payload,
      requestedByActorType: receipt!.requestedByActorType as "agent", requestedByActorId: receipt!.requestedByActorId!,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested",
        source: "issue.execution_stage", executionStage: payload.executionStage },
    };
  }

  async function readIdentity(f: Fixture) {
    const task = await readTask(f);
    return currentSubmissionIdentity(db, task, f.reviewerId);
  }

  async function wakesWithReason(f: Fixture, reason: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.reviewerId), eq(agentWakeupRequests.reason, reason),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`,
    ));
  }

  it("admits one successor when every entry path races, folding a parked comment into it", async () => {
    const b = await heldBase();
    const comment = await request(app({ type: "agent", source: "agent_key", companyId: b.f.companyId, agentId: b.f.authorId, runId: b.authorRunId }))
      .post(`/api/issues/${b.f.issueId}/comments`).send({ body: "One more note for the reviewer." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await waitFor(async () => (await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ))).length === 1, 5_000, "the parked comment wake");
    await b.releaseLease();
    const w2 = await authorReviewRequest(b.f);
    // The author's request, the parked comment's promotion, two scans and two passes.
    await Promise.all([heartbeat.wakeup(b.f.reviewerId, w2), heartbeat.resumeQueuedRuns(), scan(), scan(), pass(), pass()]);
    await drain(b.f);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
    await drain(b.f);

    const successor = await expectSingleContinuation(b.f, { resubmittedAt: b.resubmittedAt, history: b.history, sourceRunId: b.r.runId });
    expect((await db.select().from(activityLog).where(and(eq(activityLog.entityId, b.f.issueId),
      eq(activityLog.action, "issue.execution_recovery_settled"),
      sql`${activityLog.details}->>'continuation' = 'decided_review_reassignment'`)))).toHaveLength(1);
    const [parked] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), eq(agentWakeupRequests.reason, "issue_commented"),
    ));
    expect(parked).toMatchObject({ status: "coalesced", runId: successor.id });
    expect(successor.contextSnapshot?.wakeCommentIds).toContain(comment.body.id);
  }, 60_000);

  /** A pass whose wake waits at a barrier after its proof transaction committed. */
  function gatedPass() {
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>(resolve => { entered = resolve; });
    const releaseP = new Promise<void>(resolve => { release = resolve; });
    let carried: Record<string, unknown> | null = null;
    const done = continueDecidedReviewReassignments(db, async (agentId, options) => {
      carried = options.payload.decidedReviewContinuation;
      entered();
      await releaseP;
      return heartbeat.wakeup(agentId, options);
    });
    return { entered: enteredP, release, done, carried: () => carried };
  }

  it.each(["a second pass", "the author's own review request"])(
    "records a late pass as consumed after the successor admitted by %s finished",
    async (admitter) => {
      const b = await heldBase();
      await b.releaseLease();
      const late = gatedPass();
      await late.entered;
      if (admitter === "a second pass") await pass();
      else await heartbeat.wakeup(b.f.reviewerId, await authorReviewRequest(b.f));
      await drain(b.f);
      const successor = await expectOneSuccessor(b.f, b.resubmittedAt);
      // The selector no longer picks R, but the submission is unchanged.
      expect(await selectDecidedReviewSource(db, await readTask(b.f))).toMatchObject({ kind: "none" });
      expect(await readIdentity(b.f)).toMatchObject({ decisionId: b.decision.id });
      expect(late.carried()).toMatchObject(await readIdentity(b.f) as object);
      late.release();
      await late.done;

      expect(await wakesWithReason(b.f, "decided_review_continuation_consumed")).toEqual([
        expect.objectContaining({ status: "skipped", payload: expect.objectContaining({
          decidedReviewContinuationOutcome: expect.objectContaining({ successorRunId: successor.id }) }) }),
      ]);
      // A delayed copy of the author's request is consumed the same way.
      await heartbeat.wakeup(b.f.reviewerId, await authorReviewRequest(b.f));
      expect(await wakesWithReason(b.f, "decided_review_continuation_consumed")).toHaveLength(2);
      await drain(b.f);
      expect((await expectOneSuccessor(b.f, b.resubmittedAt)).id).toBe(successor.id);
    },
    60_000,
  );

  it("coalesces a late pass into a successor that is still running", async () => {
    const b = await heldBase();
    await fs.rm(b.f.gate, { force: true });
    await b.releaseLease();
    const late = gatedPass();
    await late.entered;
    await pass();
    const [successor] = await reviewerTurnsAfter(b.f, b.resubmittedAt);
    await waitFor(async () => (await heartbeat.getRun(successor!.id))?.status === "running" &&
      (await readTask(b.f)).executionRunId === successor!.id, 10_000, "the successor to run");
    expect(await selectDecidedReviewSource(db, await readTask(b.f))).toMatchObject({ kind: "none" });
    late.release();
    await late.done;
    const coalesced = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), eq(agentWakeupRequests.status, "coalesced"),
      sql`${agentWakeupRequests.payload} ? 'decidedReviewContinuation'`,
    ));
    expect(coalesced).toEqual([expect.objectContaining({ runId: successor!.id })]);
    await fs.writeFile(b.f.gate, "open");
    await drain(b.f);
    expect((await expectOneSuccessor(b.f, b.resubmittedAt)).id).toBe(successor!.id);
  }, 60_000);

  it("leaves an unconsumed submission held when a newer started run breaks the source chain", async () => {
    const b = await heldBase();
    const u = await seedStartedUnrelatedRun(b.f);

    // Preconditions under the issue lock: held, unconsumed, selector rejects U.
    const pre = await db.transaction(async tx => {
      const [task] = await tx.select().from(issues).where(eq(issues.id, b.f.issueId)).for("update");
      const identity = await currentSubmissionIdentity(tx as any, task!, b.f.reviewerId);
      return {
        blocker: await getExecutionBlocker(tx as any, b.f.companyId, b.f.issueId),
        identity, consumed: identity ? await findConsumption(tx as any, task!, identity) : "no identity",
        selected: await selectDecidedReviewSource(tx as any, task!, identity),
        task: task!,
      };
    });
    expect(pre.blocker).toMatchObject({ recoveryActionId: b.hold.id });
    expect(pre.identity).toEqual({ decisionId: b.decision.id, resubmissionActivityId: expect.any(String) });
    expect(pre.consumed).toBeNull();
    expect(pre.selected).toEqual({ kind: "none", rule: "newer_run_not_verified_pre_dispatch_wait", runId: u });
    const holdsBefore = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, b.f.issueId));
    const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, b.f.reviewerId));
    const wakeIdsBefore = new Set((await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, b.f.reviewerId))).map(row => row.id));

    await heartbeat.wakeup(b.f.reviewerId, buildDecidedReviewContinuationWakeup({ issueId: b.f.issueId, sourceRunId: b.r.runId, ...pre.identity! }));
    const w2 = await authorReviewRequest(b.f);
    await heartbeat.wakeup(b.f.reviewerId, w2);

    expect(await wakesWithReason(b.f, "decided_review_continuation_not_eligible")).toEqual([
      expect.objectContaining({ status: "skipped", payload: expect.objectContaining({
        decidedReviewContinuationOutcome: expect.objectContaining({ rule: "newer_run_not_verified_pre_dispatch_wait", runId: u }) }) }),
    ]);
    const newW2 = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, b.f.reviewerId)))
      .filter(row => !wakeIdsBefore.has(row.id) && row.reason !== "decided_review_continuation_not_eligible");
    expect(newW2).toEqual([expect.objectContaining({
      status: "skipped", runId: null, finishedAt: expect.any(Date), reason: "execution_reconciliation_required",
      source: "assignment", triggerDetail: "system", requestedByActorType: "agent", requestedByActorId: b.f.authorId,
      error: pre.blocker!.nextAction,
      payload: expect.objectContaining({ issueId: b.f.issueId, executionWait: {
        recoveryActionId: b.hold.id, reason: "execution_recovery",
        message: "Waiting for execution recovery. Your message is saved.",
        requestedIdempotencyKey: (w2 as { idempotencyKey?: string | null }).idempotencyKey ?? null } }),
    })]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, b.f.issueId))).toEqual(holdsBefore);
    const task = await readTask(b.f);
    expect({ status: task.status, statusVersion: task.statusVersion, executionState: task.executionState, executionRunId: task.executionRunId })
      .toEqual({ status: pre.task.status, statusVersion: pre.task.statusVersion, executionState: pre.task.executionState, executionRunId: pre.task.executionRunId });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, b.f.reviewerId))).toEqual(runsBefore);
  }, 60_000);

  it("skips a pass wake as not held once another owner released the holds", async () => {
    const b = await heldBase();
    await b.releaseLease();
    const late = gatedPass();
    await late.entered;
    // Another owner (here: operator reconciliation, declared) released the holds before the wake.
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(),
      evidence: { ...b.hold.evidence, automaticRecovery: { replay: "reconciled" } } }).where(eq(issueRecoveryActions.id, b.hold.id));
    late.release();
    await late.done;
    expect(await wakesWithReason(b.f, "decided_review_continuation_not_held")).toHaveLength(1);
    expect(await reviewerTurnsAfter(b.f, b.resubmittedAt)).toEqual([]);
  }, 60_000);

  it("keeps the admission record after the successor ends, and a newer submission gets its own turn", async () => {
    const b = await heldBase();
    await b.releaseLease();
    await pass();
    await drain(b.f);
    const successor = await expectOneSuccessor(b.f, b.resubmittedAt);
    const identity = (await readIdentity(b.f))!;
    expect(await findConsumption(db, await readTask(b.f), identity)).toMatchObject({ successorRunId: successor.id });
    expect(await selectDecidedReviewSource(db, await readTask(b.f))).toMatchObject({ kind: "none" });
    for (const hold of await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, b.f.issueId), sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ))) expect(hold.evidence.decidedReviewContinuation).toMatchObject({ ...identity, successorRunId: successor.id });

    // A comment from the author is new work: the decided-review gate leaves it
    // to the ordinary path (here baseline's re-wake throttle answers it).
    const before = new Date();
    const comment = await request(app({ type: "agent", source: "agent_key", companyId: b.f.companyId, agentId: b.f.authorId, runId: b.authorRunId }))
      .post(`/api/issues/${b.f.issueId}/comments`).send({ body: "Also covered the null case." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await waitFor(async () => (await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), gt(agentWakeupRequests.createdAt, before),
    ))).length > 0, 10_000, "the comment's reviewer wake");
    await drain(b.f);
    const later = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), gt(agentWakeupRequests.createdAt, before),
    ));
    expect(later.length).toBeGreaterThan(0);
    expect(later.filter(wake => wake.reason?.startsWith("decided_review_continuation"))).toEqual([]);
  }, 60_000);

  /** Production: the author's running turn resubmits, and the review request
   * goes through the ordinary path. */
  async function resubmit(f: Fixture) {
    let authorRunId = "";
    await waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, f.authorId), eq(heartbeatRuns.status, "running"),
      ));
      authorRunId = run?.id ?? "";
      return Boolean(run?.processPid);
    }, 10_000, "the author's run to start");
    const resubmittedAt = new Date();
    const response = await request(app({ type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.authorId, runId: authorRunId }))
      .patch(`/api/issues/${f.issueId}`).send({ status: "done", comment: "Handled the null case too." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { resubmittedAt, authorRunId };
  }

  it("invalidates the served identity with a newer decision, and a newer submission gets one ordinary turn", async () => {
    const b = await heldBase();
    await fs.rm(b.f.gate, { force: true });
    await b.releaseLease();
    await pass();
    const [s] = await reviewerTurnsAfter(b.f, b.resubmittedAt);
    await waitFor(async () => (await heartbeat.getRun(s!.id))?.status === "running" &&
      (await readTask(b.f)).executionRunId === s!.id, 10_000, "the successor to run");
    const served = (await readIdentity(b.f))!;
    expect(await findConsumption(db, await readTask(b.f), served)).toMatchObject({ successorRunId: s!.id });

    // (b) S records a new changes_requested decision through the real route.
    const decided = await request(app({ type: "agent", source: "agent_key", companyId: b.f.companyId, agentId: b.f.reviewerId, runId: s!.id }))
      .patch(`/api/issues/${b.f.issueId}`).send({ status: "in_progress", comment: "The null case still throws." });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await waitFor(async () => ["cancelled", "succeeded"].includes((await heartbeat.getRun(s!.id))?.status ?? ""), 10_000, "S to stop");
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, b.f.issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt));
    expect(decisions).toHaveLength(2);
    const d2 = decisions[1]!;
    expect(d2).toMatchObject({ createdByRunId: s!.id, outcome: "changes_requested" });

    // (e) No resubmission yet: the old identity is stale, a W2 copy follows baseline.
    expect(await readIdentity(b.f)).toBeNull();
    const oldW1 = buildDecidedReviewContinuationWakeup({ issueId: b.f.issueId, sourceRunId: b.r.runId, ...served });
    await heartbeat.wakeup(b.f.reviewerId, oldW1);
    expect(await wakesWithReason(b.f, "decided_review_continuation_stale")).toEqual([
      expect.objectContaining({ status: "skipped", payload: expect.objectContaining({
        decidedReviewContinuationOutcome: { detail: "identity_unavailable" } }) }),
    ]);
    const beforeW2 = new Date();
    await heartbeat.wakeup(b.f.reviewerId, await authorReviewRequest(b.f));
    const w2Rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), gt(agentWakeupRequests.createdAt, beforeW2),
    ));
    // Baseline parks it behind the issue's execution; the gate does not touch it.
    expect(w2Rows).toEqual([expect.objectContaining({ status: "deferred_issue_execution", reason: "issue_execution_deferred" })]);
    const replayedW2 = w2Rows[0]!.id;

    // (f) The author resubmits: the new identity has no record, the old
    // record stays on R's holds, and exactly one review turn runs.
    await fs.writeFile(b.f.gate, "open");
    const second = await resubmit(b.f);
    const fresh = (await readIdentity(b.f))!;
    expect(fresh).toEqual({ decisionId: d2.id, resubmissionActivityId: expect.any(String) });
    expect(fresh.resubmissionActivityId).not.toBe(served.resubmissionActivityId);
    expect(await findConsumption(db, await readTask(b.f), fresh)).toBeNull();
    await waitFor(async () => (await reviewerTurnsAfter(b.f, second.resubmittedAt)).length > 0, 10_000, "the new review turn");
    await drain(b.f);
    // The replayed W2 predates this submission, whose own request supersedes
    // it: one review turn in total, through the real release promotion.
    // The fake reviewer leaves no comment, so baseline retries its turn for
    // the required comment; that retry is the same turn, not a new admission.
    const turns = (await reviewerTurnsAfter(b.f, second.resubmittedAt)).filter(run => !run.retryOfRunId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.wakeupRequestId).not.toBe(replayedW2);
    const [w2] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, replayedW2));
    expect(w2).toMatchObject({ status: "cancelled", error: "Superseded by the current submission's review request" });
    expect(turns[0]!.contextSnapshot).not.toHaveProperty("decidedReviewContinuation");
    const settled = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, b.f.issueId), sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ));
    expect(settled.length).toBeGreaterThan(0);
    for (const hold of settled) expect(hold.evidence.decidedReviewContinuation).toMatchObject({ ...served, successorRunId: s!.id });

    // (d) A pass carrying the old identity afterwards: stale, no run.
    const beforeLate = new Date();
    await heartbeat.wakeup(b.f.reviewerId, { ...oldW1, idempotencyKey: `${oldW1.idempotencyKey}:late` });
    await pass();
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), gt(agentWakeupRequests.createdAt, beforeLate),
    ))).toEqual([expect.objectContaining({ status: "skipped", reason: "decided_review_continuation_stale",
      payload: expect.objectContaining({ decidedReviewContinuationOutcome: expect.objectContaining({ detail: "identity_changed", ...fresh }) }) })]);
    expect(await reviewerTurnsAfter(b.f, beforeLate)).toEqual([]);
  }, 90_000);

  it("leaves a parked interaction wake to its own promotion when the successor folds the holds' wakes", async () => {
    const b = await heldBase();
    await fs.rm(b.f.gate, { force: true });
    await b.releaseLease();
    const holds = await blockingHolds(b.f);
    expect(holds.length).toBeGreaterThan(0);
    const interactionId = randomUUID();
    const context = { issueId: b.f.issueId, taskId: b.f.issueId, wakeReason: "issue_commented", source: "issue.interaction",
      interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered" };
    const [parked] = await db.insert(agentWakeupRequests).values({
      companyId: b.f.companyId, agentId: b.f.reviewerId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "system",
      payload: { issueId: b.f.issueId, executionWait: { issueId: b.f.issueId, recoveryActionId: holds[0]!.id },
        _paperclipWakeContext: context },
    }).returning();
    await pass();
    const [s] = await reviewerTurnsAfter(b.f, b.resubmittedAt);
    expect(s).toBeDefined();
    expect(s!.contextSnapshot).toHaveProperty("decidedReviewContinuation");
    expect(s!.contextSnapshot).not.toHaveProperty("interactionId");
    // Not adopted by ID: the wake keeps its status, receipt and full context.
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked!.id));
    expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect((after!.payload as Record<string, unknown>)._paperclipWakeContext).toEqual(context);
    await fs.writeFile(b.f.gate, "open");
    await drain(b.f);
  }, 60_000);

  it("rotates the pass past more than a page of newer holds that never prove", async () => {
    const b = await heldBase();
    await fs.rm(b.f.gate, { force: true });
    await b.releaseLease();
    // 25 newer held reviews in the decided shape whose decision never proves
    // for them, keyed to sort ahead of b.
    const { executionState } = await readTask(b.f);
    for (let i = 0; i < 25; i += 1) {
      const issueId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await db.insert(issues).values({ id: issueId, companyId: b.f.companyId, title: `Unproved ${i}`, status: "in_review",
        priority: "medium", assigneeAgentId: b.f.reviewerId, issueNumber: 100 + i, identifier: `UNPROVED-${i}`, executionState });
      await db.insert(issueRecoveryActions).values({ companyId: b.f.companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: b.f.reviewerId,
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${randomUUID()}`,
        nextAction: "Reconcile.", resolvedAt: new Date(),
        evidence: { runId: randomUUID(), automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" } } });
    }
    expect(b.f.issueId > "00000000-0000-4000-8000-000000000024").toBe(true);
    const scan: DecidedReviewScan = { after: null };
    const woken: string[] = [];
    const wakeup = async (agentId: string, options: Parameters<typeof heartbeat.wakeup>[1]) => {
      woken.push(String((options?.payload as Record<string, unknown> | undefined)?.issueId));
      return heartbeat.wakeup(agentId, options);
    };
    expect(await continueDecidedReviewReassignments(db, wakeup, scan)).toEqual({ scanned: 25, woken: 0 });
    expect(scan.after).not.toBeNull();
    expect(await continueDecidedReviewReassignments(db, wakeup, scan)).toEqual({ scanned: 1, woken: 1 });
    expect(woken).toEqual([b.f.issueId]);
    expect(scan.after).toBeNull();
    expect(await reviewerTurnsAfter(b.f, b.resubmittedAt)).toHaveLength(1);
    await fs.writeFile(b.f.gate, "open");
    await drain(b.f);
  }, 60_000);

  it("leaves a Board --resume on the held review to the explicit continuation path", async () => {
    const b = await heldBase();
    const identity = (await readIdentity(b.f))!;
    expect(identity).toMatchObject({ decisionId: b.decision.id });
    await sweepToBlocked(b);
    await b.releaseLease();
    // (c) / 12(a): as in the incident, the Board comments on the blocked task
    // with explicit continuation intent through the real route.
    const board = app({ type: "board", userId: b.f.userId, companyIds: [b.f.companyId], source: "local_implicit", isInstanceAdmin: true, runId: null });
    const comment = await request(board).post(`/api/issues/${b.f.issueId}/comments`).send({ body: "Please review the resubmission.", resume: true });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await waitFor(async () => (await reviewerTurnsAfter(b.f, b.resubmittedAt)).length > 0, 10_000, "the Board's continuation");
    const [boardRun] = await reviewerTurnsAfter(b.f, b.resubmittedAt);
    expect(boardRun!.contextSnapshot).not.toHaveProperty("decidedReviewContinuation");
    expect(await blockingHolds(b.f)).toEqual([]);
    await drain(b.f);
    // The route reopened the blocked task for the Board's turn, so the
    // submission no longer stands for review. The pass's wake for it,
    // arriving after the release, is skipped as stale and starts nothing.
    expect((await readTask(b.f)).status).toBe("todo");
    expect(await readIdentity(b.f)).toBeNull();
    const beforeLate = new Date();
    await heartbeat.wakeup(b.f.reviewerId, buildDecidedReviewContinuationWakeup({ issueId: b.f.issueId, sourceRunId: b.r.runId, ...identity }));
    await pass();
    await drain(b.f);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, b.f.reviewerId), gt(agentWakeupRequests.createdAt, beforeLate),
    ))).toEqual([expect.objectContaining({ status: "skipped", reason: "decided_review_continuation_stale", runId: null,
      payload: expect.objectContaining({ decidedReviewContinuationOutcome: { detail: "identity_unavailable" } }) })]);
    expect((await reviewerTurnsAfter(b.f, b.resubmittedAt)).filter(run => !run.retryOfRunId).map(run => run.id)).toEqual([boardRun!.id]);
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, b.f.issueId), sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ))).toEqual([]);
  }, 60_000);


  it("seeds detached reviewers and unrelated runs with the column shape of real runs", async () => {
    const f = await seedReview();
    const launched = await heartbeat.wakeup(f.reviewerId, {
      source: "assignment", triggerDetail: "system", reason: "execution_review_requested", payload: { issueId: f.issueId },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" },
    });
    await waitFor(async () => {
      const run = await heartbeat.getRun(launched!.id);
      return run?.status === "running" && Boolean(run.processPid && run.processGroupId);
    }, 15_000, "a real reviewer launch");
    const real = (await heartbeat.getRun(launched!.id))!;
    ownedPids.add(real.processPid!); ownedGroups.add(real.processGroupId!);
    expect(real.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    expect(real.controllerBootId).toBe(legacyControllerBootId);
    const columns = ["status", "runtimeMode", "runtimeModeResolvedAt", "executionStage", "startedAt", "processPid", "processGroupId",
      "processStartedAt", "controllerBootId", "controllerLeaseExpiresAt", "wakeupRequestId", "responsibleUserId"] as const;
    const pattern = (run: typeof heartbeatRuns.$inferSelect, keys: readonly (keyof typeof run)[]) =>
      Object.fromEntries(keys.map(key => [key, run[key] === null ? null : typeof run[key]]));
    const seeded = await seedDetachedLegacyReviewerRun(f);
    const seededRun = (await heartbeat.getRun(seeded.runId))!;
    expect(pattern(seededRun, columns)).toEqual(pattern(real, columns));
    expect(seededRun.runtimeMode).toBe(real.runtimeMode);
    expect(seededRun.executionStage).toBe(real.executionStage);
    expect(Object.keys(real.contextSnapshot ?? {})).toEqual(expect.arrayContaining(Object.keys(seededRun.contextSnapshot ?? {})));
    // Declared differences: a foreign controller whose lease already expired.
    expect(seededRun.controllerBootId).not.toBe(real.controllerBootId);
    expect(seededRun.controllerLeaseExpiresAt!.getTime()).toBeLessThan(Date.now());

    await heartbeat.cancelRun(real.id);
    await heartbeat.drainActiveRunExecutions();
    await waitFor(() => !isAlive(real.processPid!) && !isAlive(-real.processGroupId!), 5_000, "the real launch to stop");
    const terminal = (await heartbeat.getRun(real.id))!;
    const unrelated = (await heartbeat.getRun(await seedStartedUnrelatedRun(f)))!;
    const terminalColumns = ["runtimeMode", "runtimeModeResolvedAt", "startedAt", "finishedAt", "wakeupRequestId", "responsibleUserId"] as const;
    expect(pattern(unrelated, terminalColumns)).toEqual(pattern(terminal, terminalColumns));
  }, 60_000);

});
