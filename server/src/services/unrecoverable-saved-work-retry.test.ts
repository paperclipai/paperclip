import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { activityLog, agentWakeupRequests, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, workspaceOperations } from "@paperclipai/db";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt,
  SystemRecoveryFailure } from "./system-recovery-state.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { action, boardRecoveryApp, db, failedWarmSource, run, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

type Shape = { code: "source_unavailable" | "allocation_ownership_ambiguous" | "archive_unsafe"; retryClass: "use_alternative_strategy" | "service_required";
  sandbox: "destroyed" | "stopped" };

const shapes: Array<[string, Shape]> = [
  ["the sandbox that held the saved files was destroyed", { code: "source_unavailable", retryClass: "use_alternative_strategy", sandbox: "destroyed" }],
  ["Paperclip cannot prove which runs used the shared sandbox", { code: "allocation_ownership_ambiguous", retryClass: "service_required", sandbox: "stopped" }],
];

describe("Retry of a task whose saved files cannot be recovered", () => {
  useWorkspaceRecoveryFixture(targets);

  async function exhaustedExport(shape: Shape) {
    const f = await failedWarmSource(true);
    const spent = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId, randomUUID()))!,
      new SystemRecoveryFailure(shape.code, shape.retryClass), { now: Date.now() - 60_000 });
    const held = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...held.evidence, systemRecovery: spent,
      workspaceRecovery: { ...(held.evidence.workspaceRecovery as Record<string, unknown>), status: "blocked", retryable: true } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      leasePolicy: shape.sandbox === "destroyed" ? "retain_on_failure" : "reuse_by_environment",
      metadata: { ...lease.metadata, remoteExecutionTermination: remoteTerminationReceipt(lease,
        { providerLeaseId: f.providerLeaseId, state: shape.sandbox }) } }).where(eq(environmentLeases.id, lease.id));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.retry.requestId!));
    const [sourceLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    return { ...f, sourceLease };
  }

  async function task(issueId: string) {
    return (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  }

  async function pressRetry(f: { companyId: string; issueId: string; runId: string }) {
    const receipt = (await request(boardRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body as { requestId: string };
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0]!;
  }

  it.each(shapes)("offers a Retry that continues the task when %s", async (_name, shape) => {
    const f = await exhaustedExport(shape);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ cause: "native_workspace_sync_out_retry_exhausted", canRetry: true });
    expect(blocker?.nextAction).toContain("Retry continues the task in a new workspace from its recorded work");
    expect(blocker?.nextAction).not.toMatch(/runs the check again|Paperclip is updated/);
    expect(await taskInterruptionPresentation(db, await task(f.issueId))).toMatchObject({ canRetry: true });
  }, 60_000);

  it.each(shapes)("starts a fresh run from the recorded work when %s", async (_name, shape) => {
    const f = await exhaustedExport(shape);
    const wake = await pressRetry(f);
    expect(wake.payload?.executionWait).toBeUndefined();
    expect(wake).toMatchObject({ status: "coalesced", runId: expect.any(String),
      payload: { taskRetry: { strategy: "fresh_isolated_workspace" } } });
    const successor = await run(wake.runId!);
    expect(["queued", "running"]).toContain(successor.status);
    expect(successor.contextSnapshot).toMatchObject({ taskRetryRequestId: wake.id });

    const settled = await action(f.actionId);
    expect(settled).toMatchObject({ status: "resolved" });
    expect(readSystemRecovery(settled.evidence)).toMatchObject({ state: "exhausted", freshAttemptRunId: successor.id,
      failure: { code: shape.code } });
    expect(settled.nextAction).toContain("could not recover the unsaved files");

    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system")));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("Paperclip could not recover the unsaved files from the previous run");
    expect(notices[0]!.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const [sourceLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(sourceLease).toMatchObject({ status: f.sourceLease.status, leasePolicy: f.sourceLease.leasePolicy,
      providerLeaseId: f.sourceLease.providerLeaseId });
    expect(await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.recovery_generation_replaced")))).toEqual([]);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.retryOfRunId, f.runId)))).toEqual([]);
  }, 60_000);

  it("keeps a Retry out of a fresh attempt that would import a succeeded snapshot whose archive is unsafe", async () => {
    const f = await exhaustedExport({ code: "archive_unsafe", retryClass: "service_required", sandbox: "stopped" });
    const [snapshot] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, phase: "workspace_recovery_snapshot", status: "succeeded",
      metadata: { schema: "paperclip.workspace-recovery-snapshot.v1", leaseId: f.lease.id,
        archive: { objectKey: `${f.companyId}/workspace-recovery/${f.runId}/../../escape.tar`, sha256: "0".repeat(64), byteSize: 1 } } }).returning();
    const wake = await pressRetry(f);
    expect(wake.runId).toBeNull();
    expect(wake.payload?.taskRetry).not.toMatchObject({ strategy: "fresh_isolated_workspace" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.issueId, f.issueId), eq(heartbeatRuns.status, "queued")))).toEqual([]);
    expect(await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system")))).toEqual([]);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.freshAttemptRunId).toBeNull();
    const [kept] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, snapshot.id));
    expect(kept.status).toBe("succeeded");
  }, 60_000);
});
