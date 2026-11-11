import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readSystemRecovery } from "./system-recovery-state.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL } from "./remote-workspace-transport.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { createSavedWorkspaceLoader, readRemoteWorkspaceAuthority } from "./remote-workspaces.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, db, receiptOnlyRecoveryApp } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("saved-work recovery on a full sandbox disk", () => {
  useWorkspaceRecoveryFixture(targets);

  it("ends recovery at the first full-disk save with a named cause and a Retry that saves once there is room", async () => {
    const f = await acceptedRemoteExport();
    const target = targets.get(f.lease.id)!, syncOut = target.runner!.syncOut!;
    let full = true, saves = 0;
    target.runner!.syncOut = async operations => {
      saves++;
      if (full) throw new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
      return syncOut(operations);
    };
    const workspaceBefore = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0];

    await recoverRetainedWorkspace(f.input);
    const failed = readSystemRecovery((await action(f.actionId)).evidence);
    expect(failed).toMatchObject({ state: "exhausted", nextAttemptAt: null, attempts: 1, failure: {
      code: "export_interrupted", retryClass: "user_action_required",
      cause: { label: "sandbox_disk_full", code: "ENOSPC", status: null } } });
    const savesAtFailure = saves;
    expect(savesAtFailure).toBeGreaterThan(0);

    await recoverRetainedWorkspace(f.input);
    await recoverRetainedWorkspace(f.input);
    expect(saves).toBe(savesAtFailure);
    const handedOff = await action(f.actionId);
    expect(handedOff).toMatchObject({ status: "active", ownerType: "board" });
    expect(handedOff.nextAction).toMatch(/sandbox disk is full/);
    expect(handedOff.nextAction).toMatch(/Retry saves the files again/);

    const workspaceAfter = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0];
    expect(readRemoteWorkspaceAuthority(workspaceAfter.metadata)?.snapshotId)
      .toBe(readRemoteWorkspaceAuthority(workspaceBefore.metadata)?.snapshotId ?? null);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    const staging = path.join(f.remote, ".paperclip-runtime", "workspace-snapshots");
    for (const attempt of await readdir(staging).catch(() => [] as string[]))
      expect((await readdir(path.join(staging, attempt))).filter(name => name.startsWith("capture-"))).toEqual([]);

    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: true, observedRunId: f.runId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId,
      workspaceRecovery: { canRetry: true } });
    const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));

    full = false;
    const app = receiptOnlyRecoveryApp();
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
    expect(receipt).toMatchObject({ accepted: true, observedRunId: f.runId });
    await recoverRetainedWorkspace(f.input);
    const recovered = await action(f.actionId);
    expect(readWorkspaceRecovery(recovered.evidence)?.status).toBe("recovered");
    expect(readSystemRecovery(recovered.evidence)?.preservationOperationIds).toHaveLength(1);
    const authority = readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, f.workspaceId)))[0].metadata)!;
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: authority.snapshotId! });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    const savesAfterRetry = saves;
    await recoverRetainedWorkspace(f.input);
    expect(saves).toBe(savesAfterRetry);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .toEqual(runsBefore);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
    const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(row => row.id !== f.runId);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId });
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.idempotencyKey, `task-retry-dispatch:${receipt.requestId}`)))).toHaveLength(1);
  }, 60_000);
});
