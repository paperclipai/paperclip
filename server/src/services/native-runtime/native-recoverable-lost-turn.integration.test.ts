import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PersistedNativeSession } from "@paperclipai/paperclip-runner";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

const LOST_TURN_MESSAGE = "The runner restored the conversation after process loss, but the previous turn is no longer active.";

describe("a lost turn that still ends the run after a restore", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-recoverable-lost-turn-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Lost turn", issuePrefix: "LST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lost turn worker", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "test-model" } });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it.each([true, false])("keeps a lost turn (recoverable %s) on the hold the replacement lane continues", async (recoverable) => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Lost turn task", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, contextSnapshot: { issueId } }).returning();
    const [issue] = await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId)).returning();
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const identity = { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId };
    const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId: native.normalizedSessionId, identity,
      providerSessionId: "provider-thread", activeTurnId: null, pendingRuntimeRequests: [], goal: null, semanticResult: null,
      terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "yielded" } };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.checkpointSession?.(snapshot);
      throw new NativeProviderTerminalFailure("provider_turn_lost_on_restore", recoverable, LOST_TURN_MESSAGE);
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } })
      .catch(() => undefined);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(saved.runnerProfileJson).toMatchObject({ sessionCheckpoint: { terminal: { runTerminalState: "failed" } } });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_provider_terminal_failed", nextAttemptAt: null });
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(holds).toEqual([expect.objectContaining({ kind: "active_run_watchdog", cause: "native_provider_terminal_failed",
      evidence: expect.objectContaining({ runId }) })]);
    expect(EXECUTION_RECONCILIATION_CAUSES).toContain(holds[0]!.cause);
  });
});
