import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, applyPendingMigrations, heartbeatRuns, issues, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
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
        runStatus: runs[n]!.status, agentAdapter: "process", intentId: n === 1 ? wait!.id : null,
      });
    }
    expect(result.get(input[2]!.id)?.state).toBe("working");
    expect(result.get(input[3]!.id)?.state).toBe("retry_scheduled");
    for (const n of [4, 5]) expect(result.get(input[n]!.id)?.state).toBe("resolved");
    for (const n of [6, 8]) expect(result.get(input[n]!.id)?.responsibility).toBe("user");
  });

  it("keeps the failed run's adapter after the task is reassigned", async () => {
    const f = await seedInterruptionFixture(db, { selected: 1, history: 1, unrelated: 0, payloadBytes: 0 });
    const [nextAgent] = await db.insert(agents).values({
      companyId: f.companyId, name: "Next worker", adapterType: "codex_local",
    }).returning();
    const [reassigned] = await db.update(issues).set({ assigneeAgentId: nextAgent!.id })
      .where(eq(issues.id, f.input[0]!.id)).returning();
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
