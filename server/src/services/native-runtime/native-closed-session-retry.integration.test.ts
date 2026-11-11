import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession, NATIVE_PROVIDER_SESSION_CLOSED } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

// Chaos w-20261111T011704-s9107/t05 (claude, TM2): a cut-off ACPX turn start
// left this run's session closed with the prompt possibly sent. Every same-run
// resume got "ACPX session is not open"; the board offered Retry only after
// three attempts (about 95 s). The Runner now classifies that refusal, and
// Retry starts a new run with a fresh provider session.
describe("native turn start refused on a closed provider session", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-closed-session-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Closed session", issuePrefix: "NCS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", agent: "claude", model: "claude-test" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const refusal = (result: Record<string, unknown>) => {
    const commandResult = { commandId: "command_lab_1", commandType: "turn.start", controllerSeq: 10, result, status: "failed" };
    return Object.defineProperty(new Error(`PRP command turn.start failed: ${JSON.stringify(commandResult)}`),
      "runnerCommandResult", { value: commandResult, enumerable: false });
  };

  async function refuseTurnStart(failure: Error) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the brief", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Write the brief.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    // An established provider session: same-run resume is the ordinary recovery.
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
      sessionCheckpoint: { backendKind: "mock", providerSessionId: "claude-session" } } }).where(eq(heartbeatRuns.id, runId));
    provider.execute.mockReset().mockRejectedValue(failure);
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    return { issueId, runId, coordinator };
  }

  it("offers Retry on the first refusal, and Retry starts a new run", async () => {
    const { issueId, runId, coordinator } = await refuseTurnStart(refusal({ code: "command_execution_failed",
      message: "ACPX session is not open", classification: "provider_session_closed" }));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: NATIVE_PROVIDER_SESSION_CLOSED, nextAttemptAt: null });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await expect(taskInterruptionPresentation(db, issue)).resolves.toMatchObject({ state: "failed", canRetry: true });
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.contextSnapshot?.issueId === issueId && r.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);

  it("keeps a same-run retry when the Runner proved the prompt never left", async () => {
    const { coordinator } = await refuseTurnStart(refusal({ code: "command_execution_failed",
      message: "ACPX turn start failed before its prompt reached the provider: ACPX sidecar request timed out at turn.start" }));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "native_session_interrupted" });
  }, 120_000);
});
