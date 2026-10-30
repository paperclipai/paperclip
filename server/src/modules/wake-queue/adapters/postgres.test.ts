import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  subscribeDatabaseWork,
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
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    // `heartbeat_runs.wakeup_request_id` references `agent_wakeup_requests.id`,
    // so the run row must go first.
    await db.delete(nativeRunFinalizations);
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
    parentId?: string | null;
    identifier?: string;
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
      parentId: input.parentId ?? null,
      identifier: input.identifier,
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

  function recordReleaseRunReads() {
    const rows: unknown[][] = [];
    function recordSelects<T extends Pick<Db, "select">>(executor: T): T {
      return new Proxy(executor, { get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = target.select(...fields), from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const query = from(...args);
            if (args[0] === heartbeatRuns) {
              const execute = query.execute.bind(query);
              query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                const result = await execute(...executeArgs); rows.push(result); return result;
              };
            }
            return query;
          }) as typeof builder.from;
          return builder;
        };
      }});
    }
    const transaction: Db["transaction"] = (callback, config) =>
      db.transaction(tx => callback(recordSelects(tx)), config);
    const recorded = new Proxy(db, { get(target, key) {
      return key === "transaction" ? transaction : Reflect.get(target, key);
    }});
    return { recorded, rows };
  }

  it.each(["legacy", "native"])("keeps %s in-flight work and every recovery receipt while omitting output from release reads", async runtimeMode => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const payload = randomBytes(512 * 1024).toString("base64");
    const evidence = { cancellation: { source: "queued_message", expected: true, initiator: { type: "system" }, reason: "Fixture", recordedAt: "2020-01-01T00:00:00Z" },
      workspaceRestoreFailure: "restore_unsafe_archive", workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [randomUUID()] },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId },
      executionCancellation: { state: "acknowledged" }, executionRecovery: { kind: "interrupted", providerStopped: true },
      configurationIncomplete: { reason: "workspace_unavailable" }, unknownFutureReceipt: { retained: true } };
    await db.update(heartbeatRuns).set({ runtimeMode,
      ...(runtimeMode === "native" ? { runnerProfileJson: { savedInput: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
        contextSnapshot: { issueId, paperclipWake: { savedTask: payload }, paperclipTaskMarkdown: payload } } : {}),
      resultJson: { ...evidence, stdout: payload.repeat(3), stderr: payload } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const { recorded, rows } = recordReleaseRunReads();
    const result = await createPostgresWakeQueueAdapter(recorded, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { throw new Error("in-flight work must not drain"); },
    );
    expect(result.outcome.kind).toBe("released");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([{ ...run, resultJson: evidence,
      ...(runtimeMode === "native" ? { runnerProfileJson: null, stdoutExcerpt: null, stderrExcerpt: null,
        contextSnapshot: { issueId } } : {}) }]);
    expect(result.run.contextSnapshot).toEqual({ issueId });
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(8 * 1024);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toEqual(run);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toEqual(issue);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toEqual(wake);
  });

  it.each([null, ["stdout", { stderr: "array evidence" }], "scalar", 42].map(result => ({ result })))("preserves non-object result evidence $result during release", async ({ result }) => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await db.update(heartbeatRuns).set({ resultJson: result as Record<string, unknown> | null }).where(eq(heartbeatRuns.id, runId));
    const { recorded, rows } = recordReleaseRunReads();
    await createPostgresWakeQueueAdapter(recorded, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { throw new Error("in-flight work must not drain"); },
    );
    expect(rows).toHaveLength(1);
    expect((rows[0][0] as typeof heartbeatRuns.$inferSelect).resultJson).toEqual(result);
  });

  it.each(["assignee", "mentioned"])("preserves a paused recipient's accepted message until resume (%s)", async kind => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent({ companyId });
    const recipientId = kind === "assignee" ? ownerId : await seedAgent({ companyId });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, recipientId));
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: ownerId });
    const runId = await seedRun({ companyId, agentId: ownerId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Accepted input must survive an agent pause" }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId: recipientId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: kind === "mentioned" ? "issue_comment_mentioned" : "issue_commented",
        wakeCommentIds: [comment.id] } },
    });
    const [accepted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const input = { companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
    for (let pass = 0; pass < 2; pass++) {
      expect((await release(input)).outcome.kind).toBe("released");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toEqual(accepted);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    }
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, recipientId));
    expect((await release(input)).outcome.kind).toBe("promoted");
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(delivered).toMatchObject({ status: "queued", runId: expect.any(String), payload: accepted.payload });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor).toMatchObject({ agentId: recipientId, contextSnapshot: { wakeCommentIds: [comment.id] } });
    await release(input);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
  });

  it.each(["queued", "running", "scheduled_retry", "cancelled"])("preserves a stranded queue when another agent has a newer %s turn", async status => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const otherAgentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await seedRun({ companyId, agentId: otherAgentId, status, contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId: otherAgentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("ignores a foreign company's run when rechecking a stranded queue", async () => {
    const companyId = await seedCompany();
    const foreignCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const foreignAgentId = await seedAgent({ companyId: foreignCompanyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await seedRun({ companyId: foreignCompanyId, agentId: foreignAgentId, status: "running", contextSnapshot: { issueId } });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(true);
  });

  it.each(["unfinished", "running"])("does not drain a stranded queue through an %s source", async kind => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: kind === "running" ? "running" : "succeeded", contextSnapshot: { issueId } });
    if (kind === "running") await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("recovers a historical mention without consuming a former owner's task messages", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent({ companyId });
    const formerOwnerId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: ownerId });
    const runId = await seedRun({ companyId, agentId: ownerId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved task input" }).returning();
    const [mention] = await db.insert(issueComments).values({ companyId, issueId, authorAgentId: ownerId, createdByRunId: runId, body: "Accepted feedback" }).returning();
    const handoffId = await seedDeferredWake({ companyId, agentId: formerOwnerId, issueId,
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [message.id] } },
    });
    const mentionId = await seedDeferredWake({ companyId, agentId: formerOwnerId, issueId,
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_comment_mentioned", wakeCommentIds: [mention.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const result = await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect(result.outcome.kind).toBe("promoted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, handoffId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, mentionId));
    expect(promoted).toMatchObject({ status: "queued", runId: expect.any(String) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted.runId!)))[0].contextSnapshot)
      .toMatchObject({ wakeCommentIds: [mention.id] });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, message.id)))[0].body).toBe(message.body);
  });

  it.each(["missing", "retryable_failure"])("holds native queue recovery with %s finalization evidence", async phase => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    if (phase !== "missing") await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it.each(["active_lease", "pending_cleanup", "failed_cleanup", "unknown_cleanup", "local_provider_resource", "ssh_provider_mismatch", "cleanup_claim", "finalizer_owner", "workspace_owner"])(
    "waits for native cleanup and finalizer ownership before recovering saved input (%s)", async kind => {
      const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: agentId });
      const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date(),
        ...(kind === "workspace_owner" ? { runnerProfileJson: { nativeWorkspaceFinalizationOwner: {
          token: "copyback-owner", hostname: "previous-worker", pid: 123, processStartedAt: new Date(Date.now() - 1000).toISOString(),
        } } } : {}),
      }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed",
        ...(kind === "finalizer_owner" ? { leaseOwner: "finalizer-worker", leaseExpiresAt: new Date(Date.now() - 1000) } : {}),
      });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
      const [lease] = ["finalizer_owner", "workspace_owner"].includes(kind) ? [] : await db.insert(environmentLeases).values({
        companyId, heartbeatRunId: runId, provider: kind === "unknown_cleanup" ? "daytona" : kind === "ssh_provider_mismatch" ? "ssh" : "local",
        providerLeaseId: kind === "local_provider_resource" ? randomUUID() : kind === "ssh_provider_mismatch" ? "ssh://worker@example.invalid:22/workspace" : null,
        status: kind === "active_lease" ? "active" : kind === "pending_cleanup" ? "pending_cleanup" : "released",
        releasedAt: kind === "active_lease" ? null : new Date(),
        cleanupStatus: kind === "failed_cleanup" ? "failed" : ["unknown_cleanup", "local_provider_resource", "ssh_provider_mismatch"].includes(kind) ? null : "success",
        metadata: kind === "cleanup_claim" ? { pendingCleanupInFlight: true } : {},
      }).returning();
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved input after cleanup" }).returning();
      const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
        payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
      });
      const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
        recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
      });
      const input = { companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
      const held = await release(input);
      expect(held).toMatchObject({ outcome: { kind: "released" }, postCommitEffects: [] });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ executionRunId: runId, checkoutRunId: runId });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
      if (lease) await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(), metadata: {} }).where(eq(environmentLeases.id, lease.id));
      if (kind === "finalizer_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (kind === "workspace_owner") await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
      expect((await release(input)).outcome.kind).toBe("promoted");
      await release(input);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
    },
  );

  it.each(["released", "retained", "local_release", "ssh_release", "unrelated_cleanup"])("allows native queue recovery after settled %s cleanup", async kind => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed" });
    if (kind === "unrelated_cleanup") {
      const foreignCompany = await seedCompany(), foreignAgent = await seedAgent({ companyId: foreignCompany });
      const foreignRun = await seedRun({ companyId: foreignCompany, agentId: foreignAgent, status: "running" });
      await db.insert(environmentLeases).values({ companyId: foreignCompany, heartbeatRunId: foreignRun, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    } else {
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
        provider: kind === "local_release" ? "local" : kind === "ssh_release" ? "ssh" : "daytona",
        providerLeaseId: kind === "ssh_release" ? "ssh://worker@example.invalid:22/workspace" : null,
        metadata: kind === "ssh_release" ? { driver: "ssh" } : {},
        status: ["local_release", "ssh_release"].includes(kind) ? "released" : kind,
        leasePolicy: kind === "retained" ? "reuse_by_environment" : "ephemeral", cleanupStatus: ["local_release", "ssh_release"].includes(kind) ? null : "success",
        releasedAt: kind === "retained" ? null : new Date(),
      });
    }
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved input for the next turn" }).returning();
    await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    expect((await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true })).outcome.kind).toBe("promoted");
  });

  it.each([
    "completed", "multiple_comments", "repeated_reference", "parent_reference", "mixed_issue_references", "mixed_foreign_references", "mixed_unknown_references", "no_comments", "missing_comment",
    "human_comment", "other_run_comment", "foreign_comment", "other_issue_comment", "deleted_comment",
    "mixed_human_comments", "mixed_other_run_comments", "mixed_unrelated_comments",
    "no_reference", "code_reference", "ambiguous_children", "child_open", "child_cancelled",
    "foreign_child", "unrelated_child", "other_child_assignee", "parent_open",
    "source_other_task", "source_other_agent", "wrong_company", "wrong_run",
  ])("proves completed delegation from transactional comment and child rows (%s)", async (scenario) => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const leadId = await seedAgent({ companyId, name: "Lead" });
    const workerId = await seedAgent({ companyId, name: "Worker" });
    const foreignAgentId = await seedAgent({ companyId: otherCompanyId });
    const issueId = await seedIssue({ companyId, identifier: "QA-1", assigneeAgentId: leadId, status: scenario === "parent_open" ? "in_progress" : "done" });
    const otherIssueId = await seedIssue({ companyId, identifier: "QA-99" });
    const foreignIssueId = await seedIssue({ companyId: otherCompanyId, identifier: "QA-98" });
    const runId = await seedRun({ companyId, agentId: scenario === "source_other_agent" ? workerId : leadId,
      status: "succeeded", contextSnapshot: { issueId: scenario === "source_other_task" ? otherIssueId : issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const otherRunId = await seedRun({ companyId, agentId: leadId, status: "succeeded", contextSnapshot: { issueId } });
    await seedIssue({
      companyId: scenario === "foreign_child" ? otherCompanyId : companyId,
      identifier: "QA-2", parentId: scenario === "unrelated_child" ? otherIssueId : issueId,
      assigneeAgentId: scenario === "foreign_child" ? foreignAgentId : scenario === "other_child_assignee" ? leadId : workerId,
      status: scenario === "child_open" ? "in_progress" : scenario === "child_cancelled" ? "cancelled" : "done",
    });
    if (scenario === "ambiguous_children") {
      await seedIssue({ companyId, identifier: "QA-3", parentId: issueId, assigneeAgentId: workerId, status: "done" });
    }
    const body = scenario === "parent_reference" ? "QA-1 is done thanks to @Worker completing QA-2"
      : scenario === "mixed_issue_references" ? "@Worker completed QA-2; now investigate QA-99"
      : scenario === "mixed_foreign_references" ? "@Worker completed QA-2; also check QA-98"
      : scenario === "mixed_unknown_references" ? "@Worker completed QA-2; also check QA-999"
      : scenario === "no_reference" ? "Thanks @Worker" : scenario === "code_reference" ? "Example `QA-2`"
      : scenario === "ambiguous_children" ? "@Worker completed QA-2 and QA-3"
      : scenario === "repeated_reference" ? "@Worker completed [QA-2](/issues/QA-2); QA-2 is done"
      : "@Worker completed QA-2";
    const [comment] = await db.insert(issueComments).values({
      companyId: scenario === "foreign_comment" ? otherCompanyId : companyId,
      issueId: scenario === "foreign_comment" ? foreignIssueId : scenario === "other_issue_comment" ? otherIssueId : issueId,
      authorAgentId: scenario === "human_comment" ? null : leadId,
      authorUserId: scenario === "human_comment" ? "responsible-user" : null,
      createdByRunId: scenario === "human_comment" ? null : scenario === "other_run_comment" ? otherRunId : runId,
      body, deletedAt: scenario === "deleted_comment" ? new Date() : null,
    }).returning();
    const commentIds = scenario === "no_comments" ? [] : [comment.id];
    if (scenario === "missing_comment") commentIds.push(randomUUID());
    if (["multiple_comments", "mixed_human_comments", "mixed_other_run_comments", "mixed_unrelated_comments"].includes(scenario)) {
      const [second] = await db.insert(issueComments).values({ companyId, issueId,
        authorAgentId: scenario === "mixed_human_comments" ? null : leadId,
        authorUserId: scenario === "mixed_human_comments" ? "responsible-user" : null,
        createdByRunId: scenario === "mixed_human_comments" ? null : scenario === "mixed_other_run_comments" ? otherRunId : runId,
        body: scenario === "mixed_unrelated_comments" ? "@Worker, investigate a new error" : "QA-2 was delivered",
      }).returning();
      commentIds.push(second.id);
    }
    let checked = false;
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      checked = true;
      const completed = await ports.transaction.isCompletedDelegationMention({
        companyId: scenario === "wrong_company" ? otherCompanyId : companyId,
        issueId, finishingRunId: scenario === "wrong_run" ? otherRunId : runId, wakeAgentId: workerId, commentIds,
      });
      expect(completed).toBe(["completed", "multiple_comments", "repeated_reference", "parent_reference"].includes(scenario));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(checked).toBe(true);
  });

  it("skips malformed queued comment ids instead of failing the whole liveness batch", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorAgentId: agentId, createdByRunId: null, body: "Mentioned follow-up",
    }).returning();
    const missingCommentId = randomUUID();
    // An 8-char short form, like the id observed in a live wake payload. It is
    // not a uuid, so it can never match a comment row, but it used to abort the
    // whole `inArray` statement and block every queued wake for the issue.
    const malformedCommentId = "0422d095";
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let result: { liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean } | null = null;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      result = await ports.transaction.getQueuedCommentLiveness({
        companyId, issueId, wakeAgentId: agentId, finishingRunId: runId, finishingRunAgentId: agentId,
        queuedCommentIds: [comment.id, malformedCommentId, missingCommentId],
      });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result).not.toBeNull();
    expect(result!.liveNonSelfCommentIds).toEqual([comment.id]);
    expect(result!.containedSelfAuthoredComment).toBe(false);
  });

  it("treats an all-malformed queued comment id list as nothing live", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let result: { liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean } | null = null;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      result = await ports.transaction.getQueuedCommentLiveness({
        companyId, issueId, wakeAgentId: agentId, finishingRunId: runId, finishingRunAgentId: agentId,
        queuedCommentIds: ["0422d095"],
      });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result).not.toBeNull();
    expect(result!.liveNonSelfCommentIds).toEqual([]);
    expect(result!.containedSelfAuthoredComment).toBe(false);
  });

  it.each([false, true])("rechecks disabled chat mode before interrupted queue promotion (conversation=%s)", async (conversation) => {
    const settings = instanceSettingsService(db);
    const original = (await settings.getExperimental()).enableAgentChat;
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorUserId: "responsible-user", body: "Pending input",
    }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { commentId: comment.id, _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
      queuedCommentInterruptQueueId: wakeId, executionCancellation: { state: "acknowledged" },
      conversationContinuation: "continue_conversation_v1",
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: "responsible-user", conversationState: "active" } : {}),
    }).where(eq(issues.id, issueId));
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    try {
      await settings.updateExperimental({ enableAgentChat: false });
      const result = await release({ companyId, runId, now: new Date() });
      if (conversation) {
        expect(result.outcome.kind).toBe("released");
        expect(result.postCommitEffects).toEqual([]);
        const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(issue).toMatchObject({ executionRunId: null, checkoutRunId: null });
        const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
        expect(pending).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
        await settings.updateExperimental({ enableAgentChat: true });
        expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("promoted");
      } else {
        expect(result.outcome.kind).toBe("promoted");
      }
    } finally {
      await settings.updateExperimental({ enableAgentChat: original });
    }
  });

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

  it("releases an acknowledged native handoff without blocking or restarting the old owner", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, resultJson: {
      reassignmentStopRequested: true,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const before = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not restart the outgoing owner"); });
    expect(result).toMatchObject({ outcome: { kind: "released" }, postCommitEffects: [] });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
      status: "in_progress", statusVersion: before.statusVersion, assigneeAgentId: agentId, executionRunId: null, checkoutRunId: null,
    });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  it.each(["in_progress", "blocked"])("preserves recovery ownership and queued messages when a native task fails from %s", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "thread_binding_mismatch" }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay an uncertain execution"); });
    const blockedIssue = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(blockedIssue.status).toBe("blocked");
    const entries = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    if (status === "in_progress") {
      expect(blockedIssue.blockedTransitionAt).not.toBeNull();
      expect(entries[0]).toMatchObject({ action: "issue.updated", details: { status: "blocked", previousStatus: "in_progress" } });
    } else expect(entries).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    const action = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0];
    expect(action).toMatchObject({ ownerType: "board", cause: "native_continuation_requires_reconciliation" });
    if (status === "in_progress") expect(action.evidence).toMatchObject({ nativeFailureBlock: { runId, statusVersion: blockedIssue.statusVersion } });
    else expect(action.evidence.nativeFailureBlock).toBeUndefined();
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay"); });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].statusVersion).toBe(blockedIssue.statusVersion);
  });

  it.each(["active", "escalated"])("repairs a failed native task with an existing %s recovery action", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "runner_lost" }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const [existing] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, status, kind: "active_run_watchdog",
      ownerType: "board", cause: "native_runner_restart_unverified", fingerprint: `restart:${runId}`,
      evidence: { runId, priorProof: "keep", automaticRecovery: { attempts: 2 } },
      nextAction: "Verify the previous execution stopped", attemptCount: 2, maxAttempts: 3,
    }).returning();
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const release = () => adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay"); });
    await release();
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked.status).toBe("blocked");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: existing.id, status, cause: existing.cause,
      ownerType: "board", attemptCount: 2, maxAttempts: 3, nextAction: existing.nextAction,
      evidence: { runId, priorProof: "keep", automaticRecovery: { attempts: 2 },
        nativeFailureBlock: { runId, statusVersion: blocked.statusVersion } } });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    await release();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].statusVersion).toBe(blocked.statusVersion);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(1);
  });

  it.each(["queued", "running", "scheduled_retry"])("does not promote another turn behind a %s successor without an execution lock", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await seedRun({ companyId, agentId, status, contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drained = false;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      drained = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(drained).toBe(false);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
  });

  it.each(["clean", "launch", "cleanup"])("promotes saved input only after a verified pre-dispatch review wait (%s)", async evidence => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId },
      errorCode: "issue_continuation_waiting_on_review" });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 1000), resultJson: {
      stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate",
    } }).where(eq(heartbeatRuns.id, runId));
    if (evidence === "launch") await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "native.process_start_requested", stream: "system", level: "info" });
    if (evidence === "cleanup") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Continue with this new message." }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { commentId: comment.id, _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } });
    const result = await release({ companyId, runId, now: new Date() });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    if (evidence !== "clean") {
      expect(result.outcome.kind).toBe("released");
      expect(runs).toHaveLength(1);
      expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      return;
    }
    expect(result.outcome.kind).toBe("promoted");
    expect(runs).toHaveLength(2);
    const successor = runs.find(run => run.status === "queued")!;
    expect(wake.runId).toBe(successor.id);
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: [comment.id] });
    await release({ companyId, runId, now: new Date() });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
  });

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
  it("skips preserved handoff receipts for one drain without changing their durable state", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const previous = await seedDeferredWake({ companyId, agentId, issueId });
    const next = await seedDeferredWake({ companyId, agentId, issueId });
    await db.update(agentWakeupRequests).set({ requestedAt: new Date("2026-01-01") }).where(eq(agentWakeupRequests.id, previous));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      expect((await ports.transaction.findNextDeferredWake({ companyId, issueId }))?.id).toBe(previous);
      expect((await ports.transaction.findNextDeferredWake({ companyId, issueId, excludedWakeIds: [previous] }))?.id).toBe(next);
      expect(await ports.transaction.findNextDeferredWake({ companyId, issueId, excludedWakeIds: [previous, next] })).toBeNull();
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const [preserved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, previous));
    expect(preserved.status).toBe("deferred_issue_execution");
    expect(preserved.runId).toBeNull();
  });

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

    it.each([DELIVERY_QUEUES.nativeResponsePresentation, DELIVERY_QUEUES.nativeReviewResponse, DELIVERY_QUEUES.nativeStatusReassessment])(
      "scopes a real coalesced-input %s response wake to its active run after commit", async queue => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const runId = await seedRun({ companyId, agentId, status: "running" });
      const hints: Array<Record<string, unknown>> = [];
      const unsubscribe = subscribeDatabaseWork(db, queue, (event, values) => {
        if (event === "settled") for (const value of values ?? []) hints.push(JSON.parse(value));
      });
      try {
        await db.transaction(async tx => {
          await createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(createAdmissionTransactionScope(companyId, tx as unknown as Db), {
            companyId, activeExecutionRunId: runId, mergedContextSnapshot: { commentId: "fresh-input" },
            agentId, source: "on_demand", triggerDetail: null, payload: null,
            requestedByActorType: "user", requestedByActorId: null, idempotencyKey: null,
          });
          expect(hints).toEqual([]);
        });
        expect(hints).toEqual([{ companyId, runId }]);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
          .toMatchObject({ commentId: "fresh-input" });
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runId))).toHaveLength(1);
      } finally { unsubscribe(); }
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
