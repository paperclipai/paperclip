import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { ReviewedChatBindingNotReadyError } from "../reviewed-chat-binding-diagnostics.js";
import { reportRunFailure } from "../run-failure-report.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunCompletion, type HeartbeatRunCompletionDependencies } from "./run-completion.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
// The Sentry report is an outbound boundary; the tests observe the decision handed to it.
vi.mock("../run-failure-report.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../run-failure-report.js")>();
  return { ...actual, reportRunFailure: vi.fn(async () => undefined) };
});

type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn<HeartbeatLifecycleDependencies["getCurrentUserRedactionOptions"]>(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("reviewed chat setup wait reporting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-reviewed-chat-report");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.mocked(reportRunFailure).mockClear();
  });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Completion", issuePrefix: "CMP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Chat agent", adapterType: "process" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "legacy", ...patch }).returning();
    const deps = callbacks(db);
    const completion = createHeartbeatRunCompletion(db, deps);
    const setup = (outerErr: unknown) => ({ run, runId: run.id, outerErr, signal: new AbortController().signal, providerDispatchStarted: false,
      identityRedactor: createAgentIdentityRedactor(), readFailureReportSecrets: () => [] });
    return { run, deps, completion, setup };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);

  it.each(["scheduled", "not_scheduled", "scheduler_failed", "interaction_scheduled", "interaction_not_scheduled", "untrusted"] as const)(
    "reports the wait only after its retry decision: %s", async scenario => {
      const f = await fixture(scenario.startsWith("interaction_") ? { contextSnapshot: { source: "issue.interaction.respond", externalChatContinuation: true,
        interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
        mutation: "interaction", wakeReason: "issue_commented" } } : {});
      const scheduled = { outcome: "scheduled" } as never;
      if (scenario === "scheduler_failed") f.deps.scheduleBoundedRetryForRun.mockRejectedValueOnce(new Error("fixture scheduler failure"));
      else if (scenario === "interaction_scheduled") f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible.mockResolvedValueOnce(scheduled);
      else f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce(scenario === "not_scheduled"
        ? { outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null } : scheduled);
      const error = scenario === "untrusted" ? new Error("reviewed_chat_execution_binding_not_ready") : new ReviewedChatBindingNotReadyError();
      await f.completion.failRunSetup(f.setup(error));
      const write = f.deps.setRunStatusIfRunning.mock.calls.find(call => call[1] === "failed");
      if (scenario === "untrusted") {
        // An ordinary setup failure keeps its report on the failed-status write.
        expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "setup_failed" });
        expect(write?.[3]).toEqual(expect.not.objectContaining({ reviewedChatRetry: expect.anything() }));
        expect(reportRunFailure).not.toHaveBeenCalled();
        return;
      }
      expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "reviewed_chat_execution_binding_not_ready" });
      expect(write?.[3]).toMatchObject({ phase: "setup", reviewedChatRetry: "pending" });
      expect(reportRunFailure).toHaveBeenCalledOnce();
      expect(reportRunFailure).toHaveBeenCalledWith(db,
        expect.objectContaining({ id: f.run.id, status: "failed", errorCode: "reviewed_chat_execution_binding_not_ready" }),
        expect.objectContaining({ phase: "setup", error,
          reviewedChatRetry: scenario === "scheduled" || scenario === "interaction_scheduled" ? "scheduled" : "not_scheduled" }));
    });
});
