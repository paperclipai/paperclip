import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, chatActions, chatEndpoints, companies, createDb, applyPendingMigrations, heartbeatRuns, issueRecoveryActions,
  issueRelations, issues,
  toolApplications, toolConnections,
  nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { createSystemRecovery } from "../services/system-recovery-state.js";
import { taskInterruptionPresentation, taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { readNativeSessionResumptionAgent } from "../services/native-runtime/native-session-resumption-admission.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { captureInterruptionQuery, seedInterruptionFixture } from "./helpers/task-interruption-fixture.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TASK_INTERRUPTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const captureTaskInterruptionFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure }));

describe.skipIf(!support.supported)("task interruption latest run query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("interruption-query-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  // The shared fixture's failures are historical; reporting tests need a current failure.
  const markFailuresFresh = (companyId: string) => db.update(heartbeatRuns).set({ finishedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "failed")));

  it("shows a pending native same-run resume instead of a competing Retry", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resuming task", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Resuming agent", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Resume after attach failure",
      status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "failed", runtimeMode: "native", errorCode: "native_session_interrupted", finishedAt: new Date() });
    const resumeAt = new Date(Date.now() + 30_000);
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "retryable_failure",
      attempt: 1, nextAttemptAt: resumeAt });
    for (const presentation of [(await taskInterruptionPresentations(db, companyId, [issue])).get(issue.id),
      await taskInterruptionPresentation(db, issue)]) {
      expect(presentation).toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: resumeAt.toISOString() });
    }
    // The coordinator also pushes nextAttemptAt while it defers an ineligible
    // candidate. Those deferrals, or one far past the failure, never hide Retry.
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent", adapterType: "paperclip_runner" });
    const admission = async () => {
      const [currentIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
      const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      return readNativeSessionResumptionAgent(db, { issue: currentIssue!, run: currentRun!, coordinator: coordinator! });
    };
    expect(await admission()).not.toBeNull();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId: otherAgentId, status: "cancelled",
      finishedAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 60 * 60_000) });
    const terminatedManagerId = randomUUID();
    await db.insert(agents).values({ id: terminatedManagerId, companyId, name: "Former manager",
      adapterType: "paperclip_runner", status: "terminated" });
    for (const [table, change, restore] of [
      ["issue", { assigneeAgentId: otherAgentId }, { assigneeAgentId: agentId }],
      ["issue", { status: "blocked" }, { status: "in_progress" }],
      ["issue", { executionRunId: otherRunId }, { executionRunId: null }],
      ["issue", { checkoutRunId: otherRunId }, { checkoutRunId: null }],
      ["run", { contextSnapshot: { nativeQuestionCancellation: { requestId: "q" } } }, { contextSnapshot: {} }],
      // Invokability is more than status: an idle agent under a terminated manager is refused.
      ["agent", { reportsTo: terminatedManagerId }, { reportsTo: null }],
    ] as const) {
      if (table === "issue") await db.update(issues).set(change).where(eq(issues.id, issue.id));
      else if (table === "run") await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, runId));
      else await db.update(agents).set(change).where(eq(agents.id, agentId));
      // The scheduler would defer this candidate, so the task offers Retry.
      if (table !== "run") expect(await admission()).toBeNull();
      expect((await taskInterruptionPresentations(db, companyId, [issue])).get(issue.id))
        .toMatchObject({ state: "failed", canRetry: true });
      if (table === "issue") await db.update(issues).set(restore).where(eq(issues.id, issue.id));
      else if (table === "run") await db.update(heartbeatRuns).set(restore).where(eq(heartbeatRuns.id, runId));
      else await db.update(agents).set(restore).where(eq(agents.id, agentId));
    }
    expect(await admission()).not.toBeNull();
    // A provider cooldown can schedule the resume an hour out; it stays visible.
    const cooldown = new Date(Date.now() + 60 * 60_000);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: cooldown }).where(eq(nativeRunFinalizations.runId, runId));
    expect((await taskInterruptionPresentations(db, companyId, [issue])).get(issue.id))
      .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: cooldown.toISOString() });
    // Exhausted recovery is terminal: exactly one Retry returns.
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    expect((await taskInterruptionPresentations(db, companyId, [issue])).get(issue.id))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("explains a saved Retry held by unfinished blockers instead of offering Retry again (restart chaos t05)", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Waiting parent", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Parent agent", adapterType: "paperclip_runner" });
    const [parent] = await db.insert(issues).values({ companyId, title: "Write the brief", identifier: "CHA-5",
      status: "blocked", assigneeAgentId: agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Part 2", identifier: "CHA-10", parentId: parent.id,
      status: "blocked", assigneeAgentId: agentId }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: parent.id, scopeKind: "issue",
      status: "failed", runtimeMode: "native", errorCode: "native_session_interrupted", finishedAt: new Date(Date.now() - 60_000) });
    const [retry] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", reason: "task_retry",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: new Date(Date.now() - 30_000),
      payload: { issueId: parent.id, taskRetry: { sourceRunId: runId } } }).returning();
    const presentation = await taskInterruptionPresentation(db, parent);
    expect(presentation).toMatchObject({ state: "working", canRetry: false, intentId: retry.id,
      retryWait: { reason: "dependency_blocked" } });
    expect(presentation?.retryWait?.message).toContain("blocked task this one depends on");
    expect(JSON.stringify(presentation)).not.toContain("Part 2");
    expect(JSON.stringify(presentation)).not.toContain("CHA-10");
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, child.id));
    expect((await taskInterruptionPresentations(db, companyId, [parent])).get(parent.id)?.retryWait?.message)
      .toContain("Remove or replace that dependency");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, child.id));
    expect((await taskInterruptionPresentation(db, parent))?.retryWait?.reason).not.toBe("dependency_blocked");
  });

  // G1 wave s9802 t02: an accepted Retry held by the unpriced-usage refusal
  // read as a budget wait. It is an accounting matter; name it so.
  it("labels a Retry held by unpriced usage as accounting, not budget", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Unpriced", issuePrefix: `U${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    const [task] = await db.insert(issues).values({ companyId, title: "Task", identifier: "CHA-2",
      status: "blocked", assigneeAgentId: agentId }).returning();
    const [todo] = await db.insert(issues).values({ companyId, title: "Not started", identifier: "CHA-3",
      status: "todo", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: task.id, scopeKind: "issue",
      status: "failed", runtimeMode: "native", errorCode: "native_session_cleanup_quarantined", finishedAt: new Date(Date.now() - 60_000) });
    const refusal = "Company cannot start work because recorded usage has no reliable price.";
    await db.insert(agentWakeupRequests).values([{ companyId, agentId, source: "on_demand", reason: "task_retry",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: new Date(Date.now() - 30_000),
      payload: { issueId: task.id, taskRetry: { sourceRunId: runId }, executionWait: { reason: "budget.blocked", message: refusal } } },
    { companyId, agentId, source: "assignment", reason: "budget.blocked", status: "skipped", error: refusal,
      requestedAt: new Date(), payload: { issueId: todo.id } }]);
    const held = await taskInterruptionPresentation(db, task);
    expect(held?.retryWait).toMatchObject({ reason: "accounting.unpriced_usage", message: expect.stringContaining("has no price") });
    expect(held?.retryWait?.message).not.toContain("budget to allow");
    const waiting = (await taskInterruptionPresentations(db, companyId, [todo])).get(todo.id);
    expect(waiting?.retryWait).toMatchObject({ reason: "accounting.unpriced_usage", message: expect.stringContaining("has no price") });
    // A budget hard stop keeps its budget label.
    await db.update(agentWakeupRequests).set({ payload: { issueId: task.id, taskRetry: { sourceRunId: runId },
      executionWait: { reason: "budget.blocked", message: "Company is paused because its budget hard-stop was reached." } } })
      .where(eq(agentWakeupRequests.reason, "task_retry"));
    expect((await taskInterruptionPresentation(db, task))?.retryWait?.reason).toBe("budget.blocked");
  });

  it("shows a queued-message Interrupt as handing off, not as a failed attempt", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), userId = "board-user";
    await db.insert(companies).values({ id: companyId, name: "Interrupted task", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Researcher", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Creative brief",
      status: "todo", assigneeAgentId: agentId }).returning();
    // The message was queued well before the user clicked Interrupt.
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "on_demand", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedAt: new Date(Date.now() - 60_000), payload: { issueId: issue.id },
    }).returning();
    const interrupt = async (requestedAt: Date) => {
      await db.update(agentWakeupRequests).set({ payload: { issueId: issue.id,
        queuedCommentInterrupt: { actorId: userId, requestedAt: requestedAt.toISOString() } } })
        .where(eq(agentWakeupRequests.id, wake.id));
    };
    await interrupt(new Date(Date.now() - 20_000));
    // Same resultJson the queued-comment Interrupt route passes to cancelRun.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "cancelled", runtimeMode: "native", errorCode: "operator_interrupted",
      startedAt: new Date(Date.now() - 42_000), finishedAt: new Date(Date.now() - 20_000),
      resultJson: { operatorInterrupted: true, interruptionSource: "issue_comment_interrupt", interruptedIssueId: issue.id,
        interruptedByActorType: "user", interruptedByActorId: userId, cancelledByActorType: "user", cancelledByUserId: userId,
        queuedCommentInterruptQueueId: wake.id } });
    captureTaskInterruptionFailure.mockClear();
    for (const presentation of [(await taskInterruptionPresentations(db, companyId, [issue])).get(issue.id),
      await taskInterruptionPresentation(db, issue)]) {
      expect(presentation).toMatchObject({ state: "working", canRetry: false, intentId: wake.id });
    }
    expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
    // A newer queued message does not hide the wake the run was stopped for.
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "on_demand", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedAt: new Date(Date.now() - 30_000), payload: { issueId: issue.id },
    });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: false, intentId: wake.id });
    // A run stopped for a different queue is not this hand-off.
    await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true, cancelledByActorType: "user",
      cancelledByUserId: userId, queuedCommentInterruptQueueId: randomUUID() } }).where(eq(heartbeatRuns.id, runId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
    await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true, cancelledByActorType: "user",
      cancelledByUserId: userId, queuedCommentInterruptQueueId: wake.id } }).where(eq(heartbeatRuns.id, runId));
    // A hand-off that never starts eventually offers one Retry.
    await interrupt(new Date(Date.now() - 10 * 60_000));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("decides several pending native resumes in one list read", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resuming list", issuePrefix: `L${companyId.slice(0, 7)}` });
    await db.insert(agents).values([{ id: agentId, companyId, name: "Resuming agent", adapterType: "paperclip_runner" },
      { id: otherAgentId, companyId, name: "Other agent", adapterType: "paperclip_runner" }]);
    const resumeAt = new Date(Date.now() + 30_000);
    const list = [];
    for (let index = 0; index < 6; index++) {
      const [issue] = await db.insert(issues).values({ companyId, title: `Resume ${index}`, status: "in_progress",
        assigneeAgentId: index % 2 ? otherAgentId : agentId }).returning();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
        status: "failed", runtimeMode: "native", errorCode: "native_session_interrupted", finishedAt: new Date() });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "retryable_failure",
        attempt: 1, nextAttemptAt: resumeAt });
      list.push(issue);
    }
    const result = await taskInterruptionPresentations(db, companyId, list);
    list.forEach((issue, index) => expect(result.get(issue.id)).toMatchObject(index % 2
      ? { state: "failed", canRetry: true }
      : { state: "retry_scheduled", canRetry: false, nextRetryAt: resumeAt.toISOString() }));
  });

  it("redacts workspace preparation errors on task detail and list reads", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    try {
      const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const secret = `private-workspace-value-${randomUUID()}`;
      const error = `Could not prepare the project folder: ${secret}.`;
      await db.update(heartbeatRuns).set({ errorCode: "workspace_validation_failed", error }).where(eq(heartbeatRuns.id, run!.id));
      await createRunSecretRedactionRegistry(db).register(f.companyId, run!.id, secret);
      const list = await taskInterruptionPresentations(db, f.companyId, f.input);
      const detail = await taskInterruptionPresentation(db, f.input[0]!);
      for (const presentation of [list.get(f.input[0]!.id), detail]) {
        expect(presentation?.workspaceFailure?.message).toContain("Could not prepare the project folder");
        expect(presentation?.workspaceFailure?.message).toContain("REDACTED");
        expect(JSON.stringify(presentation)).not.toContain(secret);
      }
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
      expect(await taskInterruptionPresentation(db, f.input[0]!)).not.toHaveProperty("workspaceFailure");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]?.error).toBe(error);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["valid", "numeric_user", "numeric_audit"] as const)("retains bounded typed Stop evidence in the real batched projection (%s)", async variant => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped task", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped agent", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Keep this task in progress",
      status: "in_progress", assigneeAgentId: agentId }).returning();
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, runId, issueId: issue.id,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: variant === "numeric_audit" ? 123 : randomUUID(), acknowledgementAuditId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id,
      scopeKind: "issue", status: "cancelled", runtimeMode: "native", driverKind: "cursor_cloud_api",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: variant === "numeric_user" ? 123 : "board", nativeCancellation,
        executionCancellation: { state: "requested" }, unrelatedPayload: "x".repeat(128_000) } });
    const result = await taskInterruptionPresentations(db, companyId, [issue]);
    expect(result.get(issue.id)).toMatchObject(variant === "valid"
      ? { state: "resolved", canRetry: false } : { state: "failed", canRetry: true });
    const query = await captureInterruptionQuery(db, taskInterruptionPresentations, companyId, [issue]);
    const [projected] = await db.$client.unsafe(query.sql, query.params as never[]);
    expect(projected.jsonb_build_object.nativeCancellation).toEqual({ ...nativeCancellation,
      intentAuditId: variant === "numeric_audit" ? null : nativeCancellation.intentAuditId });
    expect(projected.jsonb_build_object.cancelledByUserId).toBe(variant === "numeric_user" ? null : "board");
    expect(projected).toMatchObject({ company_id: companyId, native_issue_id: issue.id, runtime_mode: "native" });
    expect(projected.jsonb_build_object).not.toHaveProperty("unrelatedPayload");
    expect(JSON.stringify(projected.jsonb_build_object).length).toBeLessThan(4000);
  });

  it("redacts registered run secrets from both task detail and list provider explanations", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    try {
      const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const secret = `private-runtime-value-${randomUUID()}`;
      const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
        category: "unknown", message: `Provider rejected runtime value ${secret}.`, retryability: "unknown" };
      await db.update(heartbeatRuns).set({ resultJson: { providerFailure } }).where(eq(heartbeatRuns.id, run!.id));
      await createRunSecretRedactionRegistry(db).register(f.companyId, run!.id, secret);
      const list = await taskInterruptionPresentations(db, f.companyId, f.input);
      const detail = await taskInterruptionPresentation(db, f.input[0]!);
      for (const presentation of [list.get(f.input[0]!.id), detail]) {
        expect(presentation?.providerFailure?.message).toContain("Provider rejected runtime value");
        expect(JSON.stringify(presentation)).not.toContain(secret);
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]?.resultJson).toEqual({ providerFailure });
    } finally { vi.unstubAllEnvs(); }
  });

  it("redacts a scheduled retry's predecessor provider explanation with the predecessor's registry", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    try {
      const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const predecessorId = randomUUID();
      const secret = `private-predecessor-value-${randomUUID()}`;
      const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "daytona", phase: "startup",
        category: "overloaded", message: `Sandbox refused lease for ${secret}.`, httpStatus: 502, retryability: "transient" };
      await db.insert(heartbeatRuns).values({ id: predecessorId, companyId: f.companyId, agentId: run!.agentId,
        status: "failed", errorCode: "environment_provider_unavailable", resultJson: { providerFailure },
        createdAt: new Date(run!.createdAt.getTime() - 60_000) });
      await db.update(heartbeatRuns).set({ status: "scheduled_retry", retryOfRunId: predecessorId, resultJson: {},
        scheduledRetryAt: new Date(Date.now() + 30_000), scheduledRetryAttempt: 1 }).where(eq(heartbeatRuns.id, run!.id));
      await createRunSecretRedactionRegistry(db).register(f.companyId, predecessorId, secret);
      const list = await taskInterruptionPresentations(db, f.companyId, f.input);
      const detail = await taskInterruptionPresentation(db, f.input[0]!);
      for (const presentation of [list.get(f.input[0]!.id), detail]) {
        expect(presentation?.observedRunId).toBe(run!.id);
        expect(presentation?.providerFailure).toMatchObject({ httpStatus: 502 });
        expect(presentation?.providerFailure?.message).toContain("Sandbox refused lease");
        expect(presentation?.providerFailure?.message).toContain("REDACTED");
        expect(JSON.stringify(presentation)).not.toContain(secret);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["decryption failure", "expanded message"])("keeps task reads available after provider display %s", async scenario => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    try {
      const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const secret = "pw-short";
      const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
        category: "unknown", message: secret + "🚀".repeat(4000 - secret.length), retryability: "unknown" };
      await db.update(heartbeatRuns).set({ resultJson: { providerFailure } }).where(eq(heartbeatRuns.id, run!.id));
      await createRunSecretRedactionRegistry(db).register(f.companyId, run!.id, secret);
      if (scenario === "decryption failure") vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
      const presentation = await taskInterruptionPresentation(db, f.input[0]!);
      expect(presentation).toMatchObject({ state: "failed", canRetry: true });
      if (scenario === "decryption failure") expect(presentation).not.toHaveProperty("providerFailure");
      else {
        expect(presentation?.providerFailure?.message).toContain("REDACTED");
        expect([...presentation!.providerFailure!.message]).toHaveLength(4000);
      }
      expect(JSON.stringify(presentation)).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not inspect unrelated company history for a small issue page", async () => {
    const f = await seedInterruptionFixture(db, { selected: 2, history: 3, unrelated: 1500, payloadBytes: 4096 });
    const query = await captureInterruptionQuery(db, taskInterruptionPresentations, f.companyId, f.input);
    const [explain] = await db.$client.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params as never[]);
    const inspected: number[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "heartbeat_runs") inspected.push(
        (Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0)) * Number(node["Actual Loops"] ?? 1));
      for (const child of node.Plans as Record<string, unknown>[] ?? []) visit(child);
    };
    visit(explain["QUERY PLAN"][0].Plan);
    expect(inspected.length).toBeGreaterThan(0);
    expect(Math.max(...inspected)).toBeLessThan(30);
    await markFailuresFresh(f.companyId);
    const presentations = await taskInterruptionPresentations(db, f.companyId, f.input);
    for (const issue of f.input) expect(presentations.get(issue.id)).toMatchObject({ state: "failed", canRetry: true });
    for (const issue of f.input) expect(captureTaskInterruptionFailure).toHaveBeenCalledWith(expect.objectContaining({
      companyId: f.companyId, taskId: issue.id, runId: presentations.get(issue.id)!.observedRunId,
      runStatus: "failed", agentAdapter: "process",
    }));
  });

  it("preserves native, first-class and text legacy precedence, ties, and tenant scope", async () => {
    const companyId = randomUUID(), otherId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values([companyId, otherId].map(id => ({ id, name: "Selectors", issuePrefix: `S${id.slice(0, 7)}` })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Selector agent", adapterType: "process" });
    const input = await db.insert(issues).values(Array.from({ length: 10 }, (_, n) => ({ companyId, title: `Selector ${n}`, status: "in_progress", assigneeAgentId: agentId }))).returning();
    const base = { companyId, agentId, status: "failed", createdAt: new Date("2026-10-27T00:00:00Z") };
    const winnerIds = Array.from({ length: 7 }, () => randomUUID());
    await db.$client.unsafe("alter table heartbeat_runs disable trigger heartbeat_runs_set_scope_kind");
    await db.insert(heartbeatRuns).values([
      { ...base, id: winnerIds[0], nativeIssueId: input[0]!.id, issueId: input[1]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[2]!.id } },
      { ...base, id: winnerIds[1], issueId: input[1]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[2]!.id } },
      { ...base, id: winnerIds[2], contextSnapshot: { issueId: input[2]!.id } },
      { ...base, nativeIssueId: randomUUID(), contextSnapshot: { issueId: input[3]!.id } },
      { ...base, nativeIssueId: null, issueId: input[9]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[3]!.id } },
      { ...base, contextSnapshot: { issueId: input[3]!.id.toUpperCase() } },
      ...[null, "", [], 5, { issueId: "" }, { issueId: {} }, { issueId: [] }].map(contextSnapshot => ({ ...base, contextSnapshot: contextSnapshot as never })),
      { ...base, id: winnerIds[3], nativeIssueId: input[4]!.id, contextSnapshot: null },
      { ...base, id: winnerIds[4], issueId: input[5]!.id, scopeKind: "issue", contextSnapshot: [input[3]!.id] as never },
      { ...base, id: "00000000-0000-0000-0000-000000000001", contextSnapshot: { issueId: input[6]!.id } },
      { ...base, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", nativeIssueId: input[6]!.id, contextSnapshot: { issueId: "" } },
      { ...base, companyId: otherId, nativeIssueId: input[3]!.id, createdAt: new Date("2026-10-28T00:00:00Z") },
    ]);
    await db.$client.unsafe("alter table heartbeat_runs enable trigger heartbeat_runs_set_scope_kind");
    const result = await taskInterruptionPresentations(db, companyId, [...input, input[0]!, { ...input[0]!, companyId: otherId }]);
    for (let n = 0; n < 3; n++) expect(result.get(input[n]!.id)?.observedRunId).toBe(winnerIds[n]);
    expect(result.get(input[3]!.id)).toBeNull();
    expect(result.get(input[4]!.id)?.observedRunId).toBe(winnerIds[3]);
    expect(result.get(input[5]!.id)?.observedRunId).toBe(winnerIds[4]);
    expect(result.get(input[6]!.id)?.observedRunId).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(result.get(input[7]!.id)).toBeNull();
    expect(result.get(input[8]!.id)).toBeNull();
    const upper = { ...input[4]!, id: input[4]!.id.toUpperCase() };
    expect((await taskInterruptionPresentations(db, companyId, [upper])).get(upper.id)).toBeNull();
    expect(await taskInterruptionPresentations(db, companyId, [])).toEqual(new Map());
  });

  it("reports the saved-message failure state without reporting work, retries or user actions", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), pausedAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Failure states", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", adapterType: "process" },
      { id: pausedAgentId, companyId, name: "Paused worker", adapterType: "process", status: "paused" },
    ]);
    const input = await db.insert(issues).values(Array.from({ length: 9 }, (_, n) => ({
      companyId, title: `State ${n}`, status: n === 5 ? "done" : "in_progress",
      assigneeAgentId: n === 8 ? pausedAgentId : agentId,
    }))).returning();
    const runs = await db.insert(heartbeatRuns).values(input.map((issue, n) => ({
      companyId, agentId: issue.assigneeAgentId!, issueId: issue.id,
      status: n === 1 || n === 4 ? "succeeded" : n === 2 ? "running" : n === 7 ? "cancelled" : "failed",
      errorCode: n === 6 ? "native_provider_approval_required" : null,
      scheduledRetryAt: n === 3 ? new Date(Date.now() + 60_000) : null,
    }))).returning();
    const [wait] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", payload: { issueId: input[1]!.id }, requestedAt: new Date(Date.now() - 20_000),
    }).returning();
    captureTaskInterruptionFailure.mockClear();
    const result = await taskInterruptionPresentations(db, companyId, [...input, { ...input[0]!, companyId: randomUUID() }]);
    expect(captureTaskInterruptionFailure).toHaveBeenCalledTimes(3);
    for (const n of [0, 1, 7]) {
      expect(result.get(input[n]!.id)).toMatchObject({ responsibility: "system", state: "failed" });
      expect(captureTaskInterruptionFailure).toHaveBeenCalledWith({
        companyId, agentId, taskId: input[n]!.id, runId: runs[n]!.id,
        runStatus: runs[n]!.status, agentAdapter: "process", intentId: n === 1 ? wait!.id : null, runErrorCode: null,
      });
    }
    expect(result.get(input[2]!.id)?.state).toBe("working");
    expect(result.get(input[3]!.id)?.state).toBe("retry_scheduled");
    for (const n of [4, 5]) expect(result.get(input[n]!.id)?.state).toBe("resolved");
    for (const n of [6, 8]) expect(result.get(input[n]!.id)?.responsibility).toBe("user");
  });

  it("reports a retained failure once at its state change, not on every later process's read", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retained failures", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
    const input = await db.insert(issues).values(Array.from({ length: 3 }, (_, n) => ({
      companyId, title: `Retained ${n}`, status: "in_progress", assigneeAgentId: agentId,
    }))).returning();
    const old = new Date(Date.now() - 22 * 60 * 60_000);
    const runs = await db.insert(heartbeatRuns).values(input.map((issue, n) => ({
      companyId, agentId, issueId: issue.id, status: "failed", createdAt: old,
      finishedAt: n === 2 ? new Date(Date.now() - 60_000) : old,
      errorCode: n === 0 ? "native_workspace_sync_out_retry_exhausted" : null,
    }))).returning();
    // A new saved message is a new state change for an old failed run.
    const [wait] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", payload: { issueId: input[1]!.id }, requestedAt: new Date(Date.now() - 20_000),
    }).returning();
    captureTaskInterruptionFailure.mockClear();
    const result = await taskInterruptionPresentations(db, companyId, input);
    for (const issue of input) expect(result.get(issue.id)).toMatchObject({ responsibility: "system", state: "failed" });
    expect(captureTaskInterruptionFailure).toHaveBeenCalledTimes(2);
    expect(captureTaskInterruptionFailure).toHaveBeenCalledWith(expect.objectContaining({
      taskId: input[1]!.id, runId: runs[1]!.id, intentId: wait!.id }));
    expect(captureTaskInterruptionFailure).toHaveBeenCalledWith(expect.objectContaining({
      taskId: input[2]!.id, runId: runs[2]!.id, intentId: null }));
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runs[0]!.id));
    captureTaskInterruptionFailure.mockClear();
    await taskInterruptionPresentations(db, companyId, [input[0]!]);
    expect(captureTaskInterruptionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: input[0]!.id, runErrorCode: "native_workspace_sync_out_retry_exhausted" }));
  });

  it("reports recovery that newly fails on an old run once, then treats it as retained", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Old run recovery", issuePrefix: `O${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Recovery", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const old = new Date(Date.now() - 22 * 60 * 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, status: "failed",
      createdAt: old, finishedAt: old }).returning();
    // Exhausted recovery clears nextAttemptAt; only the saved transition time is recent.
    const exhausted = { ...createSystemRecovery(run!.id), state: "exhausted" as const, attempts: 6, retriesUsed: 5,
      firstFailureAt: old.getTime(), deadlineAt: old.getTime() + 30 * 60_000, nextAttemptAt: null };
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      kind: "workspace_recovery", status: "active", ownerType: "system", cause: "native_workspace_sync_out_failed",
      fingerprint: `recovery:${run!.id}`, nextAction: "Recover saved files.", createdAt: old, updatedAt: new Date(),
      evidence: { runId: run!.id, systemRecovery: exhausted } }).returning();
    captureTaskInterruptionFailure.mockClear();
    expect((await taskInterruptionPresentations(db, companyId, [issue!])).get(issue!.id))
      .toMatchObject({ responsibility: "system", state: "failed" });
    expect(captureTaskInterruptionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: issue!.id, runId: run!.id }));
    await db.update(issueRecoveryActions).set({ updatedAt: old }).where(eq(issueRecoveryActions.id, action!.id));
    captureTaskInterruptionFailure.mockClear();
    await taskInterruptionPresentations(db, companyId, [issue!]);
    expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
  });

  it("reports a native resume that is newly exhausted on an old run once, then treats it as retained", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Old native run", issuePrefix: `N${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Native resume", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const old = new Date(Date.now() - 22 * 60 * 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue!.id, scopeKind: "issue",
      status: "failed", runtimeMode: "native", errorCode: "native_session_interrupted", createdAt: old, finishedAt: old });
    // Only the coordinator's saved terminal transition is recent.
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue!.id, runId, phase: "terminal_failure",
      attempt: 3, nextAttemptAt: null, createdAt: old, updatedAt: new Date() });
    captureTaskInterruptionFailure.mockClear();
    expect((await taskInterruptionPresentations(db, companyId, [issue!])).get(issue!.id))
      .toMatchObject({ responsibility: "system", state: "failed" });
    expect(captureTaskInterruptionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: issue!.id, runId, runErrorCode: "native_session_interrupted" }));
    await db.update(nativeRunFinalizations).set({ updatedAt: old }).where(eq(nativeRunFinalizations.runId, runId));
    captureTaskInterruptionFailure.mockClear();
    await taskInterruptionPresentations(db, companyId, [issue!]);
    expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"])("reports a delayed Retry that newly becomes %s, then ages out", async status => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), intentId = randomUUID(), actionId = randomUUID();
    const old = new Date(Date.now() - 22 * 60 * 60_000), recent = new Date(Date.now() - 60_000);
    await db.insert(companies).values({ id: companyId, name: "Delayed chat Retry", issuePrefix: "D" + companyId.slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat worker", adapterType: "claude_local" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Deferred Retry", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: issue!.id,
      status: "failed", createdAt: old, finishedAt: old });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Chat",
      applicationKey: randomUUID(), type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id,
      name: "Chat", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id,
      assignedAgentId: agentId, provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    const payload = { issueId: issue!.id, agentId, failedRunId: runId, taskRetryIntentId: intentId };
    await db.insert(chatActions).values({ id: actionId, companyId, endpointId: endpoint!.id,
      kind: "failed_run_retry", providerActionId: randomUUID(), status, payload, createdAt: old, updatedAt: recent });
    await db.insert(agentWakeupRequests).values({ id: intentId, companyId, agentId, source: "on_demand",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: old,
      payload: { issueId: issue!.id, taskRetry: { sourceRunId: runId, chatActionId: actionId } } });
    captureTaskInterruptionFailure.mockClear();
    expect((await taskInterruptionPresentations(db, companyId, [issue!])).get(issue!.id))
      .toMatchObject({ responsibility: "system", state: "failed", nextRetryAt: null });
    expect(captureTaskInterruptionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: issue!.id, runId, intentId }));
    await db.update(chatActions).set({ updatedAt: old }).where(eq(chatActions.id, actionId));
    captureTaskInterruptionFailure.mockClear();
    await taskInterruptionPresentations(db, companyId, [issue!]);
    expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
    await db.update(chatActions).set({ updatedAt: recent, payload: { ...payload, failedRunId: randomUUID() } })
      .where(eq(chatActions.id, actionId));
    captureTaskInterruptionFailure.mockClear();
    await taskInterruptionPresentations(db, companyId, [issue!]);
    expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
  });

  it("keeps the failed run's adapter after the task is reassigned", async () => {
    const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
    const [nextAgent] = await db.insert(agents).values({
      companyId: f.companyId, name: "Next worker", adapterType: "codex_local",
    }).returning();
    const [reassigned] = await db.update(issues).set({ assigneeAgentId: nextAgent!.id })
      .where(eq(issues.id, f.input[0]!.id)).returning();
    await markFailuresFresh(f.companyId);
    captureTaskInterruptionFailure.mockClear();
    const result = await taskInterruptionPresentations(db, f.companyId, [reassigned!]);
    expect(result.get(reassigned!.id)?.state).toBe("failed");
    expect(captureTaskInterruptionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: reassigned!.id, agentAdapter: "process",
    }));
  });
  // N-03: ONB-1 on staging waited 16 minutes on an overdue workspace_busy
  // retry. Nothing failed, yet the banner offered a Retry that cannot help.
  it.each(["workspace_busy", "ai_connection_busy", "ai_connection_pool_wait", "runner_revision_wait"])(
    "does not present an overdue %s wait as a failed attempt", async reason => {
      const companyId = randomUUID(), agentId = randomUUID(), parentRunId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Waiting task", issuePrefix: `W${companyId.slice(0, 7)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Waiting agent", adapterType: "process" });
      const [issue] = await db.insert(issues).values({ companyId, title: "Paperclip onboarding",
        status: "in_progress", assigneeAgentId: agentId }).returning();
      const now = Date.now();
      await db.insert(heartbeatRuns).values({ id: parentRunId, companyId, agentId, issueId: issue!.id, scopeKind: "issue",
        status: "cancelled", errorCode: reason, createdAt: new Date(now - 10 * 60_000), finishedAt: new Date(now - 9 * 60_000) });
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, scopeKind: "issue",
        status: "scheduled_retry", retryOfRunId: parentRunId, scheduledRetryReason: reason, scheduledRetryAttempt: 2,
        scheduledRetryAt: new Date(now - 5 * 60_000), createdAt: new Date(now - 9 * 60_000) });
      captureTaskInterruptionFailure.mockClear();
      const presentation = (await taskInterruptionPresentations(db, companyId, [issue!])).get(issue!.id);
      expect(presentation).toMatchObject({ responsibility: "system", state: "working", canRetry: false });
      expect(captureTaskInterruptionFailure).not.toHaveBeenCalled();
    });
});
