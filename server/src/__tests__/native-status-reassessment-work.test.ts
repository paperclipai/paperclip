import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import express from "express";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceOperationService } from "../services/workspace-operations.js";
import request from "supertest";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { workProductService } from "../services/work-products.js";
import { issueService } from "../services/issues.js";
import { approvalService } from "../services/approvals.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, issueWorkProducts, issueThreadInteractions,
  nativeRunFinalizations, nativeRunResults, statusDecisions, workAssessments, workspaceOperations } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { nativeStatusReassessmentWork } from "../services/native-runtime/native-status-reassessment-work.js";
import { dismissAutomaticCompletionReviews } from "../services/native-runtime/automatic-completion-reviews.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

describe("native reassessment worker lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const companyId = randomUUID(), agentId = randomUUID();
  let logRoot: string;
  const priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  let admitted = true;
  const errors: unknown[] = [];
  beforeAll(async () => {
    logRoot = await mkdtemp(join(tmpdir(), "reassessment-workspace-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logRoot;
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STATUS_REASSESSMENT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-reassessment-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Reassessment lifecycle", issuePrefix: `RS${randomUUID().slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reassessment agent", adapterType: "codex_local", status: "idle" });
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
    await rm(logRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
  });
  beforeEach(() => {
    admitted = true; errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    await nativeStatusReassessmentWork(db).register(coordinator, () => admitted).ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 15_000 });
  }
  async function quiet() {
    const original = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      await delay(10);
      expect(queries).toEqual([]);
    } finally { db.$client.options.debug = original; }
  }
  async function status(issueId: string) {
    return (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0].status;
  }
  async function seedReview(evidenceRef?: string) {
    const issueId = randomUUID(), runId = randomUUID(), resultId = randomUUID(), contractId = randomUUID();
    const assessmentId = randomUUID(), workProductId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Persisted native result", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: issueId, completionContractId: contractId, contextSnapshot: { issueId }, finishedAt: new Date() });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "low",
      completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test-v1", criteria: [{ id: "objective", requirement: "Verified artifact" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "reassessment-test" });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { result: { reportedWorkDisposition: "done", summary: "Completed", attentionRequests: [],
        completionClaim: { contractRevision: "test-v1", objectiveSatisfied: true, remainingWork: [],
          criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [evidenceRef ?? `work_product:${workProductId}`] }] },
        verification: [{ commandOrCheck: "artifact", status: "passed", artifactRef: evidenceRef ?? `work_product:${workProductId}` }],
      }, terminal: { runTerminalState: "succeeded" } } });
    await db.insert(issueWorkProducts).values({ id: workProductId, companyId, issueId, type: "artifact", provider: "paperclip",
      title: "Verified artifact", status: "ready_for_review", reviewState: "approved",
      createdAt: new Date(Date.now() - 1000), updatedAt: new Date(Date.now() - 1000) });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, inputDigest: assessmentId,
      assessmentJson: { reportedDisposition: "needs_review", attentionRequests: [], allCriteriaSatisfied: false } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "assessing", resultId, assessmentId });
    const committed = await commitNativeStatusDecision({ db, companyId, issueId, runId, assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "in_review", toStatus: "in_review",
        reasonCode: "completion_claim_incomplete", unblockDescriptor: null,
        effects: [{ kind: "bind_reviewer", ownerUserId: null,
          prompt: "Review the persisted native-run evidence and confirm whether this issue may be completed." }] } });
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: runId, issueId, phase: "workspace_finalize",
      status: "succeeded", exitCode: 0, cwd: process.cwd(), finishedAt: new Date() });
    return { issueId, runId, workProductId, decisionId: committed.decision.id };
  }

  it.each(["milestone", "finalization"] as const)("ignores repeated unscoped routine %s hints without reconstructing dormant reassessment history", async source => {
    const seeded = await seedReview();
    const [other] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed",
      runtimeMode: "legacy", contextSnapshot: { issueId: seeded.issueId }, finishedAt: new Date() }).returning();
    await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, seeded.issueId));
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await start();
    await flush();
    await quiet();
    expect(await nativeStatusReassessmentWork(db).load({ companyId, runId: seeded.runId })).toHaveLength(1);
    const debug = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_connection, query) => {
      if (query.startsWith("select") && query.includes("native_run_finalizations")) queries.push(query);
    };
    try {
      for (let i = 0; i < 3; i++) {
        await db.transaction(tx => source === "milestone" ? notifyChatRunMilestones(tx, { companyId })
          : notifyNativeFinalizationWork(tx, { companyId }));
        await flush();
      }
      expect(queries).toEqual([]);
      expect(await status(seeded.issueId)).toBe("in_review");
    } finally { db.$client.options.debug = debug; }
    await quiet();
  });

  it.each([false, true])("preserves the current required quality-review gate during retired-review reassessment (required=%s)", async required => {
    const seeded = await seedReview();
    if (required) await db.update(issues).set({ executionPolicy: { requiredQualityReview: {
      version: 1, deliverables: [{ key: "output", label: "Verified output" }],
    } } }).where(eq(issues.id, seeded.issueId));
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await start();
    await flush();
    expect(await status(seeded.issueId)).toBe(required ? "in_progress" : "done");
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId));
    if (required) expect(decisions.find(row => row.id !== seeded.decisionId)?.reasonCode).toBe("required_quality_review_incomplete");
    await quiet();
  });

  it.each(["force release", "release", "terminal execution", "terminal checkout", "queue release"] as const)(
    "wakes dormant reassessment from real %s", async action => {
      const seeded = await seedReview();
      const [other] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed",
        runtimeMode: "legacy", contextSnapshot: { issueId: seeded.issueId }, finishedAt: new Date() }).returning();
      await db.update(issues).set({ executionRunId: other.id, checkoutRunId: other.id }).where(eq(issues.id, seeded.issueId));
      await dismissAutomaticCompletionReviews(db, seeded.issueId);
      await start(); await flush(); await quiet();
      expect(await status(seeded.issueId)).toBe("in_review");
      const service = issueService(db);
      if (action === "force release") await service.adminForceRelease(seeded.issueId);
      if (action === "release") await service.release(seeded.issueId);
      if (action === "terminal execution") await service.clearExecutionRunIfTerminal(seeded.issueId);
      if (action === "terminal checkout") await service.clearCheckoutRunIfTerminal(seeded.issueId);
      if (action === "queue release") {
        const adapter = createPostgresWakeQueueAdapter(db, {
          resolveResponsibleUserId: async () => "reassessment-user",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        });
        await adapter.withIssueExecutionLock({ companyId, runId: other.id, now: new Date() },
          async () => ({ outcome: { kind: "released" }, postCommitEffects: [] }));
      }
      await flush();
      expect(await status(seeded.issueId)).toBe(action === "release" ? "in_review" : "done");
      const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId));
      expect(decisions).toHaveLength(2);
      if (action === "release") {
        expect((await service.getById(seeded.issueId))!.assigneeAgentId).toBeNull();
        expect(decisions.find(decision => decision.id !== seeded.decisionId)?.reasonCode).toBe("prior_status_terminal_preserved");
      }
      await quiet();
    },
  );

  it("retains dormant reassessment through outer force-release rollback and commit", async () => {
    const seeded = await seedReview();
    const [other] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed",
      runtimeMode: "legacy", contextSnapshot: { issueId: seeded.issueId }, finishedAt: new Date() }).returning();
    await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, seeded.issueId));
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await start(); await flush(); await quiet();
    const rollback = new Error("rollback release");
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).adminForceRelease(seeded.issueId);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await status(seeded.issueId)).toBe("in_review");
      throw rollback;
    })).rejects.toBe(rollback);
    await flush(); await quiet();
    expect((await issueService(db).getById(seeded.issueId))!.executionRunId).toBe(other.id);
    await db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).adminForceRelease(seeded.issueId);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await status(seeded.issueId)).toBe("in_review");
    });
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it("bounds discovery by pages and drains a real reassessment backlog to SQL quiet", async () => {
    const backlog = [];
    for (let index = 0; index < 103; index++) {
      const seeded = await seedReview();
      await dismissAutomaticCompletionReviews(db, seeded.issueId);
      backlog.push(seeded);
    }
    const work = nativeStatusReassessmentWork(db), scope = { companyId };
    const expected = new Set(backlog.map(row => row.runId));
    const discovered = await work.load(scope);
    expect(discovered.filter(row => expected.has(row.id))).toHaveLength(103);
    const debug = db.$client.options.debug;
    let queries = 0, admissionChecks = 0;
    db.$client.options.debug = (_id, query) => {
      if (query.startsWith("select") && query.includes("native_run_finalizations")) queries++;
    };
    try {
      await expect(work.load(scope, undefined, () => ++admissionChecks <= 1))
        .rejects.toThrow("Native status reassessment discovery stopped");
      expect(queries).toBe(1);
      queries = 0;
      await expect(work.load(scope, AbortSignal.abort())).rejects.toThrow("Native status reassessment discovery stopped");
      expect(queries).toBe(0);
    } finally { db.$client.options.debug = debug; }
    await start(); await flush();
    for (const seeded of backlog) {
      expect(await status(seeded.issueId)).toBe("done");
      expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    }
    expect((await work.load(scope)).filter(row => expected.has(row.id))).toEqual([]);
    await quiet();
  }, 60_000);

  it("waits quietly for physical workspace ownership to release before reassessment", async () => {
    const seeded = await seedReview();
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const owner = withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => {
      enter(); await released;
    });
    try {
      await Promise.race([entered, owner]);
      await start(); await flush();
      expect(await status(seeded.issueId)).toBe("in_review");
      await quiet();
    } finally { release(); await owner; }
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it("keeps an unverified workspace owner dormant despite a successful receipt", async () => {
    const seeded = await seedReview();
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    const owner = { token: randomUUID(), hostname: "unverified-controller", pid: 12345,
      processStartedAt: new Date().toISOString() };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await start(); await flush();
    expect(await status(seeded.issueId)).toBe("in_review");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]
      .runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);
    await quiet();
  });

  it.each(["ordinary", "native source"] as const)("wakes from a committed control-plane evidence event through the %s append path", async path => {
    const seeded = await seedReview("event:1");
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    const prpEvent = { sourceKind: "control_plane", payload: { evidenceOutcome: " accepted " } };
    const input = { companyId, agentId, runId: seeded.runId, eventType: "evidence.recorded", payload: { prpEvent },
      ...(path === "native source" ? { nativeSource: { sourceInstanceId: randomUUID(), sourceEventId: randomUUID(),
        sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: prpEvent } } : {}) };
    expect((await appendHeartbeatRunEvent(db, input)).disposition).toBe("committed");
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    if (path === "native source") expect((await appendHeartbeatRunEvent(db, input)).disposition).toBe("duplicate");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it("preserves event evidence until outer commit and ignores rollback", async () => {
    const seeded = await seedReview("event:1");
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    const write = async (tx: typeof db) => {
      await appendHeartbeatRunEvent(tx, { companyId, agentId, runId: seeded.runId, eventType: "evidence.recorded",
        payload: { prpEvent: { sourceKind: "control_plane", payload: { evidenceOutcome: "accepted" } } } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
    };
    await expect(db.transaction(async tx => {
      await write(tx as unknown as typeof db); throw new Error("rollback event evidence");
    })).rejects.toThrow("rollback event evidence");
    await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    await db.transaction(tx => write(tx as unknown as typeof db));
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it("keeps ordinary and runner-authored logs from waking reassessment", async () => {
    const seeded = await seedReview("event:3");
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    const wakes = vi.fn();
    const stop = subscribeDeliveryWork(db, DELIVERY_QUEUES.nativeStatusReassessment, wakes);
    try {
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: seeded.runId, eventType: "log", message: "Still working" });
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: seeded.runId, eventType: "evidence.recorded",
        payload: { prpEvent: { sourceKind: "runner", payload: { evidenceOutcome: "accepted" } } } });
      expect(wakes).not.toHaveBeenCalled();
      await quiet();
      expect(await status(seeded.issueId)).toBe("in_review");
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: seeded.runId, eventType: "evidence.recorded",
        payload: { prpEvent: { sourceKind: "control_plane", payload: { evidenceOutcome: "accepted" } } } });
      await flush();
      expect(await status(seeded.issueId)).toBe("done");
      await quiet();
    } finally { stop(); }
  });

  it("wakes when a real workspace finalization settles after a quiet failure", async () => {
    const seeded = await seedReview();
    await db.update(workspaceOperations).set({ status: "running" }).where(eq(workspaceOperations.heartbeatRunId, seeded.runId));
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await start(); await flush(); await quiet();
    const recorder = workspaceOperationService(db).createRecorder({ companyId, issueId: seeded.issueId, heartbeatRunId: seeded.runId });
    await expect(recorder.recordOperation({ phase: "workspace_finalize", run: async () => { throw new Error("export interrupted"); } }))
      .rejects.toThrow("export interrupted");
    await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const operation = recorder.recordOperation({ phase: "workspace_finalize", run: async () => {
      started(); await gate; return { status: "succeeded" };
    } });
    try {
      await running; await flush(); await quiet();
      expect(await status(seeded.issueId)).toBe("in_review");
    } finally { release(); await operation; }
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it("defers workspace barrier writes until outer commit and ignores rollback", async () => {
    const seeded = await seedReview();
    await db.update(workspaceOperations).set({ status: "running" }).where(eq(workspaceOperations.heartbeatRunId, seeded.runId));
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await start(); await flush(); await quiet();
    const write = async (tx: typeof db) => {
      await workspaceOperationService(tx).createRecorder({ companyId, issueId: seeded.issueId, heartbeatRunId: seeded.runId })
        .recordOperation({ phase: "workspace_finalize", run: async () => ({ status: "succeeded" }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
    };
    await expect(db.transaction(async tx => {
      await write(tx as unknown as typeof db); throw new Error("rollback workspace barrier");
    })).rejects.toThrow("rollback workspace barrier");
    await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    await db.transaction(tx => write(tx as unknown as typeof db));
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it.each(["confirmation", "checkbox", "question", "verdict", "partial verdict"] as const)("wakes dormant evidence from real interaction %s", async mutation => {
    const interactionId = randomUUID();
    const seeded = await seedReview(`interaction:${interactionId}`);
    const kind = mutation === "confirmation" ? "request_confirmation" : mutation === "checkbox" ? "request_checkbox_confirmation"
      : mutation === "question" ? "ask_user_questions" : "request_item_verdicts";
    const payload = kind === "ask_user_questions"
      ? { version: 1 as const, questions: [{ id: "verified", prompt: "Verified?", selectionMode: "single" as const,
        options: [{ id: "yes", label: "Yes" }] }] }
      : kind === "request_item_verdicts"
        ? { version: 1 as const, prompt: "Review evidence", items: [{ id: "artifact", label: "Artifact" },
          ...(mutation === "partial verdict" ? [{ id: "other", label: "Other" }] : [])] }
        : kind === "request_checkbox_confirmation"
          ? { version: 1 as const, prompt: "Accept evidence", options: [{ id: "verified", label: "Verified" }] }
          : { version: 1 as const, prompt: "Accept evidence" };
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId: seeded.issueId, kind,
      sourceRunId: seeded.runId, continuationPolicy: "none", createdByUserId: "board-user", payload });
    await db.update(issues).set({ createdByUserId: "board-user" }).where(eq(issues.id, seeded.issueId));
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    const scope = { id: seeded.issueId, companyId, projectId: null, goalId: null };
    const interactions = issueThreadInteractionService(db);
    if (mutation === "confirmation" || mutation === "checkbox") {
      await interactions.acceptInteraction(scope, interactionId, mutation === "checkbox" ? { selectedOptionIds: ["verified"] } : {}, { userId: "board-user" });
    } else if (mutation === "question") {
      await interactions.answerQuestions(scope, interactionId, { answers: [{ questionId: "verified", optionIds: ["yes"] }] }, { userId: "board-user" });
    } else {
      await interactions.submitItemVerdicts(scope, interactionId, { verdicts: [{ id: "artifact", verdict: "approve" }] }, { userId: "board-user" });
    }
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it.each(["resolution", "link", "bulk link"] as const)("wakes dormant evidence from real approval %s", async mutation => {
    const approvalId = randomUUID();
    const seeded = await seedReview(`approval:${approvalId}`);
    await approvalService(db).create(companyId, { id: approvalId, type: "approve_ceo_strategy", payload: {},
      status: mutation === "resolution" ? "pending" : "approved" });
    if (mutation === "resolution") await issueApprovalService(db).link(seeded.issueId, approvalId);
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    if (mutation === "resolution") await approvalService(db).approve(approvalId, "board-user");
    if (mutation === "link") await issueApprovalService(db).link(seeded.issueId, approvalId);
    if (mutation === "bulk link") await issueApprovalService(db).linkManyForApproval(approvalId, [seeded.issueId]);
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it("defers approval evidence until outer commit and ignores rolled-back approval", async () => {
    const approvalId = randomUUID();
    const seeded = await seedReview(`approval:${approvalId}`);
    await approvalService(db).create(companyId, { id: approvalId, type: "approve_ceo_strategy", payload: {} });
    await issueApprovalService(db).link(seeded.issueId, approvalId);
    await vi.advanceTimersByTimeAsync(1000);
    await db.update(issueWorkProducts).set({ updatedAt: new Date() }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    await expect(db.transaction(async tx => {
      await approvalService(tx as unknown as typeof db).approve(approvalId, "board-user");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
      throw new Error("rollback approval evidence");
    })).rejects.toThrow("rollback approval evidence");
    await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    await db.transaction(async tx => {
      await approvalService(tx as unknown as typeof db).approve(approvalId, "board-user");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
    });
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it.each([false, true])("preserves the required quality-review gate after real evidence approval (required=%s)", async required => {
    const seeded = await seedReview();
    await db.update(issueWorkProducts).set({ reviewState: "none" }).where(eq(issueWorkProducts.id, seeded.workProductId));
    if (required) await db.update(issues).set({ executionPolicy: { requiredQualityReview: {
      version: 1, deliverables: [{ key: "output", label: "Verified output" }],
    } } }).where(eq(issues.id, seeded.issueId));
    await start();
    await flush();
    await quiet();
    await workProductService(db).update(seeded.workProductId, { reviewState: "approved" });
    await flush();
    expect(await status(seeded.issueId)).toBe(required ? "in_progress" : "done");
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId));
    if (required) expect(decisions.find(row => row.id !== seeded.decisionId)?.reasonCode).toBe("required_quality_review_incomplete");
    await quiet();
  });

  it.each(["update", "create", "primary replacement", "import", "attachment", "source promotion"] as const)("wakes from the real work-product %s writer", async writer => {
    const seeded = await seedReview();
    if (writer === "update") await db.update(issueWorkProducts).set({ reviewState: "none" }).where(eq(issueWorkProducts.id, seeded.workProductId));
    if (writer === "create") await db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.workProductId));
    if (writer === "source promotion") await db.update(issueWorkProducts).set({ sourceTrust: {
      preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: seeded.issueId,
      sourceRunId: seeded.runId, sourceAgentId: agentId,
    } }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    const products = workProductService(db);
    if (writer === "update") await products.update(seeded.workProductId, { reviewState: "approved" });
    if (writer === "create" || writer === "primary replacement") await products.createForIssue(seeded.issueId, companyId, {
      ...(writer === "create" ? { id: seeded.workProductId } : {}),
      type: "artifact", provider: "paperclip", title: "Verified artifact", status: "approved", reviewState: "approved",
      isPrimary: writer === "primary replacement",
    });
    if (writer === "import") await products.createManyForImport([{ companyId, issueId: seeded.issueId, projectId: null,
      type: "artifact", provider: "paperclip", externalId: null, title: "Imported evidence", url: null, status: "approved",
      reviewState: "approved", isPrimary: false, healthStatus: "unknown", summary: null, metadata: null,
      executionWorkspaceId: null, runtimeServiceId: null, createdByRunId: null, sourceTrust: null }]);
    if (writer === "attachment") await issueService(db).createAttachment({ issueId: seeded.issueId, provider: "local_disk",
      objectKey: randomUUID(), contentType: "text/plain", byteSize: 4, sha256: "a".repeat(64), originalFilename: "result.txt",
      createdByAgentId: agentId, createdByRunId: seeded.runId });
    if (writer === "source promotion") {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "board-user", companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "operator", status: "active" }],
          isInstanceAdmin: true, source: "local_implicit" }; next();
      });
      app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
      const promoted = await request(app).post(`/api/issues/${seeded.issueId}/low-trust/promotions`).send({
        sourceArtifactKind: "work_product", sourceArtifactId: seeded.workProductId,
        title: "Reviewed artifact", summary: "Reviewed completion evidence",
      });
      expect(promoted.status, JSON.stringify(promoted.body)).toBe(201);
    }
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it("waits for an outer work-product transaction and ignores rollback", async () => {
    const seeded = await seedReview();
    await db.update(issueWorkProducts).set({ reviewState: "none" }).where(eq(issueWorkProducts.id, seeded.workProductId));
    await start(); await flush(); await quiet();
    await expect(db.transaction(async tx => {
      await workProductService(tx as unknown as typeof db).update(seeded.workProductId, { reviewState: "approved" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
      throw new Error("rollback evidence approval");
    })).rejects.toThrow("rollback evidence approval");
    await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    await db.transaction(async tx => {
      await workProductService(tx as unknown as typeof db).update(seeded.workProductId, { reviewState: "approved" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await status(seeded.issueId)).toBe("in_review");
    });
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it.each(["status", "blocked reassertion", "assignment"] as const)("reassesses a real task %s mutation after quiet", async mutation => {
    const seeded = await seedReview();
    if (mutation === "blocked reassertion") await issueService(db).update(seeded.issueId, { status: "blocked" });
    await start(); await flush(); await quiet();
    const before = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId));
    await issueService(db).update(seeded.issueId, mutation === "assignment" ? { assigneeAgentId: null } : { status: "blocked" });
    await flush();
    const after = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId));
    expect(after).toHaveLength(before.length + 1);
    expect(await status(seeded.issueId)).toBe(mutation === "assignment" ? "in_review" : "blocked");
    const [current] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const [assessment] = await db.select().from(workAssessments).where(eq(workAssessments.id, current.assessmentId!));
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(assessment.priorStatusVersion).toBe(issue.statusVersion);
    await quiet();
  });

  it("retains the first review-retirement wake through idle drain", async () => {
    const seeded = await seedReview();
    await start(); await flush(); await quiet();
    admitted = false;
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    admitted = true;
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await status(seeded.issueId)).toBe("done");
    await quiet();
  });

  it("reconstructs the saved retry after shutdown and never dispatches it early", async () => {
    const seeded = await seedReview();
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    const future = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: future }).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const waitForSavedDeadline = async () => {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator!.nextWakeAt()).toBe(future.getTime());
        expect(await status(seeded.issueId)).toBe("in_review");
      }, { timeout: 15_000 });
    };
    await start();
    await waitForSavedDeadline();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await status(seeded.issueId)).toBe("in_review");
    await coordinator!.stop(); coordinator = undefined;
    await start();
    await waitForSavedDeadline();
    await vi.advanceTimersByTimeAsync(Math.max(0, future.getTime() - Date.now())); await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });

  it("wakes from real review retirement after idle and becomes SQL quiet with completed history", async () => {
    const seeded = await seedReview();
    await start(); await flush(); await quiet();
    expect(await status(seeded.issueId)).toBe("in_review");
    await dismissAutomaticCompletionReviews(db, seeded.issueId);
    await flush();
    expect(await status(seeded.issueId)).toBe("done");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).toHaveLength(2);
    await quiet();
  });
});
