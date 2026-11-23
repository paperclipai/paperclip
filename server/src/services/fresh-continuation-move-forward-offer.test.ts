import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { ensureFreshContinuation, resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { heartbeatService } from "./heartbeat.js";
import { requestTaskRetry } from "./task-retry.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";

vi.mock("../sentry.js", async importOriginal => ({ ...await importOriginal<object>(), captureTaskInterruptionFailure: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const KINDS = ["fresh_isolated_workspace", "writer_ended", "native"] as const;
type Kind = (typeof KINDS)[number];
const RECORDED_ISOLATION: Record<Kind, string> = {
  fresh_isolated_workspace: "fresh_isolated_workspace", writer_ended: "writer_ended", native: "remote_epoch" };

suite("Move it forward now while a recorded continuation waits for delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-move-forward-offer-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "MFO",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);

  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await db.execute(sql`truncate table issue_recovery_actions, native_run_finalizations, activity_log,
      agent_wakeup_requests, heartbeat_runs, issues cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function pendingContinuation(kind: Kind, waitingMinutes: number) {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = new Date(Date.now() - (waitingMinutes + 1) * 60_000);
    const native = kind === "native";
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: native ? issueId : null, runtimeMode: native ? "native" : "legacy",
      status: "failed", errorCode: native ? "native_session_interrupted" : kind === "writer_ended" ? "process_lost" : "controller_lease_lost",
      error: "cut off", startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 11 * 60_000), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      ...(native ? { nativePhase: "terminal_failure", runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
        workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "sandbox-1", remoteCwd: "/home/daytona/work", epoch: 3,
        state: "prepared", snapshotId: null } } }
        : { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }),
      ...(kind === "fresh_isolated_workspace"
        ? { processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) } : {}) });
    if (native) {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    }
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId,
      cause: native ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
      fingerprint: `${native ? "native-continuation" : "legacy-execution"}:${runId}`, nextAction: "Held.", maxAttempts: 3,
      createdAt: finishedAt, evidence: { runId, originalFailureCode: "cut_off", nativeFailureBlock: { runId, statusVersion: 4 } } })
      .returning();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", delivery: "recorded", isolation: RECORDED_ISOLATION[kind] });
    const recordedAt = new Date(Date.now() - waitingMinutes * 60_000).toISOString();
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{freshContinuation,recordedAt}',
      to_jsonb(${recordedAt}::text))` }).where(eq(issueRecoveryActions.id, action!.id));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { issue: issue!, issueId, runId, actionId: action!.id, isolation: RECORDED_ISOLATION[kind] };
  }

  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  const taskRuns = (f: { issueId: string; runId: string }) => db.select().from(heartbeatRuns).where(and(
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
  const record = async (actionId: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;
  const wake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const deliveryPass = () => deliverReconciledExecutions(db, heartbeatService(db).wakeup);
  async function deliver() { await deliveryPass(); await deliveryPass(); }

  async function shownOffer(f: Awaited<ReturnType<typeof pendingContinuation>>) {
    const shown = await taskInterruptionPresentation(db, f.issue);
    expect(shown).toMatchObject({ responsibility: "system", state: "working", canRetry: true, retryAction: "move_forward",
      observedRunId: f.runId });
    return shown!;
  }
  const click = (f: { issueId: string }, shown: { observedRunId: string | null; retryAction?: "move_forward" }) =>
    requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, observedRunId: shown.observedRunId,
      retryAction: shown.retryAction, idempotencyKey: randomUUID(), actorSource: "local_implicit" });

  async function expectTheRecordedContinuation(f: Awaited<ReturnType<typeof pendingContinuation>>) {
    const runs = await taskRuns(f);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.contextSnapshot).toMatchObject({ recoveryActionId: f.actionId, previousRunId: f.runId, forceFreshSession: true });
    expect(run.retryOfRunId).toBe(f.runId);
    if (f.isolation === "fresh_isolated_workspace") {
      expect(run.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
      expect(await readFreshWorkspaceReadiness(db, run)).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId });
    } else expect(run.contextSnapshot?.freshContinuationIsolation).toBeUndefined();
    expect((await record(f.actionId)).evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: run.id });
    return run;
  }

  it.each(KINDS)("delivers the recorded continuation as the one run when a person clicks Move it forward now (%s)", async kind => {
    const f = await pendingContinuation(kind, 16);
    await occupySlot();
    const shown = await shownOffer(f);
    const receipt = await click(f, shown);
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeatService(db).resumeTaskRetry(companyId, receipt.requestId!);
    const run = await expectTheRecordedContinuation(f);
    expect(await wake(receipt.requestId!)).toMatchObject({ status: "coalesced", runId: run.id, requestedByActorType: "user" });
    await deliver();
    await heartbeatService(db).resumeTaskRetry(companyId, receipt.requestId!);
    expect((await taskRuns(f)).map(row => row.id)).toEqual([run.id]);
    const after = await taskInterruptionPresentation(db, f.issue);
    expect(after).toMatchObject({ state: "working", canRetry: false, observedRunId: run.id });
    expect(after?.retryAction).toBeUndefined();
  }, 60_000);

  it.each(KINDS)("starts one run when Move it forward now and the delivery pass race (%s)", async kind => {
    const f = await pendingContinuation(kind, 16);
    await occupySlot();
    const receipt = await click(f, await shownOffer(f));
    expect(receipt).toMatchObject({ accepted: true });
    await Promise.all([heartbeatService(db).resumeTaskRetry(companyId, receipt.requestId!), deliveryPass(), deliveryPass()]);
    await deliver();
    await heartbeatService(db).resumeTaskRetry(companyId, receipt.requestId!);
    const run = await expectTheRecordedContinuation(f);
    expect(await wake(receipt.requestId!)).toMatchObject({ status: "coalesced", runId: run.id });
  }, 60_000);

  it.each(KINDS)("starts no second run when the continuation was delivered between the offer and the click (%s)", async kind => {
    const f = await pendingContinuation(kind, 16);
    await occupySlot();
    const shown = await shownOffer(f);
    await deliver();
    const delivered = await expectTheRecordedContinuation(f);
    const receipt = await click(f, shown);
    expect(receipt).toMatchObject({ accepted: false, requestId: null });
    await deliver();
    expect((await taskRuns(f)).map(row => row.id)).toEqual([delivered.id]);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.reason, "task_retry"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`))).toEqual([]);
  }, 60_000);

  it.each(KINDS)("starts nothing when the system gave up the delivery between the offer and the click (%s)", async kind => {
    const f = await pendingContinuation(kind, 16);
    await occupySlot();
    const shown = await shownOffer(f);
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb` })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const receipt = await click(f, shown);
    expect(receipt).toMatchObject({ accepted: false, alreadyMovedOn: true, requestId: null });
    await deliver();
    expect(await taskRuns(f)).toEqual([]);
    const after = await taskInterruptionPresentation(db, f.issue);
    expect(after?.retryAction).toBeUndefined();
  }, 60_000);

  it("starts no second run when the task moved on to another run between the offer and the click", async () => {
    const f = await pendingContinuation("writer_ended", 16);
    await occupySlot();
    const shown = await shownOffer(f);
    const [moved] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, status: "queued",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" } }).returning();
    const receipt = await click(f, shown);
    expect(receipt).toMatchObject({ accepted: false, requestId: null });
    await deliver();
    expect((await taskRuns(f)).map(row => row.id)).toEqual([moved!.id]);
    expect((await record(f.actionId)).evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: moved!.id });
  }, 60_000);

  it("offers no button while the recorded continuation has waited under 15 minutes", async () => {
    const f = await pendingContinuation("writer_ended", 14);
    await occupySlot();
    const shown = await taskInterruptionPresentation(db, f.issue);
    expect(shown).toMatchObject({ responsibility: "system", state: "working", canRetry: false, observedRunId: f.runId });
    expect(shown?.retryAction).toBeUndefined();
  }, 60_000);
});
