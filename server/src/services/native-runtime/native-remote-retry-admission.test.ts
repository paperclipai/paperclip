import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, completionContracts, databaseWorkPending, reconcileDatabaseWork, heartbeatRunEvents, heartbeatRuns, issues, issueRelations,
  issueTreeHolds, issueTreeHoldMembers, issueRecoveryActions, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>(),
  executeNativeSession: provider.execute,
}));
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, remotePreparedWorkspace } from "../../__tests__/helpers/native-restart.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { readSystemRecovery, SYSTEM_RECOVERY_MAX_RETRIES } from "../system-recovery-state.js";

describeEmbeddedPostgres("remote native retry execution admission", () => {
  const environment = nativeRestartFixture();

  async function failedRemoteRun(storage: "classic" | "remote") {
    const { companyId, agentId, runtimeRoot } = environment.current;
    const fixture = await environment.seedRun(`REMOTE-RETRY-${storage}-${randomUUID()}`);
    await fixture.db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    const controller = { bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await fixture.db.update(nativeRunFinalizations).set({
      controllerBootId: controller.bootId, controllerGeneration: controller.generation,
      leaseOwner: controller.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({
      stateDirectory: resolve(runtimeRoot, fixture.runId),
      identity: { runId: fixture.runId, normalizedSessionId: fixture.native.normalizedSessionId,
        runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
        turnId: fixture.native.turnId, itemId: fixture.native.itemId },
      expectedRunnerVersion: "retry-admission-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}`,
    });
    authority.setCheckpointPersistence(nativeRunnerCheckpointWriter(fixture.db, {
      companyId, issueId: fixture.issueId, runId: fixture.runId, authorityRunId: fixture.runId,
      ...controller,
    }));
    await authority.flushCheckpoint();
    await authority.stop();
    const classic = remotePreparedWorkspace();
    const remote = { schema: "paperclip.remote-workspace-run.v1", workspaceId: classic.workspaceId,
      leaseId: classic.leaseId, providerLeaseId: classic.providerLeaseId, remoteCwd: classic.remoteCwd,
      epoch: 1, state: "prepared", snapshotId: null };
    const checkpoint = { backendKind: "acpx", driverKind: "acpx_runtime", sessionId: "provider-session",
      providerSessionId: "provider-session", activeTurnId: "retained-turn", semanticResult: null,
      pendingRuntimeRequests: [], terminalTurns: [], identity: { companyId, agentId,
        issueId: fixture.issueId, runId: fixture.runId, sessionId: fixture.native.normalizedSessionId } };
    await fixture.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
      processPid: 1386, processStartedAt: new Date("2026-11-01T12:00:00Z"),
      nativePhase: "retryable_failure", errorCode: "native_session_interrupted",
      runnerProfileJson: { ...fixture.preparedProfile, nativeExecutionInput: { binding: {
        companyId, agentId, issueId: fixture.issueId, runId: fixture.runId } }, sessionCheckpoint: checkpoint,
        ...(storage === "classic" ? { nativeWorkspaceSync: classic } : { remoteWorkspace: remote }) },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      leaseOwner: null, leaseExpiresAt: null, recoveryState: "resuming_session",
      failureCode: "native_session_interrupted", nextAttemptAt: new Date(0),
      failureDetail: { recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true,
        checkpointExists: true, providerEventsExist: true },
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.update(issues).set({ executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, fixture.issueId));
    return { ...fixture, companyId, agentId, checkpoint };
  }

  it.each(["classic", "remote"] as const)("reclaims the exact failed %s execution before remote inspection", async storage => {
    const fixture = await failedRemoteRun(storage);
    expect(await claimNativeSessionResumptions({ db: fixture.db, runnerInstanceId: "ordinary-resumer",
      runIds: [fixture.runId] })).toEqual([]);
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db,
      controller: environment.current.successor, restartKind: "hard", runIds: [fixture.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: fixture.runId, providerAttempt: 2 });
    expect((await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0])
      .toMatchObject({ executionRunId: fixture.runId, status: "in_progress", assigneeAgentId: fixture.agentId });
    expect((await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0])
      .toMatchObject({ status: "running", processPid: 1386,
        runnerProfileJson: { sessionCheckpoint: fixture.checkpoint } });
    expect((await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId)))[0])
      .toMatchObject({ attempt: 2, phase: "observed", recoveryState: "awaiting_runner_reattach" });
  });

  it.each(["done", "cancelled", "blocked", "paused-agent", "pending-agent-approval", "reassigned",
    "dependency", "tree-pause", "native-stop", "operator-stop", "execution-owner", "checkout-owner",
    "queued-input", "newer-completed-input", "wrong-checkpoint", "missing-authority"] as const)
  ("preserves a remote retry held by %s", async gate => {
    const f = await failedRemoteRun("remote");
    const { db } = f;
    if (["done", "cancelled", "blocked"].includes(gate)) {
      await db.update(issues).set({ status: gate }).where(eq(issues.id, f.issueId));
    } else if (gate === "paused-agent" || gate === "pending-agent-approval") {
      await db.update(agents).set({ status: gate === "paused-agent" ? "paused" : "pending_approval" }).where(eq(agents.id, f.agentId));
    } else if (gate === "reassigned") {
      const nextAgent = randomUUID();
      await db.insert(agents).values({ id: nextAgent, companyId: f.companyId, name: "Next owner", status: "active" });
      await db.update(issues).set({ assigneeAgentId: nextAgent }).where(eq(issues.id, f.issueId));
    } else if (gate === "dependency") {
      const dependency = randomUUID();
      await db.insert(issues).values({ id: dependency, companyId: f.companyId, title: "Required input", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: dependency, relatedIssueId: f.issueId, type: "blocks" });
    } else if (gate === "tree-pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause" });
      await db.insert(issueTreeHoldMembers).values({ holdId, companyId: f.companyId, issueId: f.issueId,
        issueTitle: "Paused work", issueStatus: "in_progress" });
    } else if (gate === "native-stop" || gate === "operator-stop") {
      await db.update(heartbeatRuns).set({ resultJson: gate === "native-stop"
        ? { nativeCancellation: { scope: "run", dispatchState: "pending" } }
        : { cancellation: { source: "operator", expected: true, initiator: { type: "user" },
          reason: "Stop", recordedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    } else if (["execution-owner", "checkout-owner", "queued-input", "newer-completed-input"].includes(gate)) {
      const nextRun = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_comment" },
        invocationSource: "manual", createdAt: new Date(Date.now() + 1_000),
        status: gate === "queued-input" ? "queued" : gate === "newer-completed-input" ? "succeeded" : "failed" });
      if (gate === "execution-owner" || gate === "checkout-owner") await db.update(issues)
        .set(gate === "execution-owner" ? { executionRunId: nextRun } : { checkoutRunId: nextRun }).where(eq(issues.id, f.issueId));
    } else if (gate === "wrong-checkpoint") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
        sessionCheckpoint: { ...f.checkpoint, identity: { ...f.checkpoint.identity, runId: randomUUID() } },
      } }).where(eq(heartbeatRuns.id, f.runId));
    } else if (gate === "missing-authority") {
      await db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId),
        eq(nativeRunnerCheckpoints.runId, f.runId)));
    }
    const beforeTask = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const beforeRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0];
    const beforeOwner = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
    const dispositions = await claimNativeRestartRecoveries({ db,
      controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
    expect(dispositions.every(value => value.kind === "blocked")).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeTask);
    const [afterRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [afterOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    if (["done", "cancelled", "newer-completed-input", "execution-owner", "checkout-owner", "queued-input"].includes(gate)) {
      expect(afterOwner).toMatchObject({ phase: "terminal_failure", attempt: 1, nextAttemptAt: null,
        failureDetail: { systemRecovery: { state: "exhausted" } } });
      expect(afterRun).toMatchObject({ status: "failed", processPid: beforeRun.processPid,
        runnerProfileJson: beforeRun.runnerProfileJson });
      return;
    }
    expect(afterRun).toEqual(beforeRun);
    expect(afterOwner.failureDetail).toMatchObject(beforeOwner.failureDetail!);
    expect({ ...afterOwner, nextAttemptAt: beforeOwner.nextAttemptAt, updatedAt: beforeOwner.updatedAt,
      recoveryHistory: beforeOwner.recoveryHistory, failureDetail: beforeOwner.failureDetail }).toEqual(beforeOwner);
    if (gate === "execution-owner") expect(afterOwner).toEqual(beforeOwner);
    else expect(afterOwner.nextAttemptAt!.getTime()).toBeGreaterThan(beforeOwner.nextAttemptAt!.getTime());
  });

  it("waits for the exact old controller lease and keeps future retries quiet", async () => {
    const f = await failedRemoteRun("remote");
    const now = new Date(), deadline = new Date(now.getTime() + 60_000);
    await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: deadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", now, runIds: [f.runId] })).toEqual([]);
    await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0), leaseOwner: "old-owner", leaseExpiresAt: deadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", now, runIds: [f.runId] })).toMatchObject([{ kind: "awaiting_evidence", reason: "remote_controller_lease_live" }]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
  });

  it("grants two competing controllers only one original remote execution", async () => {
    const f = await failedRemoteRun("remote");
    const claims = (await Promise.all([environment.current.successor,
      { ...environment.current.successor, bootId: randomUUID() }].map(controller =>
      claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] })))).flat();
    expect(claims.filter(claim => claim.kind === "reattach_remote_runner")).toHaveLength(1);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ controllerGeneration: 2, attempt: 2 });
    expect(await f.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toHaveLength(1);
  });

  it("rolls back the task, owner, run, and recovery event together", async () => {
    const f = await failedRemoteRun("remote");
    await expect(f.db.transaction(async tx => {
      const claims = await claimNativeRestartRecoveries({ db: tx as unknown as typeof f.db,
        controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
      expect(claims).toMatchObject([{ kind: "reattach_remote_runner" }]);
      throw new Error("rollback admission");
    })).rejects.toThrow("rollback admission");
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "retryable_failure", controllerGeneration: 1, leaseOwner: null, attempt: 1 });
    expect(await f.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toEqual([]);
  });

  it.each([
    ["succeeded", "2026-11-01T12:00:00.000600Z", 1, true],
    ["succeeded", "2026-11-01T12:00:00.000000Z", 1, true],
    ["failed", "2026-11-01T12:00:00.000000Z", 1, true],
    ["failed", "2026-11-01T12:00:00.000600Z", 1, true],
    ["succeeded", "2026-11-01T12:00:00.000599Z", 1, false],
    ["failed", "2026-11-01T12:00:00.000601Z", -1, true],
    ["failed", "2026-11-01T12:00:00.000600Z", -1, false],
  ] as const)("uses canonical source order for %s input at %s with ID offset %s", async (status, timestamp, offset, superseded) => {
    const f = await failedRemoteRun("remote");
    const idHex = (BigInt(`0x${f.runId.replaceAll("-", "")}`) + BigInt(offset)).toString(16).padStart(32, "0");
    const nextId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`;
    const sourceTimestamp = timestamp.endsWith(".000000Z") ? timestamp : "2026-11-01T12:00:00.000600Z";
    await f.db.update(heartbeatRuns).set({ createdAt: sql`${sourceTimestamp}::timestamptz` })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.insert(heartbeatRuns).values({ id: nextId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, invocationSource: "manual", status, createdAt: sql`${timestamp}::timestamptz` });
    const [disposition] = await claimNativeRestartRecoveries({ db: f.db,
      controller: environment.current.successor, restartKind: "hard", runIds: [f.runId] });
    expect(disposition).toMatchObject(superseded
      ? { kind: "blocked", reason: "native_retry_source_superseded" }
      : { kind: "reattach_remote_runner", providerAttempt: 2 });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId)
      .toBe(superseded ? null : f.runId);
  });

  it.each(["released", "retained"] as const)("exhausts the existing attempt budget after repeated remote snapshot failures with a %s task lock", async lock => {
    const f = await failedRemoteRun("remote");
    if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    const [issue] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId: f.companyId, runId: f.runId, issueId: f.issueId, agentId: f.agentId, executionWorkspaceId: f.runId },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: { identifier: issue.identifier!, title: issue.title, description: null, prompt: "Continue retained work.", workMode: "standard" },
      workspace: { cwd: environment.current.runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
    provider.execute.mockReset().mockRejectedValue(new Error("PRP command session.snapshot failed: original provider unavailable"));
    const controller = await currentNativeControllerIdentity();
    for (const attempt of [2, 3]) {
      await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [claim] = await claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] });
      expect(claim).toMatchObject({ kind: "reattach_remote_runner", providerAttempt: attempt });
      if (claim.kind !== "reattach_remote_runner") throw new Error("Expected exact remote recovery claim");
      await expect(executePaperclipNativeSession({ db: f.db, execution, runnerInstanceId: f.native.runnerInstanceId,
        leaseOwner: claim.leaseOwner, restartRecovery: claim,
        backend: { descriptor: async () => { throw new Error("Unexpected descriptor call"); },
          openSession: async () => { throw new Error("Unexpected session launch"); } },
      })).rejects.toThrow("PRP command session.snapshot failed");
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner).toMatchObject({ attempt, phase: attempt === 3 ? "terminal_failure" : "retryable_failure",
        failureCode: attempt === 3 ? "native_session_retry_exhausted" : "native_session_interrupted",
        recoveryState: attempt === 3 ? "blocked" : "resuming_session", leaseOwner: null });
      expect(owner.nextAttemptAt === null).toBe(attempt === 3);
      if (lock === "released") await f.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    }
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] })).toEqual([]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "blocked", executionRunId: null });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_session_interrupted",
        processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
  });

  it.each(["released", "retained"] as const)("does not admit another failed retry when the persisted provider budget is already exhausted with a %s task lock", async lock => {
    const f = await failedRemoteRun("remote");
    if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked", reason: "execution_recovery_budget_exhausted" }]);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", attempt: 3, leaseOwner: null, nextAttemptAt: null,
        failureCode: "native_restart_recovery_blocked", failureDetail: { reason: "execution_recovery_budget_exhausted" } });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure", processPid: 1386,
        runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect(await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.kind, "active_run_watchdog"))))
      .toMatchObject([{ ownerType: "board", evidence: { runId: f.runId, reason: "execution_recovery_budget_exhausted" } }]);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toEqual([]);
  });

  it("persists a blocked retry deadline and records only changed hold reasons", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const now = new Date();
    const attempt = (at: Date) => claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: at });
    const [first] = await attempt(now);
    expect(first).toMatchObject({ kind: "blocked", reason: "native_retry_admission_ineligible", transitionUnchanged: false });
    if (!("retryAt" in first) || !first.retryAt) throw new Error("missing first retry deadline");
    expect(first.retryAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(24_000);
    expect(first.retryAt.getTime() - now.getTime()).toBeLessThanOrEqual(36_000);
    expect(await attempt(new Date(first.retryAt.getTime() - 1))).toEqual([]);
    const [second] = await attempt(first.retryAt);
    expect(second).toMatchObject({ kind: "blocked", transitionUnchanged: true });
    if (!("retryAt" in second) || !second.retryAt) throw new Error("missing second retry deadline");
    expect(second.retryAt.getTime() - first.retryAt.getTime()).toBeGreaterThanOrEqual(48_000);
    let [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner).toMatchObject({ phase: "retryable_failure", attempt: 1,
      nextAttemptAt: second.retryAt, recoveryHistory: [{ reason: "native_retry_admission_ineligible" }] });
    await f.db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
    await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", createdAt: new Date(now.getTime() + 1_000) });
    expect(await attempt(second.retryAt)).toMatchObject([{ kind: "blocked", reason: "native_retry_source_superseded" }]);
    [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.recoveryHistory).toMatchObject([{ reason: "native_retry_admission_ineligible" }, { reason: "native_retry_source_superseded" }]);
  });

  it("registers recovery work intent before writing a blocked retry deadline", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const transaction = f.db.transaction.bind(f.db);
    let writes = 0;
    const interception = vi.spyOn(f.db, "transaction").mockImplementation((async (callback, options) => transaction(async tx => {
      const update = tx.update.bind(tx);
      const updates = vi.spyOn(tx, "update").mockImplementation((table => {
        if (Object.is(table, nativeRunFinalizations)) {
          writes += 1;
          expect(databaseWorkPending(f.db, DELIVERY_QUEUES.nativeProcessSessions)).toBe(true);
        }
        return update(table);
      }) as typeof tx.update);
      try { return await callback(tx); } finally { updates.mockRestore(); }
    }, options)) as typeof f.db.transaction);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked" }]);
      expect(writes).toBe(1);
    } finally { interception.mockRestore(); }
  });

  it.each(["done", "cancelled", "superseded"] as const)("settles a permanently %s remote retry without recurring work", async gate => {
    for (const lock of ["released", "retained"]) {
      const f = await failedRemoteRun("remote");
      if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId })
        .where(eq(issues.id, f.issueId));
      if (gate === "superseded") await f.db.insert(heartbeatRuns).values({ companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, status: "succeeded", createdAt: new Date(Date.now() + 1_000) });
      else await f.db.update(issues).set({ status: gate }).where(eq(issues.id, f.issueId));
      const onClaim = vi.fn();
      const environmentWake = vi.fn(), stopWatchingEnvironment = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
      const [disposition] = await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim });
      expect(disposition).toMatchObject({ kind: "blocked" });
      expect(disposition).not.toHaveProperty("retryAt");
      expect(onClaim).not.toHaveBeenCalled();
      expect(environmentWake).not.toHaveBeenCalled();
      stopWatchingEnvironment();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
        executionRunId: lock === "retained" ? f.runId : null, checkoutRunId: lock === "retained" ? f.runId : null });
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, attempt: 1 });
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
      const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
      const transaction = vi.spyOn(f.db, "transaction");
      try {
        for (const elapsed of [30_000, 60_000, 3_600_000]) expect(await claimNativeRestartRecoveries({ db: f.db,
          controller: environment.current.successor, restartKind: "hard", runIds: [f.runId],
          now: new Date(Date.now() + elapsed), onClaim })).toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
        expect(wake).not.toHaveBeenCalled();
      } finally { transaction.mockRestore(); unsubscribe(); }
    }
  });

  it.each(["paused", "Stop", "missing-authority"] as const)("bounds %s holds and preserves the provider and own task lock for manual reconciliation", async gate => {
    const f = await failedRemoteRun("remote");
    if (gate === "paused") await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "Stop") await f.db.update(heartbeatRuns).set({ resultJson: {
      nativeCancellation: { scope: "run", dispatchState: "pending" },
    } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "missing-authority") await f.db.delete(nativeRunnerCheckpoints)
      .where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId), eq(nativeRunnerCheckpoints.runId, f.runId)));
    await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, f.runId));
    let now = new Date();
    const onClaim = vi.fn();
    const environmentWake = vi.fn(), stopWatchingEnvironment = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
    for (let index = 0; index <= SYSTEM_RECOVERY_MAX_RETRIES; index += 1) {
      const [disposition] = await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], now, onClaim });
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const policy = readSystemRecovery(owner.failureDetail);
      expect(policy).not.toBeNull();
      expect(owner.attempt).toBe(3);
      if (index < SYSTEM_RECOVERY_MAX_RETRIES) {
        expect(owner.phase).toBe("retryable_failure");
        expect(policy).toMatchObject({ state: "awaiting_evidence" });
        expect(disposition).toHaveProperty("retryAt", owner.nextAttemptAt);
        now = owner.nextAttemptAt!;
      } else {
        expect(owner).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null });
        expect(policy).toMatchObject({ state: "exhausted" });
        expect(disposition).not.toHaveProperty("retryAt");
      }
    }
    expect(onClaim).not.toHaveBeenCalled();
    expect(environmentWake).not.toHaveBeenCalled();
    stopWatchingEnvironment();
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ executionRunId: f.runId });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toMatchObject([{ ownerType: "board", wakePolicy: null,
        evidence: { automaticAdmissionExhausted: true, executorStopEvidence: "unverified", providerPid: 1386, checkpointPreserved: true },
        nextAction: expect.stringContaining("original executor stop and state remain unverified") }]);
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: new Date(now.getTime() + 3_600_000) })).toEqual([]);
  });

  it("settles the old admission policy while preserving a newer active execution and its binding", async () => {
    const f = await failedRemoteRun("remote");
    const newerRunId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: newerRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "running", invocationSource: "manual", createdAt: new Date(Date.now() + 1_000) });
    await f.db.update(issues).set({ executionRunId: newerRunId, checkoutRunId: newerRunId }).where(eq(issues.id, f.issueId));
    const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    const [newer] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerRunId));
    const environmentWake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeEnvironmentSettlement, environmentWake);
    const onClaim = vi.fn();
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim }))
        .toMatchObject([{ kind: "blocked", reason: "native_retry_source_superseded" }]);
      expect(onClaim).not.toHaveBeenCalled();
      expect(environmentWake).not.toHaveBeenCalled();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(task);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerRunId)))[0]).toEqual(newer);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, failureDetail: { systemRecovery: { state: "exhausted" } } });
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
      const transactions = vi.spyOn(f.db, "transaction");
      try {
        expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
          restartKind: "hard", runIds: [f.runId], now: new Date(Date.now() + 3_600_000) })).toEqual([]);
        expect(transactions).not.toHaveBeenCalled();
      } finally { transactions.mockRestore(); }
    } finally { unsubscribe(); }
  });

  it("resumes the original provider when eligibility returns before admission backoff exhausts", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] });
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId], now: owner.nextAttemptAt! }))
      .toMatchObject([{ kind: "reattach_remote_runner", providerAttempt: 2, runId: f.runId }]);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "running", processPid: 1386, runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
  });

  it("does not settle permanently ineligible work while the original controller is active", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], liveRunExecutions: new Set([f.runId]) }))
        .toMatchObject([{ kind: "awaiting_evidence", reason: "current_controller_preparing" }]);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      expect(wake).not.toHaveBeenCalled();
      expect(await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    } finally { unsubscribe(); }
  });

  it("keeps a retry deadline that changed after discovery read-only and quiet", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const deadline = new Date(Date.now() + 60_000);
    const transaction = f.db.transaction.bind(f.db);
    const interception = vi.spyOn(f.db, "transaction").mockImplementationOnce((async (callback, options) => {
      await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: deadline }).where(eq(nativeRunFinalizations.runId, f.runId));
      return transaction(callback, options);
    }) as typeof f.db.transaction);
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "blocked", retryAt: deadline, transitionUnchanged: true }]);
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner).toMatchObject({ nextAttemptAt: deadline, recoveryHistory: [], phase: "retryable_failure", attempt: 1 });
      expect(wake).not.toHaveBeenCalled();
    } finally { interception.mockRestore(); unsubscribe(); }
  });

  it("rolls back work intent when the locked retry deadline update matches no row", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const name = `retry_noop_${f.runId.replaceAll("-", "")}`;
    await f.db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$begin return null; end$$`));
    await f.db.execute(sql.raw(`create trigger ${name} before update on native_run_finalizations for each row
      when (old.run_id = '${f.runId}'::uuid) execute function ${name}()`));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    try {
      await expect(claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId] })).rejects.toThrow("native_retry_deferral_claim_changed");
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      await reconcileDatabaseWork(f.db, DELIVERY_QUEUES.nativeProcessSessions);
      expect(databaseWorkPending(f.db, DELIVERY_QUEUES.nativeProcessSessions)).toBe(false);
    } finally {
      await f.db.execute(sql.raw(`drop trigger ${name} on native_run_finalizations`));
      await f.db.execute(sql.raw(`drop function ${name}()`));
    }
  });

  it("does not publish or log a deferred transition when an ineligible retry still has a live lease", async () => {
    const f = await failedRemoteRun("remote");
    const now = new Date(), leaseDeadline = new Date(now.getTime() + 60_000);
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller", leaseExpiresAt: leaseDeadline })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(f.db, DELIVERY_QUEUES.nativeProcessSessions, wake);
    try {
      for (let index = 0; index < 2; index += 1) {
        expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
          restartKind: "hard", runIds: [f.runId], now })).toMatchObject([{ kind: "blocked",
            retryAt: leaseDeadline, transitionUnchanged: true }]);
        expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
        expect(wake).not.toHaveBeenCalled();
      }
    } finally { unsubscribe(); }
  });

  it.each(["released", "retained"] as const)("keeps exhausted %s retries fenced behind live owners, Stops and newer input", async lock => {
    for (const gate of ["live-owner", "Stop", "newer-input", "missing-authority"]) {
      const f = await failedRemoteRun("remote");
      if (lock === "retained") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await f.db.update(nativeRunFinalizations).set({ attempt: 3,
        ...(gate === "live-owner" ? { leaseOwner: "live-controller", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
      }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (gate === "Stop") await f.db.update(heartbeatRuns).set({ resultJson: {
        nativeCancellation: { scope: "run", dispatchState: "pending" },
      } }).where(eq(heartbeatRuns.id, f.runId));
      if (gate === "newer-input") await f.db.insert(heartbeatRuns).values({ companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, status: "succeeded", createdAt: new Date(Date.now() + 1_000) });
      if (gate === "missing-authority") await f.db.delete(nativeRunnerCheckpoints)
        .where(and(eq(nativeRunnerCheckpoints.companyId, f.companyId), eq(nativeRunnerCheckpoints.runId, f.runId)));
      const onClaim = vi.fn();
      expect((await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
        restartKind: "hard", runIds: [f.runId], onClaim }))[0].kind).toBe(gate === "live-owner" ? "awaiting_evidence" : "blocked");
      expect(onClaim).not.toHaveBeenCalled();
      expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(lock === "retained" ? f.runId : null);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: gate === "newer-input" ? "terminal_failure" : "retryable_failure", attempt: 3 });
      const actions = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      if (gate === "newer-input") expect(actions).toMatchObject([{ ownerType: "board", wakePolicy: null }]);
      else expect(actions).toEqual([]);
    }
  });

  it("preserves the charged attempt when replacing an active remote controller", async () => {
    const f = await failedRemoteRun("remote");
    await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    await f.db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 2, phase: "observed", failureCode: null, failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "reattach_remote_runner", providerAttempt: 2 }]);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "observed", attempt: 2, controllerGeneration: 2 });
  });

  it("ignores another company's newer input when reclaiming this company's execution", async () => {
    const f = await failedRemoteRun("remote");
    const foreignCompany = randomUUID(), foreignAgent = randomUUID();
    await f.db.insert(companies).values({ id: foreignCompany, name: "Other company", issuePrefix: "FOREIGN" });
    await f.db.insert(agents).values({ id: foreignAgent, companyId: foreignCompany, name: "Other agent", status: "active" });
    await f.db.insert(heartbeatRuns).values({ companyId: foreignCompany, agentId: foreignAgent,
      status: "queued", contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 1_000) });
    expect(await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] })).toMatchObject([{ kind: "reattach_remote_runner" }]);
  });
});
