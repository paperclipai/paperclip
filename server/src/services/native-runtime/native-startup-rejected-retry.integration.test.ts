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

import { executePaperclipNativeSession, NATIVE_PROVIDER_STARTUP_REJECTED } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

describe("native session.open the provider rejected before any provider work", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-startup-rejected-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Startup rejected", issuePrefix: "NSR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-test" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const rejection = (providerFailure: Record<string, unknown>) => {
    const commandResult = { commandId: "command_prp_00000002", commandType: "session.open", controllerSeq: 2,
      result: { code: "command_execution_failed", message: String(providerFailure.message), providerFailure }, status: "failed" };
    const reported = { ...commandResult, result: { code: "command_execution_failed", message: "Provider request failed" } };
    return Object.defineProperty(new Error(`PRP command session.open failed: ${JSON.stringify(reported)}`),
      "runnerCommandResult", { value: commandResult, enumerable: false });
  };
  const startupFailure = (fields: Record<string, unknown> = {}) => ({ schema: "paperclip.provider-failure.v1", provider: "openai",
    phase: "startup", category: "unknown", retryability: "unknown",
    message: "error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
    ...fields });

  async function rejectSessionOpen(failure: Error, attempt = 0, options: { remote?: boolean; recoveryHistory?: Record<string, unknown>[] } = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Plan the change", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt,
      ...(options.recoveryHistory ? { recoveryHistory: options.recoveryHistory } : {}) });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "gpt-test" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Plan the change.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    provider.execute.mockReset().mockRejectedValue(failure);
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
      ...(options.remote ? { runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: "/workspace",
        runner: { execute: vi.fn() } } as never } : {}), backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    return { issueId, runId, coordinator };
  }

  it("fails the run on the first deterministic rejection with a plain explanation, and Retry starts a new run", async () => {
    const { issueId, runId, coordinator } = await rejectSessionOpen(rejection(startupFailure({ category: "authentication",
      retryability: "requires_action", message: "error creating thread: the AI connection was revoked" })));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: NATIVE_PROVIDER_STARTUP_REJECTED, nextAttemptAt: null,
      failureDetail: expect.objectContaining({ recoveryMode: "bootstrap_retry", providerSessionEstablished: false,
        providerFailure: expect.objectContaining({ phase: "startup" }),
        nextAction: expect.stringContaining("Retry starts a new run") }) });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await expect(taskInterruptionPresentation(db, issue)).resolves.toMatchObject({ state: "failed", canRetry: true,
      providerFailure: expect.objectContaining({ phase: "startup" }) });
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

  it.each([
    startupFailure(),
    startupFailure({ message: "Query closed before response received" }),
    startupFailure({ category: "overloaded", retryability: "transient", httpStatus: 503 }),
  ])("retries an unknown or transient local startup failure on the same run: $message", async (failure) => {
    const { coordinator } = await rejectSessionOpen(rejection(failure));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "native_session_interrupted",
      failureDetail: expect.objectContaining({ recoveryMode: "bootstrap_retry" }) });
  }, 120_000);

  it("ends with Retry once the bounded startup retries are spent", async () => {
    const { issueId, coordinator } = await rejectSessionOpen(rejection(startupFailure({ message: "Query closed before response received" })), 2);
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_retry_exhausted", nextAttemptAt: null,
      failureDetail: expect.objectContaining({ nextAction: expect.stringContaining("retry the task") }) });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await expect(taskInterruptionPresentation(db, issue)).resolves.toMatchObject({ state: "failed", canRetry: true });
  }, 120_000);

  const exitProven = (error: Error) => Object.defineProperty(error, "runnerExitConfirmed", { value: true, enumerable: false });

  it("ends a remote startup rejection at once when the runner exit is not proven", async () => {
    const { coordinator } = await rejectSessionOpen(rejection(startupFailure()), 0, { remote: true });
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: NATIVE_PROVIDER_STARTUP_REJECTED });
    expect(coordinator.failureDetail).not.toHaveProperty("runnerExitConfirmed");
  }, 120_000);

  it("retries a remote startup rejection on the same run when the runner exit is proven", async () => {
    const { coordinator } = await rejectSessionOpen(exitProven(rejection(startupFailure())), 0, { remote: true });
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "native_session_interrupted",
      failureDetail: expect.objectContaining({ recoveryMode: "bootstrap_retry", originalFailureCode: "provider_session_open_rejected",
        runnerExitConfirmed: true, providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false }) });
  }, 120_000);

  it("stops a remote startup rejection that repeats the previous attempt's error, naming it, with Retry", async () => {
    // The first attempt's own failure write records the signature the second compares with.
    const first = await rejectSessionOpen(exitProven(rejection(startupFailure())), 0, { remote: true });
    const { issueId, coordinator } = await rejectSessionOpen(exitProven(rejection(startupFailure())), 1, { remote: true,
      recoveryHistory: [...(first.coordinator.recoveryHistory as Record<string, unknown>[]),
        { disposition: "bootstrap_incomplete", reason: "remote_runner_exited_before_provider_work" }] });
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: NATIVE_PROVIDER_STARTUP_REJECTED, nextAttemptAt: null,
      failureDetail: expect.objectContaining({ nextAction: expect.stringContaining("bwrap: loopback: Failed RTM_NEWADDR") }) });
    expect(coordinator.failureDetail?.nextAction).toContain("Retry starts a new run");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await expect(taskInterruptionPresentation(db, issue)).resolves.toMatchObject({ state: "failed", canRetry: true });
  }, 120_000);
});
