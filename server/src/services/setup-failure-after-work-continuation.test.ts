import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { recordRequiredWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { useWorkspaceRecoveryFixture, db, run, seed } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("a native run that already did work and then failed setup", () => {
  useWorkspaceRecoveryFixture(targets);

  async function failedAfterWork(errorCode = "setup_failed", providerWorkStarted = true) {
    const f = await seed("native");
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    const finishedAt = new Date();
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ errorCode, error: "Bad Gateway", nativePhase: "terminal_failure",
      startedAt: new Date(finishedAt.getTime() - 13 * 60_000), finishedAt,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" },
      ...(providerWorkStarted ? {} : { resultJson: { ...source.resultJson,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }) }).where(eq(heartbeatRuns.id, f.runId));
    for (const eventType of ["turn.started", "tool.execution.started", "tool.execution.completed"])
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
        eventType, stream: "system", level: "info", message: eventType, payload: {} });
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: finishedAt, lastStatusDecisionId: null })
      .where(eq(issues.id, f.issueId));
    await recordRequiredWorkspaceRestoreFailure(db, await run(f.runId), (await run(f.runId)).resultJson!);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(hold).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: expect.objectContaining({ automaticRecovery: expect.objectContaining({ replay: "blocked" }) }) });
    return { ...f, holdId: hold!.id, agentId: source.agentId, service: heartbeatService(db, { environmentRuntime: f.environmentRuntime }) };
  }

  const shown = async (issueId: string) => {
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    return taskInterruptionPresentation(db, task!);
  };
  const successors = (companyId: string, runId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, runId), eq(heartbeatRuns.retryOfRunId, runId)));
  const disposition = async () => {
    resetBacklogContinuationPacingForTests(db);
    await settleUnrecoverableExecutions(db);
  };

  it("continues in a fresh run as soon as its saved work is recovered, and never offers Retry", async () => {
    const f = await failedAfterWork();
    const noRetry = { responsibility: "system", state: "working", canRetry: false };

    expect(await shown(f.issueId)).toMatchObject(noRetry);
    await disposition();
    expect(await successors(f.companyId, f.runId)).toEqual([]);
    expect(await shown(f.issueId)).toMatchObject(noRetry);

    await vi.waitFor(async () => {
      await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, current => f.service.resumeRemoteStopComments(current)) ?? []);
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId));
      expect(readSystemRecovery(hold!.evidence)?.state).toBe("complete");
    }, { timeout: 10_000, interval: 10 });
    const [recovered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId));
    const check = recovered!.evidence.freshContinuationCheck as { nextCheckAt: number } | undefined;
    if (check) expect(check.nextCheckAt).toBeLessThanOrEqual(Date.now());
    expect(await shown(f.issueId)).toMatchObject(noRetry);

    const decidedAt = Date.now();
    await disposition();
    await deliverReconciledExecutions(db, f.service.wakeup);
    const next = await successors(f.companyId, f.runId);
    expect(next).toHaveLength(1);
    expect(next[0]!.createdAt.getTime() - decidedAt).toBeLessThan(5_000);
    expect(next[0]!.contextSnapshot).toMatchObject({ previousRunId: f.runId, forceFreshSession: true,
      wakeReason: "issue_recovery_action_restored" });
    expect(await shown(f.issueId)).toMatchObject({ state: "working", canRetry: false });
  }, 60_000);

  it("leaves a setup failure before any provider work on its Retry path", async () => {
    const f = await failedAfterWork("setup_failed", false);
    await disposition();
    expect(await successors(f.companyId, f.runId)).toEqual([]);
    expect(await shown(f.issueId)).not.toMatchObject({ state: "working" });
  }, 60_000);

  it("leaves a person-owned setup failure for the person", async () => {
    const f = await failedAfterWork("configuration_incomplete");
    await disposition();
    expect(await successors(f.companyId, f.runId)).toEqual([]);
    expect(await shown(f.issueId)).not.toMatchObject({ state: "working" });
  }, 60_000);
});
