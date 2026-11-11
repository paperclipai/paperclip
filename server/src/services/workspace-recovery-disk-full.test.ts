import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, costEvents, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readSystemRecovery } from "./system-recovery-state.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL } from "./remote-workspace-transport.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { finalizeNativeRun } from "./native-runtime/native-run-finalizer.js";
import { createSavedWorkspaceLoader, readRemoteWorkspaceAuthority } from "./remote-workspaces.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, db, receiptOnlyRecoveryApp, recoverRunHolds, run } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/** An accepted run whose save failed on a full sandbox disk, handed to the board. */
async function diskFullHold() {
  const f = await acceptedRemoteExport();
  const target = targets.get(f.lease.id)!, syncOut = target.runner!.syncOut!;
  const disk = { full: true, saves: 0 };
  target.runner!.syncOut = async operations => {
    disk.saves++;
    if (disk.full) throw new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
    return syncOut(operations);
  };
  await recoverRetainedWorkspace(f.input);
  await recoverRetainedWorkspace(f.input);
  expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted",
    failure: { retryClass: "user_action_required", cause: { label: "sandbox_disk_full" } } });
  // The route's own dispatch is replaced, so each test decides when it lands.
  const retry = async () => (await request(receiptOnlyRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
    .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body as { requestId: string; accepted: boolean; observedRunId: string };
  const runIds = async () => (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, f.companyId))).map(row => row.id).sort();
  const recoverAll = () => recoverRunHolds(f.input);
  return { ...f, disk, retry, runIds, recoverAll };
}

const wake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
const coordinator = async (runId: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;

/** The Retry applied the saved accepted result: no new run, and the source run and task finish from it. */
async function expectSavedResultApplied(f: Awaited<ReturnType<typeof diskFullHold>>, requestId: string, runsBefore: string[]) {
  expect(await f.runIds()).toEqual(runsBefore);
  expect(await wake(requestId)).toMatchObject({ status: "coalesced", runId: f.runId,
    payload: { taskRetry: { strategy: "finalize_result" } } });
  expect(await coordinator(f.runId)).toMatchObject({ phase: "workspace_finalizing", resultId: f.resultId,
    recoveryHistory: [expect.objectContaining({ kind: "preserved_result_finalization", generationId: requestId, resultId: f.resultId })] });
  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.action, "issue.saved_result_finalization_resumed")))).toEqual([expect.objectContaining({
    actorType: "system", entityId: f.issueId, runId: f.runId,
    details: expect.objectContaining({ requestId, resultId: f.resultId, strategy: "finalize_result" }) })]);
  await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
  expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
    .toMatchObject({ status: "done", executionRunId: null, checkoutRunId: null });
  expect((await run(f.runId)).status).toBe("succeeded");
  expect(await f.runIds()).toEqual(runsBefore);
  expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toEqual([]);
}

