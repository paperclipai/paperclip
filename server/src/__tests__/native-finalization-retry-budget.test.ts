import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workspaceOperations,
} from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_FINALIZATION_TEST_DATABASE_URL");

// Restart chaos w-20261110T044338-s20385/t03: three restarts resumed the run
// (provider attempt 3), the resumed turn's result was accepted, and the first
// transient finalization failure was judged against the provider attempt
// count. The coordinator went terminal at once and the issue rested in review
// with no Retry.
describe("native finalization retry budget after restart resumes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "72100000-0000-4000-8000-000000000001";
  const agentId = "72100000-0000-4000-8000-000000000002";
  const issueId = "72100000-0000-4000-8000-000000000003";
  const contractId = "72100000-0000-4000-8000-000000000004";
  const runId = "72100000-0000-4000-8000-000000000005";

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-retry-budget-");
    db = createDb(external ?? temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native retry budget", issuePrefix: "NRB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Budget agent", adapterType: "codex_local", status: "running" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Finalize after three resumes", status: "in_progress",
      assigneeAgentId: agentId, workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1", objective: "Finalize after three resumes",
        criteria: [{ id: "objective", requirement: "Finalization keeps its own budget" }],
      },
      canonicalSha256: "native-retry-budget-contract", createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch", nativeIssueId: issueId, nativeSessionId: runId,
      runnerInstanceId: contractId, completionContractId: contractId,
      completionContractSha256: "native-retry-budget-contract", contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: "native-retry-budget-contract", sourceInstanceId: contractId,
      controlPlaneSourceInstanceId: "budget-control",
    });
    await port.openRun({
      ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId, sessionId: runId },
      sourceInstanceId: contractId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "budget-result",
    });
    // Each finalization attempt fails, as a status race under contention did.
    const stored = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))
      .limit(1).then((rows) => rows[0]!);
    await db.update(nativeRunResults).set({
      resultJson: {
        ...(stored.resultJson as Record<string, unknown>),
        terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: "unknown" },
      },
    }).where(eq(nativeRunResults.id, stored.id));
    await db.insert(workspaceOperations).values({
      companyId, heartbeatRunId: runId, issueId, phase: "workspace_finalize", status: "succeeded",
    });
    // Saved as the previous release left it after three restart resumes: the
    // provider attempt count is spent and no finalization count exists yet.
    await db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, runId));
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  it("keeps a resumed run's first finalization failure retryable and still bounds finalization", async () => {
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([
      expect.objectContaining({ phase: "retryable_failure", failureCode: "native_finalization_invalid" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress" }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({
        nativePhase: "retryable_failure",
        resultJson: expect.objectContaining({ finalizationFailureCount: 1 }),
      }),
    ]);

    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, runId));
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([
      expect.objectContaining({ phase: "retryable_failure" }),
    ]);

    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, runId));
    await reconcileNativeFinalizations(db, [runId]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({ phase: "terminal_failure", failureCode: "native_finalization_retry_exhausted" }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({ resultJson: expect.objectContaining({ finalizationFailureCount: 3 }) }),
    ]);
  });
});
