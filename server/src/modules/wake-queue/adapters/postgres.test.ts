import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import {
  createAdmissionTransactionScope,
  createPostgresWakeQueueAdapter,
  createWakeAdmissionWriter,
} from "./postgres.js";
import type { WakeQueuePostgresAdapterDeps } from "./postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import type { TransactionScope } from "../application/ports.js";

// Proves the atomicity and company-scope properties the security review
// requires: every mutation names `companyId` in its own SQL `WHERE` clause,
// a foreign-company row is invisible to a read, and a deferred-status
// compare-and-set that affects no row leaves no other trace. The decision
// branching itself is proven against plain facts in `domain/policy.test.ts`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-queue adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-queue postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const stubDeps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => "responsible-user",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-queue-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    // `heartbeat_runs.wakeup_request_id` references `agent_wakeup_requests.id`,
    // so the run row must go first.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(input: { companyId: string; name?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    issueId?: string;
    status?: string;
    assigneeAgentId?: string | null;
    executionRunId?: string | null;
    checkoutRunId?: string | null;
  }): Promise<string> {
    const issueId = input.issueId ?? randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Wake-queue adapter fixture issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionRunId: input.executionRunId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
    });
    return issueId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown>;
    errorCode?: string | null;
    runtimeMode?: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status ?? "failed",
      contextSnapshot: input.contextSnapshot ?? {},
      errorCode: input.errorCode ?? null,
    });
    return runId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestedByActorType?: string;
    requestedByActorId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: input.requestedByActorType ?? "user",
      requestedByActorId: input.requestedByActorId ?? null,
      payload: { issueId: input.issueId, ...(input.payload ?? {}) },
    });
    return id;
  }

  for (const hasDeferredMessage of [false, true]) {
    it(`plans conversation recovery during owner cleanup without draining messages (queued=${hasDeferredMessage})`, async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
      await db.update(heartbeatRuns).set({
        processPid: process.pid,
        resultJson: { conversationContinuation: "continue_conversation_v1" },
      }).where(eq(heartbeatRuns.id, runId));
      const wakeId = hasDeferredMessage ? await seedDeferredWake({ companyId, agentId, issueId }) : null;
      const release = createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
        recovery: {
          escalateStrandedAssignedIssue: async () => { throw new Error("unexpected escalation"); },
          escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected escalation"); },
        },
      });
      const result = await release({ companyId, runId, now: new Date() });
      expect(result.outcome.kind).toBe("released");
      expect(result.postCommitEffects.every((effect) => effect.kind === "conversation_retry_requested")).toBe(true);
      if (!wakeId) expect(result.postCommitEffects).toEqual([
        { kind: "conversation_retry_requested", companyId, runId, reviewParticipant: false },
      ]);
      if (wakeId) {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
        expect(wake.status).toBe("deferred_issue_execution");
      }
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    });
  }

  it("leaves deferred work untouched until the effective execution hold clears", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", status: "resolved",
      fingerprint: runId, evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Check the stopped execution.",
    }).returning();
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drainCalls = 0;
    const drain = async () => {
      drainCalls++;
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    };
    for (let i = 0; i < 3; i++) {
      expect((await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, drain)).outcome.kind).toBe("released");
    }
    expect(drainCalls).toBe(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toMatchObject({
      status: "deferred_issue_execution", runId: null,
    });
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, hold!.id));
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, drain);
    expect(drainCalls).toBe(1);
  });

  // Review test (a): a foreign-company agent id produces the current failed
  // wake status and the current error text, and creates no run.
  it("fails a deferred wake whose agent belongs to a different company, without creating a run", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignAgentId = await seedAgent({ companyId: otherCompanyId });
    const finishingAgentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: finishingAgentId, status: "in_progress" });
    // A finishing run status other than the legacy-reconciliation set (failed,
    // timed_out, interrupted, cancelled) reaches the module's own drain logic.
    const runId = await seedRun({ companyId, agentId: finishingAgentId, contextSnapshot: { issueId }, status: "succeeded" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const wakeId = await seedDeferredWake({ companyId, agentId: foreignAgentId, issueId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const candidate = await ports.transaction.findNextDeferredWake({ companyId, issueId: locked.primaryIssue.id });
      expect(candidate?.id).toBe(wakeId);
      const agent = await ports.transaction.findInvokableAgent({ companyId, agentId: foreignAgentId });
      expect(agent).toBeNull();
      const failed = await ports.transaction.failDeferredWake({ companyId, wakeId: candidate!.id, now: new Date() });
      expect(failed).toBe(true);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("failed");
    expect(wakeRow?.error).toBe("Deferred wake could not be promoted: agent is not invokable");
    expect(wakeRow?.runId).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
  });

  // Review test (b): each release adapter mutation with a foreign company
  // affects no row.
  it("scopes every release mutation to its own company and affects no row across a company boundary", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock(
      { companyId, runId, now: new Date() },
      async (_locked, ports) => {
        const cancelledUnderWrongCompany = await ports.transaction.cancelDeferredWake({
          companyId: otherCompanyId,
          wakeId,
          reason: "cross-company cancel attempt",
          now: new Date(),
        });
        expect(cancelledUnderWrongCompany).toBe(false);

        const failedUnderWrongCompany = await ports.transaction.failDeferredWake({
          companyId: otherCompanyId,
          wakeId,
          now: new Date(),
        });
        expect(failedUnderWrongCompany).toBe(false);

        const normalizedUnderWrongCompany = await ports.transaction.normalizeDeferredWakeCommentIds({
          companyId: otherCompanyId,
          wakeId,
          payload: { issueId },
          liveCommentIds: ["c1"],
          now: new Date(),
        });
        expect(normalizedUnderWrongCompany).toBeNull();

        const reopenedUnderWrongCompany = await ports.transaction.reopenIssue({
          companyId: otherCompanyId,
          issueId,
          runId,
        });
        expect(reopenedUnderWrongCompany).toBeNull();

        return { outcome: { kind: "released" as const }, postCommitEffects: [] };
      },
    );

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
    expect(wakeRow?.error).toBeNull();
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("blocked");
    expect(issueRow?.executionState).toEqual({ phase: "running" });
  });

  // Review defect: the reopen path must carry the company into every read,
  // lock, and write. A check before the write is not a boundary, because
  // `issues.company_id` can change between that check and the write.
  it("refuses to reopen an issue for a company that does not own it, and leaves the issue untouched", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const captured: { reopened: { status: string; executionState: Record<string, unknown> | null } | null } = {
      reopened: null,
    };
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      captured.reopened = await ports.transaction.reopenIssue({ companyId: otherCompanyId, issueId, runId });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(captured.reopened).toBeNull();

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("blocked");
    expect(issueRow?.executionState).toEqual({ phase: "running" });
  });

  it("reopens an issue for the company that owns it, and clears the execution state", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const captured: { reopened: { status: string; executionState: Record<string, unknown> | null } | null } = {
      reopened: null,
    };
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      captured.reopened = await ports.transaction.reopenIssue({ companyId, issueId, runId });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(captured.reopened?.status).toBe("todo");
    expect(captured.reopened?.executionState).toBeNull();

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("todo");
    expect(issueRow?.executionState).toBeNull();
  });

  // Review test (c): a deferred-status compare-and-set that affects no row
  // claims nothing, and no other write in the promotion path ever runs.
  it("fails the promotion claim when the deferred-status compare-and-set loses the race, before any other write", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    // A concurrent finalization already claimed this wake before the promotion claim runs.
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wakeId));

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      const claimed = await ports.transaction.claimDeferredWakeForPromotion({ companyId, wakeId, now: new Date() });
      expect(claimed).toBe(false);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.executionRunId).toBeNull();
    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("cancelled");
  });

  // `finalizePromotedWake`'s own writes guard against clobbering state a
  // concurrent write already changed: it never takes the issue's execution
  // lock away from a run that already holds it, and it never overwrites a
  // `runId` a wake row already carries. Both guards only matter as defense
  // in depth today (the release drain calls this at most once per
  // transaction), so this drives the port directly to prove the SQL itself,
  // independent of that call pattern.
  it("guards finalizePromotedWake's own writes against clobbering an already-set execution lock or runId", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeIdA = await seedDeferredWake({ companyId, agentId, issueId });
    const wakeIdB = await seedDeferredWake({ companyId, agentId, issueId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const deferredAgent = { id: agentId, companyId, name: "CodexCoder", invokable: true };

    const finalizedRunIds: string[] = [];
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const finalize = async (wakeId: string) => {
        const promoted = await ports.transaction.finalizePromotedWake({
          companyId,
          wakeId,
          deferredAgent,
          issue: locked.primaryIssue,
          finishingRun: locked.run,
          contextSnapshot: { issueId },
          reason: "issue_execution_promoted",
          source: "automation",
          triggerDetail: null,
          payload: {},
          responsibleUserId: "responsible-user",
          sessionBefore: null,
          now: new Date(),
        });
        finalizedRunIds.push(promoted.id);
      };
      // The issue's execution lock is free; this call takes it.
      await finalize(wakeIdA);
      // The issue's execution lock is already held by the first call's run,
      // so this call's issue-lock write must no-op even though a run is
      // still created.
      await finalize(wakeIdB);
      // Repeating the same wake must not overwrite its now-set `runId`.
      await finalize(wakeIdA);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const [runA, runB, runC] = finalizedRunIds;

    const wakeRowA = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeIdA)))[0];
    const wakeRowB = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeIdB)))[0];
    expect(wakeRowA?.runId).toBe(runA);
    expect(wakeRowB?.runId).toBe(runB);
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.executionRunId).toBe(runA);
    expect(issueRow?.executionRunId).not.toBe(runB);
    expect(issueRow?.executionRunId).not.toBe(runC);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    // All three finalize calls each still insert their own run row.
    expect(runs.map((run) => run.id).sort()).toEqual([runId, runA, runB, runC].sort());
  });

  it("locks the context issue and every sibling issue in id order, and two concurrent releases do not deadlock", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueA = await seedIssue({ companyId, assigneeAgentId: agentId });
    const issueB = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runA = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueA } });
    const runB = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueB } });
    await db.update(issues).set({ executionRunId: runA, checkoutRunId: runB }).where(eq(issues.id, issueA));
    await db.update(issues).set({ executionRunId: runB, checkoutRunId: runA }).where(eq(issues.id, issueB));

    const adapterA = createPostgresWakeQueueAdapter(db, stubDeps);
    const adapterB = createPostgresWakeQueueAdapter(db, stubDeps);
    const releaseA = adapterA.withIssueExecutionLock({ companyId, runId: runA, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const releaseB = adapterB.withIssueExecutionLock({ companyId, runId: runB, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });

    await expect(Promise.all([releaseA, releaseB])).resolves.toBeDefined();

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    for (const row of rows) {
      expect(row.executionRunId).toBeNull();
      expect(row.checkoutRunId).toBeNull();
    }
  });

  it("clears both lock columns on every sibling and keeps a transferred executionRunId", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const finishingRunId = await seedRun({ companyId, agentId, contextSnapshot: {} });
    const retryRunId = await seedRun({ companyId, agentId, contextSnapshot: {}, status: "queued" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, executionRunId: retryRunId, checkoutRunId: finishingRunId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId: finishingRunId, now: new Date() }, async () => ({
      outcome: { kind: "released" as const },
      postCommitEffects: [],
    }));
    expect(result.outcome.kind).toBe("released");

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    // executionRunId already pointed at the retry, not the finishing run, so it must survive.
    expect(issueRow?.executionRunId).toBe(retryRunId);
    expect(issueRow?.checkoutRunId).toBeNull();
  });

  // The admission half opens no transaction of its own: `heartbeat.ts` still
  // owns it. These tests drive the admission writer directly against a
  // transaction they open themselves, the same way `heartbeat.ts` will.
  describe("wake admission", () => {
    it("rolls back a deferred merge when its own durable receipt insert fails", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        payload: { originalTarget: true },
      });
      const occupiedReceiptId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        payload: { originalReceipt: true },
      });
      const before = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(agentWakeupRequests.id);
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(
            companyId,
            tx as unknown as Db,
          );
          await writer.mergeIntoExistingDeferredWake(scope, {
            companyId,
            existingDeferredWakeId: wakeId,
            mergedPayload: { issueId, changedByMerge: true },
            nextCoalescedCount: 9,
            coalescedReceipt: {
              id: occupiedReceiptId,
              requestedAt: new Date(),
              agentId,
              source: "automation",
              triggerDetail: "system",
              reason: "question_response",
              payload: { issueId, coalescedIntoWakeupRequestId: wakeId },
              requestedByActorType: "user",
              requestedByActorId: "actor-1",
              idempotencyKey: "colliding-receipt",
              runId: null,
            },
          });
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });

      // The target update precedes the deliberately colliding INSERT. Both
      // complete rows must be restored, including payload, count and timestamps.
      const after = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(agentWakeupRequests.id);
      expect(after).toEqual(before);
      expect(after).toHaveLength(2);
    });

    // Review test (b): an admission adapter mutation with a foreign company
    // affects no row.
    it("refuses to merge into a deferred wake for a company that does not own it, and leaves the wake untouched", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.mergeIntoExistingDeferredWake(scope, {
            companyId: otherCompanyId,
            existingDeferredWakeId: wakeId,
            mergedPayload: { issueId, foo: "bar" },
            nextCoalescedCount: 5,
          });
        }),
      ).rejects.toThrow();

      const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
      expect(wakeRow?.status).toBe("deferred_issue_execution");
      expect(wakeRow?.coalescedCount).not.toBe(5);
      expect(wakeRow?.payload).not.toHaveProperty("foo");
    });

    // Review test (b), the coalesce write: a foreign company affects no row
    // on the active execution run either.
    it("refuses to coalesce into a run for a company that does not own it, and leaves the run and the wake table untouched", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { taskKey: "issue-1" } });
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.coalesceIntoActiveExecutionRun(scope, {
            companyId: otherCompanyId,
            activeExecutionRunId: runId,
            mergedContextSnapshot: { taskKey: "issue-1", commentId: "c1" },
            agentId,
            source: "on_demand",
            triggerDetail: null,
            payload: null,
            requestedByActorType: "user",
            requestedByActorId: null,
            idempotencyKey: null,
          });
        }),
      ).rejects.toThrow();

      const runRow = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
      expect(runRow?.contextSnapshot).toEqual({ taskKey: "issue-1" });
      const wakeRows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, otherCompanyId));
      expect(wakeRows).toHaveLength(0);
    });

    // Review test (d): a transaction-port call cannot use the root database
    // executor. The module rejects a missing scope handle and a mismatched
    // scope handle, and neither case writes a row.
    it("rejects a missing transaction scope and a mismatched one, without writing through the root executor", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const writer = createWakeAdmissionWriter();
      const newWakeInput = {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: null,
        payload: { issueId },
        requestedByActorType: "system",
        requestedByActorId: null,
        idempotencyKey: null,
      };

      await expect(
        writer.insertNewDeferredWake(undefined as unknown as TransactionScope, newWakeInput),
      ).rejects.toThrow(/transaction scope/);

      await expect(
        db.transaction(async (tx) => {
          const mismatchedScope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.insertNewDeferredWake(mismatchedScope, newWakeInput);
        }),
      ).rejects.toThrow(/different company/);

      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(rows).toHaveLength(0);
    });
  });
});