describe("saved-work recovery on a full sandbox disk", () => {
  useWorkspaceRecoveryFixture(targets);

  it("ends recovery at the first full-disk save with a named cause and a Retry that saves and applies the accepted result without a new turn", async () => {
    const f = await diskFullHold();
    const workspaceBefore = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0];
    const failed = readSystemRecovery((await action(f.actionId)).evidence);
    expect(failed).toMatchObject({ state: "exhausted", nextAttemptAt: null, attempts: 1, failure: {
      code: "export_interrupted", retryClass: "user_action_required",
      cause: { label: "sandbox_disk_full", code: "ENOSPC", status: null } } });
    const savesAtFailure = f.disk.saves;
    expect(savesAtFailure).toBeGreaterThan(0);

    await recoverRetainedWorkspace(f.input);
    await recoverRetainedWorkspace(f.input);
    expect(f.disk.saves).toBe(savesAtFailure);
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
    const runsBefore = await f.runIds();

    f.disk.full = false;
    const receipt = await f.retry();
    expect(receipt).toMatchObject({ accepted: true, observedRunId: f.runId });
    await f.recoverAll();
    const recovered = await action(f.actionId);
    expect(readWorkspaceRecovery(recovered.evidence)?.status).toBe("recovered");
    expect(readSystemRecovery(recovered.evidence)?.preservationOperationIds).toHaveLength(1);
    const authority = readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, f.workspaceId)))[0].metadata)!;
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: authority.snapshotId! });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    const savesAfterRetry = f.disk.saves;
    await f.recoverAll();
    expect(f.disk.saves).toBe(savesAfterRetry);
    expect(await f.runIds()).toEqual(runsBefore);
    // Retry dispatch lands after the save, before anything applied the result
    // (also replayed and concurrent). It applies the accepted result and
    // never starts another agent turn to repeat the finished work.
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
    await expectSavedResultApplied(f, receipt.requestId, runsBefore);
  }, 60_000);

  it("holds a Retry dispatched while another saved-work hold of the run is still settling, then applies the accepted result", async () => {
    const f = await diskFullHold();
    const runsBefore = await f.runIds();
    f.disk.full = false;
    const receipt = await f.retry();
    // The recovery worker saves the files for the board hold first and then
    // dispatches, while the hold Retry added for the same run is still
    // scheduled. The saved files are already verified at that point.
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    const pending = (await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${f.runId}`))).filter(hold => hold.id !== f.actionId);
    expect(pending.map(hold => readSystemRecovery(hold.evidence)?.state)).toContain("scheduled");
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
    expect(await f.runIds()).toEqual(runsBefore);
    expect(await wake(receipt.requestId)).toMatchObject({ status: "deferred_issue_execution",
      payload: { executionWait: { reason: "finalizing_saved_result" } } });
    await f.recoverAll();
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
    await expectSavedResultApplied(f, receipt.requestId, runsBefore);
  }, 60_000);

  it("does not hold a Retry for a settling hold when the run records an operator Stop", async () => {
    const f = await diskFullHold();
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, cancelledByUserId: "local-board" } })
      .where(eq(heartbeatRuns.id, f.runId));
    const runsBefore = await f.runIds();
    f.disk.full = false;
    const receipt = await f.retry();
    await recoverRetainedWorkspace(f.input);
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    expect((await f.runIds()).filter(id => !runsBefore.includes(id))).toHaveLength(1);
    expect(await coordinator(f.runId)).toMatchObject({ phase: "terminal_failure", recoveryHistory: [] });
  }, 60_000);

  it("keeps the named full-disk rest and a working Retry when the disk is still full", async () => {
    const f = await diskFullHold();
    const runsBefore = await f.runIds();
    const first = await f.retry();
    await f.recoverAll();
    await heartbeatService(db).resumeTaskRetry(f.companyId, first.requestId);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state: "exhausted",
      failure: { retryClass: "user_action_required", cause: { label: "sandbox_disk_full" } } });
    await f.recoverAll();
    expect((await action(f.actionId)).nextAction).toMatch(/sandbox disk is full/);
    expect(await f.runIds()).toEqual(runsBefore);
    expect(await coordinator(f.runId)).toMatchObject({ phase: "terminal_failure", recoveryHistory: [] });
    const issue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: true });

    // Once there is room, the next Retry saves and applies the result.
    f.disk.full = false;
    const second = await f.retry();
    await f.recoverAll();
    await heartbeatService(db).resumeTaskRetry(f.companyId, second.requestId);
    await expectSavedResultApplied(f, second.requestId, runsBefore);
  }, 60_000);

  it.each([
    { record: "no accepted result", prepare: async (f: Awaited<ReturnType<typeof diskFullHold>>) => {
      await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
    } },
    { record: "an accepted result that did not succeed", prepare: async (f: Awaited<ReturnType<typeof diskFullHold>>) => {
      await db.update(nativeRunResults).set({ resultJson: sql`jsonb_set(${nativeRunResults.resultJson}, '{terminal,runTerminalState}', '"failed"'::jsonb)` })
        .where(eq(nativeRunResults.id, f.resultId));
    } },
    // The result and saved files are proven, but the run records an operator
    // Stop, so applying the result is not provably wanted.
    { record: "an operator Stop recorded on the run", prepare: async (f: Awaited<ReturnType<typeof diskFullHold>>) => {
      const source = await run(f.runId);
      await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, cancelledByUserId: "local-board" } })
        .where(eq(heartbeatRuns.id, f.runId));
    } },
  ])("keeps today's Retry, one new run, with $record", async ({ prepare }) => {
    const f = await diskFullHold();
    await prepare(f);
    const runsBefore = await f.runIds();
    f.disk.full = false;
    const receipt = await f.retry();
    await f.recoverAll();
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(row => !runsBefore.includes(row.id));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId });
    expect(await coordinator(f.runId)).toMatchObject({ phase: "terminal_failure", recoveryHistory: [] });
  }, 60_000);
});
