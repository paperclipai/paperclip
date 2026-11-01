import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, costEvents, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { createRunUsageRecorder } from "../usage-receipts.js";
import { createCostAccountingReconciler } from "../run-cost-accounting.js";
import { registerCostAccountingWork } from "../budget-enforcement-worker.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";

describe("native Stop accounting after the last usage receipt", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-stop-accounting-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it.each([true, false])("wakes settlement after Stop closure while preserving incomplete receipt debt (complete=%s)", async complete => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped accounting", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", status: "active", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Resume after Stop", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, invocationSource: "on_demand", costAccountingPending: true }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Keep the task context.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const usage = await createRunUsageRecorder(db, { companyId, runId, adapterType: "paperclip_runner" });
    const reconcile = vi.fn(createCostAccountingReconciler(db));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const worker = registerCostAccountingWork(db, coordinator, reconcile);
    const readRun = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
    await worker.ready;
    const event = (eventType: string, sourceSeq: number, payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: `stop-accounting-${sourceSeq}`, sourceSeq,
      sourceKind: "runner", eventType, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload,
    } as PrpEvent);
    provider.execute.mockReset().mockImplementationOnce(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId },
        backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event("turn.started", 1, {}));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: {
        cancelledByActorType: "user", cancelledByUserId: "local-board", nativeCancellation: {
          schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run", reasonCode: "cancellation_run_only",
          dispatched: true, dispatchState: "acknowledged", intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
        },
      } }).where(eq(heartbeatRuns.id, runId));
      const beforeReceipt = reconcile.mock.calls.length;
      await options.controlPlane.appendEvent(event("item.completed", 2, { kind: "usage", usage: {
        runDelta: { inputTokens: 120, outputTokens: 10, providerCostUsd: 0.25 }, runDeltaComplete: complete,
      } }));
      await options.controlPlane.appendEvent(event("turn.interrupted", 3, { status: "interrupted" }));
      await expect.poll(() => reconcile.mock.calls.length).toBeGreaterThan(beforeReceipt);
      expect((await readRun()).usageJson?.accountingReceiptReady).toBe(complete);
      expect((await readRun()).costAccountingPending).toBe(true);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
      beforeClosure = reconcile.mock.calls.length;
      throw new Error("native_finalization_missing: session returned no semantic result");
    });
    const unexpected = async () => { throw new Error("Unexpected real provider access"); };
    let beforeClosure = 0;
    try {
      await expect(executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
        backend: { descriptor: unexpected, openSession: unexpected }, onUsage: receipt => usage.capture(receipt).then(() => undefined) }))
        .rejects.toThrow("native_cancellation_pending_recovery");
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled" });
      await expect.poll(() => reconcile.mock.calls.length).toBeGreaterThan(beforeClosure);
      if (!complete) {
        expect((await readRun()).costAccountingPending).toBe(true);
        expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
        expect(coordinator.nextWakeAt()).toBeNull();
        await usage.capture({ complete: true, provider: "openai", model: "test-model", billingType: "metered_api",
          usageBasis: "per_run", usage: { inputTokens: 120, outputTokens: 10 }, costUsd: 0.25 });
      }
      await expect.poll(async () => (await readRun()).costAccountingPending, { timeout: 1500 }).toBe(false);
      await reconcile();
      await reconcile();
      expect((await readRun()).status).toBe("cancelled");
      const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      expect(charges).toHaveLength(1);
      expect(charges[0].costCents).toBe(25);
      expect(provider.execute).toHaveBeenCalledOnce();
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally { worker.stop(); await coordinator.stop(); }
  }, 30_000);
});
