import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { createSavedWorkspaceLoader } from "./remote-workspaces.js";
import { boardRecoveryApp, db, failedRemotePreparation, receiptOnlyRecoveryApp, run, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("recovered scheduled preparation", () => {
  useWorkspaceRecoveryFixture(targets);

  async function scheduledPreparation(warning = false) {
    const f = await failedRemotePreparation("retained", false, warning), source = await run(f.runId);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId)).orderBy(heartbeatRunEvents.seq);
    const [parent] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, status: "failed", finishedAt: new Date(source.createdAt.getTime() - 1000),
      createdAt: new Date(source.createdAt.getTime() - 2000) }).returning();
    const due = new Date(Date.now() - 1000), reason = "ai_connection_pool_wait";
    await db.update(heartbeatRuns).set({ retryOfRunId: parent.id, scheduledRetryAt: due,
      scheduledRetryReason: reason, scheduledRetryAttempt: 1, sessionIdBefore: randomUUID(),
      contextSnapshot: { ...source.contextSnapshot, retryOfRunId: parent.id, retryReason: reason,
        scheduledRetryAt: due.toISOString(), scheduledRetryAttempt: 1 },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    await db.update(heartbeatRuns).set({ nextEventSeq: 1 }).where(eq(heartbeatRuns.id, f.runId));
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
      eventType: "lifecycle", stream: "system", level: "info",
      message: "Scheduled retry became due and was promoted to the queued run pool",
      payload: { scheduledRetryAt: due.toISOString(), scheduledRetryAttempt: 1, scheduledRetryReason: reason } });
    for (const event of events) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
      agentId: source.agentId, eventType: event.eventType, stream: event.stream, level: event.level,
      message: event.message, payload: event.payload });
    await recoverRetainedWorkspace(f.input);
    return f;
  }

  it.each([false, true])("delivers one HTTP Retry after a scheduled setup failure has recovered files (warning=%s)", async warning => {
    const f = await scheduledPreparation(warning), source = await run(f.runId), heartbeat = heartbeatService(db);
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() }, app = boardRecoveryApp();
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: f.runId,
      taskRetryRequestId: receipt.requestId, forceFreshSession: true } });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
      .toMatchObject({ status: "coalesced", runId: successors[0].id });
    expect(await run(f.runId)).toEqual(source);
    const remote = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId,
      workspaceId: f.workspaceId, snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
  }, 30_000);

  it.each(["attempt", "due", "reason", "context", "parent", "foreign", "provider", "extra", "controller", "stop"] as const)(
    "retains the saved Retry when scheduled preparation proof changes: %s", async gate => {
      const f = await scheduledPreparation(), source = await run(f.runId);
      const receipt = (await request(receiptOnlyRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      if (["attempt", "due", "reason", "extra"].includes(gate)) await db.update(heartbeatRunEvents).set({ payload: {
        scheduledRetryAt: (source.scheduledRetryAt!).toISOString(), scheduledRetryAttempt: 1,
        scheduledRetryReason: source.scheduledRetryReason,
        ...(gate === "attempt" ? { scheduledRetryAttempt: 2 } : gate === "due" ? { scheduledRetryAt: new Date(0).toISOString() }
          : gate === "reason" ? { scheduledRetryReason: "transient_failure" } : { unknown: true }),
      } }).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      if (gate === "context") await db.update(heartbeatRuns).set({ contextSnapshot: { ...source.contextSnapshot,
        scheduledRetryAttempt: 2 } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "parent") await db.update(heartbeatRuns).set({ retryOfRunId: null }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "foreign") await db.update(heartbeatRunEvents).set({ sourceEventId: randomUUID() })
        .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 1)));
      if (gate === "provider") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: source.agentId, eventType: "adapter.invoke", stream: "system", message: "provider dispatch" });
      if (gate === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      if (gate === "stop") await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson,
        cancellation: { source: "operator", expected: true, initiator: { type: "user", userId: "local-board" },
          reason: "Stop", recordedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0].runId).toBeNull();
    }, 30_000);
});
