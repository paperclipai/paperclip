import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workspaceOperations,
} from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "@paperclipai/paperclip-runner/testing";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";

describe("P6-16/P6-25/P6-28 native finalization recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "72000000-0000-4000-8000-000000000001";
  const agentId = "72000000-0000-4000-8000-000000000002";
  const issueId = "72000000-0000-4000-8000-000000000003";
  const contractId = "72000000-0000-4000-8000-000000000004";
  const runId = "72000000-0000-4000-8000-000000000005";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-recovery-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native recovery", issuePrefix: "NRC" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recovery agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover invalid native finalization",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Recover invalid native finalization",
        criteria: [{ id: "objective", requirement: "Recovery remains live" }],
      },
      canonicalSha256: "native-recovery-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch",
      completionContractId: contractId,
      completionContractSha256: "native-recovery-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId,
      issueId,
      runId,
      agentId,
      completionContractId: contractId,
      completionContractSha256: "native-recovery-contract",
      sourceInstanceId: "recovery-runner",
      controlPlaneSourceInstanceId: "recovery-control",
    });
    await port.openRun({
      ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId, normalizedSessionId: "recovery-session" },
      sourceInstanceId: "recovery-runner",
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "recovery-result",
    });
    const stored = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))
      .limit(1).then((rows) => rows[0]!);
    await db.update(nativeRunResults).set({
      resultJson: {
        ...(stored.resultJson as Record<string, unknown>),
        terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: "unknown" },
      },
    }).where(eq(nativeRunResults.id, stored.id));
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: runId,
      issueId,
      phase: "workspace_finalize",
      status: "succeeded",
    });
  }, 30_000);

  afterAll(async () => {
    await temporary.cleanup();
  });

  it("fails closed into bounded named recovery without consulting the live flag or falling back", async () => {
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([
      expect.objectContaining({ phase: "retryable_failure", failureCode: "native_finalization_invalid" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
    ]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "active", ownerAgentId: agentId, cause: "native_finalization_invalid" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toHaveLength(0);

    for (let retry = 0; retry < 2; retry += 1) {
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, runId));
      await reconcileNativeFinalizations(db, [runId]);
    }
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({
        phase: "terminal_failure",
        attempt: 3,
        failureCode: "native_finalization_retry_exhausted",
        nextAttemptAt: null,
      }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({ runtimeMode: "native", status: "failed", nativePhase: "terminal_failure" }),
    ]);
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([]);
  });
});
