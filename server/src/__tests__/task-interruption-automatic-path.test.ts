import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TASK_INTERRUPTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure: vi.fn() }));

describe.skipIf(!support.supported)("Retry is offered only when no automatic path exists", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("interruption-automatic-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seedTask(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Swap company", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Swap agent", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Work across a release swap",
      status, assigneeAgentId: agentId }).returning();
    return { companyId, agentId, issue: issue! };
  }

  async function seedSwapEndedRun(finishedAt: Date) {
    const task = await seedTask();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: task.companyId, agentId: task.agentId,
      nativeIssueId: task.issue.id, scopeKind: "issue", status: "failed", runtimeMode: "native",
      nativePhase: "terminal_failure", errorCode: "native_restart_recovery_blocked",
      error: "controller_process_space_unverified", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt });
    await db.insert(nativeRunFinalizations).values({ companyId: task.companyId, issueId: task.issue.id, runId,
      phase: "terminal_failure", attempt: 1, failureCode: "native_restart_recovery_blocked", recoveryState: "blocked" });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: task.companyId, sourceIssueId: task.issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: task.agentId,
      cause: "native_restart_recovery_blocked", fingerprint: `native-restart:${runId}`,
      evidence: { runId, reason: "controller_process_space_unverified", executorStopEvidence: "unverified", providerAttempt: 1 },
      nextAction: "The server running this task restarted. Paperclip continues the task in a fresh run from its saved work.",
      maxAttempts: 3, createdAt: finishedAt, updatedAt: finishedAt }).returning();
    return { ...task, runId, hold: hold! };
  }

  it("shows a run ended by a release swap as working while its system hold awaits the automatic continuation", async () => {
    const { issue, runId } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
      canRetry: false, observedRunId: runId });
  });

  it("still offers Retry when the system hold was not taken up by the continuation worker in time", async () => {
    const { issue } = await seedSwapEndedRun(new Date(Date.now() - 10 * 60_000));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry once the continuation worker decided it cannot continue the task", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence,
      freshContinuationCheck: { kind: "not_applicable", reason: "task_changed", checks: 1, checkedAt: Date.now(), nextCheckAt: null } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry when a person owns the hold", async () => {
    const { issue, hold, companyId } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, ownerGoneAttestation: { companyId } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry when recovery gave up and handed the hold to the board", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ ownerType: "board" }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("shows a healthy task as working while the message queued during its succeeded run is delivered", async () => {
    const { companyId, agentId, issue } = await seedTask();
    const runId = randomUUID(), finishedAt = new Date(Date.now() - 3_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode: "native", startedAt: new Date(Date.now() - 5 * 60_000), finishedAt });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: new Date(Date.now() - 2 * 60_000),
      payload: { issueId: issue.id } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: false });
    expect(await taskInterruptionPresentation(db, { ...issue, status: "in_review" })).toMatchObject({ state: "working", canRetry: false });
    expect(await taskInterruptionPresentation(db, { ...issue, status: "blocked" })).toMatchObject({ state: "failed", canRetry: true });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, runId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: true });
  });

  it("does not offer Retry on a parent whose run succeeded and that waits for its subtasks", async () => {
    const { companyId, agentId, issue } = await seedTask();
    await db.insert(issues).values({ companyId, title: "Subtask", status: "in_progress", assigneeAgentId: agentId, parentId: issue.id });
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode: "native", finishedAt: new Date(Date.now() - 3_000) });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_children_completed",
      status: "queued", requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: false });
  });
});
