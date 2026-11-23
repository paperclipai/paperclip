import { randomBytes, randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { legacyExecutionNeedsReconciliationWithEvidence, legacyReconciliationRunFields, terminalizeLegacyExecution } from "../legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("reconciliation source PostgreSQL reads", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string;
  const launchKeys = ["executionContinuation", "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown",
    "paperclipTaskMarkdownCompact", "paperclipTaskAssignment", "paperclipTaskAssignmentCompact", "paperclipWorkspace",
    "paperclipEnvironment", "paperclipContinuationSummary"];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("reconciliation-source-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery reads", issuePrefix: "RCR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery worker", adapterType: "process", status: "active" });
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const payload = randomBytes(64 * 1024).toString("base64");
    const contextSnapshot = { ...Object.fromEntries(launchKeys.map(key => [key, { prompt: payload }])),
      issueId: randomUUID(), taskId: randomUUID(), executionWorkspaceId: randomUUID(),
      executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 3 },
      failureRetriesBeforeAiConnectionWait: 1, failureRetriesBeforeWorkspaceWait: 1,
      conversationSessionGeneration: 7, connectionIntentResolution: "existing_connection", source: "connection_intent.resolved",
      interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction", interactionId: randomUUID(),
      futureControl: { nonce: "retained", nested: null }, cancellation: { state: "pending" },
    };
    const [full] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      errorCode: "process_lost", contextSnapshot, resultJson: { futureOutput: { retained: true } },
      runnerProfileJson: { adapterDispatch: { adapterType: "process" }, futureControl: { retained: true } },
      ...patch,
    }).returning();
    const [selected] = await db.select(legacyReconciliationRunFields).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, full!.id)));
    return { full: full!, selected: selected! };
  }

  it.each(["native", "legacy"])("omits unused launch text and preserves current control fields (%s)", async runtimeMode => {
    const profile = { nativeExecutionInput: { prompt: randomBytes(128 * 1024).toString("base64") }, futureControl: { retained: true } };
    const f = await fixture({ runtimeMode, ...(runtimeMode === "native" ? { runnerProfileJson: profile } : {}) });
    const expected = { ...f.full.contextSnapshot };
    for (const key of launchKeys) delete expected[key];
    expect(f.selected).toEqual({ ...f.full, contextSnapshot: expected,
      runnerProfileJson: runtimeMode === "native" ? { futureControl: profile.futureControl } : f.full.runnerProfileJson });
    expect(Buffer.byteLength(JSON.stringify(f.full))).toBeGreaterThan(800_000);
    expect(Buffer.byteLength(JSON.stringify(f.selected))).toBeLessThan(8192);
    expect(executionFailureRetryCount(f.selected)).toBe(executionFailureRetryCount(f.full));
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, f.selected))
      .toBe(await legacyExecutionNeedsReconciliationWithEvidence(db, f.full));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.full.id)))[0]).toEqual(f.full);
  });

  it.each([null, [], ["unexpected"], "scalar", 42].map(value => ({ value })))("preserves non-object JSON $value", async ({ value }) => {
    for (const runtimeMode of ["native", "legacy"]) {
      const f = await fixture({ runtimeMode,
        contextSnapshot: value as typeof heartbeatRuns.$inferInsert.contextSnapshot,
        runnerProfileJson: value as typeof heartbeatRuns.$inferInsert.runnerProfileJson,
      });
      expect(f.selected).toEqual(f.full);
    }
  });

  it.each([
    { status: "failed", errorCode: "setup_failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
    { status: "cancelled", errorCode: "cancelled", resultJson: { executionCancellation: { state: "acknowledged" },
      executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } } },
    { status: "cancelled", errorCode: "cancelled", resultJson: { executionCancellation: { state: "requested" },
      executionRecovery: { kind: "interrupted", providerStopped: false, sessionPreserved: true, actionOutcomes: "unknown" } } },
    { status: "cancelled", errorCode: "ai_connection_busy", resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } },
    { status: "cancelled", errorCode: "workspace_busy", resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false } } },
    { status: "failed", errorCode: "workspace_restore_failed", resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } },
    { status: "failed", errorCode: "process_lost", resultJson: { conversationContinuation: "continue_conversation_v1" } },
    { status: "cancelled", errorCode: "issue_waiting_for_response", resultJson: { stopReason: "issue_waiting_for_response", timeoutSource: "stale_queued_run_gate" } },
  ])("keeps reconciliation, cancellation, and retry decisions ($errorCode)", async patch => {
    const f = await fixture(patch);
    expect(f.selected.resultJson).toEqual(f.full.resultJson);
    expect(executionFailureRetryCount(f.selected)).toBe(executionFailureRetryCount(f.full));
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, f.selected))
      .toBe(await legacyExecutionNeedsReconciliationWithEvidence(db, f.full));
  });

  it("keeps full stored input and newer ownership when the projected source is terminalized", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover the stopped source", status: "in_progress", assigneeAgentId: agentId });
    const f = await fixture({ issueId, contextSnapshot: { issueId, paperclipTaskMarkdown: randomBytes(128 * 1024).toString("base64"),
      executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } } });
    const [successor] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "running" }).returning();
    await db.update(issues).set({ executionRunId: successor!.id, checkoutRunId: successor!.id }).where(eq(issues.id, issueId));
    await terminalizeLegacyExecution({ db, run: f.selected, status: "failed", fromStatuses: ["failed"] });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.full.id));
    expect(stored).toMatchObject({ contextSnapshot: f.full.contextSnapshot, runnerProfileJson: f.full.runnerProfileJson, resultJson: f.full.resultJson });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
      .toMatchObject({ executionRunId: successor!.id, checkoutRunId: successor!.id });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .toEqual([expect.objectContaining({ cause: "legacy_execution_requires_reconciliation", ownerType: "board",
        evidence: expect.objectContaining({ runId: f.full.id, attempt: 3 }) })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
  });
});
