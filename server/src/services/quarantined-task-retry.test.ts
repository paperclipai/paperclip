import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRunEvents,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executeNativeSession, nativeSessionCleanupBlock, onNativeSessionCleanupSettled, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import type { NativeSession } from "../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { instanceSettingsService } from "./instance-settings.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { verifyStoppedNativeSessionForContinuation } from "./native-runtime/native-session-executor.js";
import { requestTaskRetry } from "./task-retry.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { registerNativeCleanupReleaseWake } from "./native-runtime/native-cleanup-release-wake.js";

describe("task Retry after inherited native cleanup quarantine", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("quarantined-task-retry-");
    db = createDb(postgres.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seed(base: string, transient = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const ownerId = randomUUID(), sourceId = randomUUID(), nativeSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const workspaceId = randomUUID();
    const execution = (runId: string) => parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: transient ? runId : workspaceId },
      task: { identifier: "TEST", title: "Continue saved work", description: null, prompt: "Continue saved work", workMode: "standard" },
      workspace: { cwd: base, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue saved work", criteria: [{ id: "done", requirement: "Save the result" }] } },
      interactionResponses: [], credentialBindings: [],
    });
    const processStartedAt = new Date(Date.now() - 120_000);
    const processIdentity = { processPid: 99_999_999, processGroupId: 99_999_999, processStartedAt };
    await db.insert(companies).values({ id: companyId, name: "Quarantined Retry", defaultResponsibleUserId: "board",
      issuePrefix: `Q${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "blocked", assigneeAgentId: agentId });
    if (!transient) {
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
        mode: "shared_workspace", strategyType: "project_primary", name: "Saved work", cwd: base });
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    }
    const resultJson = { savedAnswer: "Existing work", recoveredExecutionFailure: { errorCode: "provider_transport_failed" } };
    for (const runId of [ownerId, sourceId]) {
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
        runtimeMode: "native", nativeSessionId, runnerInstanceId, ...processIdentity,
        status: runId === ownerId ? "succeeded" : "failed", resultJson: runId === ownerId ? resultJson : null,
        errorCode: runId === sourceId ? "native_session_cleanup_quarantined" : null,
        createdAt: new Date(Date.now() - (runId === ownerId ? 110_000 : 60_000)),
        startedAt: new Date(Date.now() - (runId === ownerId ? 109_000 : 59_000)),
        finishedAt: new Date(Date.now() - (runId === ownerId ? 100_000 : 50_000)),
        contextSnapshot: { issueId }, runnerProfileJson: { nativeExecutionInput: execution(runId),
          nativeToolContractFingerprint: `sha256:${"1".repeat(64)}`, sessionCheckpoint: { sessionId: "retained-provider-thread" } },
      });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId,
        phase: runId === ownerId ? "committed" : "terminal_failure" });
      await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
        provider: "local", status: "failed", leasePolicy: "ephemeral", releasedAt: new Date(Date.now() - 40_000) });
    }
    await appendHeartbeatRunEvent(db, { companyId, runId: ownerId, agentId, eventType: PROCESS_IDENTITY_RECORDED,
      payload: { ...processIdentity, processStartedAt: processStartedAt.toISOString(), targetKind: "local", hostname: hostname() } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_session_cleanup_quarantined", fingerprint: sourceId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped.", evidence: { runId: sourceId,
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    const identity = { runId: ownerId, runnerInstanceId, normalizedSessionId: nativeSessionId,
      environmentLeaseId: transient ? ownerId : workspaceId, turnId: `turn-${ownerId}`, itemId: `item-${ownerId}` };
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq: 5,
      sourceEventId: "provider-open", sourceInstanceId: runnerInstanceId, runId: ownerId,
      normalizedSessionId: nativeSessionId, turnId: identity.turnId, itemId: identity.itemId,
      priority: 0, emittedAt: processStartedAt.toISOString(), eventType: "session.resumed",
      payload: { providerSessionId: "retained-provider-thread", processId: 99_999_998 } };
    const normalized = { ...event, sourceSeq: 1, sourceEventId: `${runnerInstanceId}:${ownerId}:1`, turnId: undefined, itemId: undefined,
      payload: { providerSessionId: "retained-provider-thread", driverSessionId: "retained-provider-thread" } };
    await appendHeartbeatRunEvent(db, { companyId, runId: ownerId, agentId, eventType: event.eventType,
      payload: { prpEvent: normalized }, nativeSource: { sourceInstanceId: runnerInstanceId,
        sourceEventId: normalized.sourceEventId, sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: normalized } });
    const root = join(base, nativeSha256({ schema: "paperclip.native-session-scope.v2", companyId, agentId,
      workspace: transient ? { kind: "transient", cwd: base, repoUrl: null, repoRef: null, branchName: null }
        : { kind: "managed", executionWorkspaceId: workspaceId },
      provider: { driverKind: "codex_app_server", identity: { kind: "codex" } }, normalizedSessionId: nativeSessionId }));
    const files = {
      "control-plane/control-plane-state.json": { schema: "paperclip.runner.durable.control-plane-state.v1", identity,
        committedEvents: [{ envelope: { payload: event } }], commands: [{ status: "pending", payload: { commandType: "tool.result" } }] },
      "runner/runner-state.json": { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended", outbox: [] },
      "runner/codex-provider-state.json": { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "session_open",
        threadId: "retained-provider-thread", startupAttempt: null, pendingEvents: [], queuedEvents: [] },
    };
    await mkdir(join(root, "control-plane"), { recursive: true });
    await mkdir(join(root, "runner"), { recursive: true });
    for (const [path, value] of Object.entries(files)) await writeFile(join(root, path), JSON.stringify(value));
    await writeFile(join(base, "saved-work.txt"), "Keep the prior result and uncertain action history.");
    return { companyId, agentId, issueId, workspaceId, ownerId, sourceId, runnerInstanceId, resultJson, root, files };
  }

  it.each(["preserved", "projectless", "changed_binding", "changed_cwd", "pending_operation", "active_lease", "closed_workspace", "remote_workspace", "foreign_receipt"])(
    "admits one fresh successor through canonical Retry without replaying the retained session (%s)", async mode => {
    const base = await mkdtemp(join(tmpdir(), "quarantined-retry-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    try {
      const f = await seed(base, mode === "projectless");
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      const input = { db, companyId: f.companyId, issueId: f.issueId, actorId: "board", actorSource: "local_implicit", observedRunId: f.sourceId };
      const receipt = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
      const duplicate = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
      expect(duplicate.requestId).toBe(receipt.requestId);
      const heartbeat = heartbeatService(db);
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!)]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      const [state] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(successors, JSON.stringify(state.payload)).toHaveLength(1);
      expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.sourceId, forceFreshSession: true, taskRetryRequestId: receipt.requestId });
      if (mode === "changed_binding") await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
      if (mode === "changed_cwd") await db.update(executionWorkspaces).set({ cwd: join(base, "another-directory") }).where(eq(executionWorkspaces.id, f.workspaceId));
      if (mode === "closed_workspace") await db.update(executionWorkspaces).set({ status: "closed" }).where(eq(executionWorkspaces.id, f.workspaceId));
      if (mode === "remote_workspace") await db.update(executionWorkspaces).set({ providerType: "plugin" }).where(eq(executionWorkspaces.id, f.workspaceId));
      if (mode === "pending_operation") await db.insert(workspaceOperations).values({ companyId: f.companyId,
        executionWorkspaceId: f.workspaceId, heartbeatRunId: f.ownerId, issueId: f.issueId, phase: "workspace_restore", status: "running" });
      if (mode === "active_lease") await db.insert(environmentLeases).values({ companyId: f.companyId,
        executionWorkspaceId: f.workspaceId, heartbeatRunId: f.ownerId, issueId: f.issueId, provider: "local", status: "active", leasePolicy: "ephemeral" });
      if (mode === "foreign_receipt") {
        const [proof] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.sourceId),
          eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified")));
        await db.update(heartbeatRunEvents).set({ payload: { ...proof.payload, successorRunId: randomUUID() } })
          .where(eq(heartbeatRunEvents.id, proof.id));
        expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "fresh_isolated_workspace" });
      } else if (mode === "projectless") {
        expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "fresh_isolated_workspace",
          retryIntentId: receipt.requestId, sourceRunId: f.sourceId });
      } else if (mode === "preserved") {
        expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_stopped_native_workspace",
          retryIntentId: receipt.requestId, sourceRunId: f.sourceId, workspaceId: f.workspaceId, cwd: base });
      } else await expect(readFreshWorkspaceReadiness(db, successors[0])).rejects.toThrow(/Verified native continuation workspace/);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(wake).toMatchObject({ status: "coalesced", runId: successors[0].id });
      const [owner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.ownerId));
      expect(owner.resultJson).toEqual(f.resultJson);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(action.evidence.automaticRecovery).toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
      const proof = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.sourceId), eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified")));
      expect(proof).toHaveLength(1);
      expect(proof[0].payload).toMatchObject({ runId: f.sourceId, ownerRunId: f.ownerId });
      for (const [path, value] of Object.entries(f.files)) expect(await readFile(join(f.root, path), "utf8")).toBe(JSON.stringify(value));
      expect(await readFile(join(base, "saved-work.txt"), "utf8")).toContain("Keep the prior result");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(base, { recursive: true, force: true });
    }
  });

  it.each(["provider_alive", "worker_alive", "owner_running", "controller_owned", "owner_remote", "owner_unreleased",
    "owner_new_launch", "source_new_launch", "foreign_host", "foreign_workspace", "foreign_cwd", "foreign_runner", "missing_provider_receipt",
    "pending_provider_launch", "changed_process_birth", "changed_journal", "normalized_receipt_identity", "provider_identity_conflict"])("keeps quarantine for %s", async mode => {
    const base = await mkdtemp(join(tmpdir(), "quarantined-retry-fence-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    try {
      const f = await seed(base);
      if (mode === "provider_alive" || mode === "pending_provider_launch") {
        await writeFile(join(f.root, "runner/codex-provider-state.json"), JSON.stringify({
          ...f.files["runner/codex-provider-state.json"],
          ...(mode === "provider_alive" ? { processId: process.pid } : { startupAttempt: { phase: "intent" } }),
        }));
      }
      if (mode === "worker_alive") {
        await db.update(heartbeatRuns).set({ processPid: process.pid, processGroupId: process.pid })
          .where(eq(heartbeatRuns.companyId, f.companyId));
        const [owner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.ownerId));
        await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.ownerId, agentId: f.agentId,
          eventType: PROCESS_IDENTITY_RECORDED, payload: { targetKind: "local", hostname: hostname(),
            processPid: process.pid, processGroupId: process.pid, processStartedAt: owner.processStartedAt!.toISOString() } });
      }
      if (mode === "owner_running") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.ownerId));
      if (mode === "controller_owned") await db.update(nativeRunFinalizations).set({ leaseOwner: "other-controller" }).where(eq(nativeRunFinalizations.runId, f.ownerId));
      if (mode === "owner_remote" || mode === "owner_unreleased") await db.update(environmentLeases).set(
        mode === "owner_remote" ? { provider: "daytona" } : { releasedAt: null },
      ).where(eq(environmentLeases.heartbeatRunId, f.ownerId));
      if (mode === "owner_new_launch" || mode === "source_new_launch") await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, runId: mode === "owner_new_launch" ? f.ownerId : f.sourceId, agentId: f.agentId, eventType: PROCESS_START_REQUESTED,
      });
      if (mode === "foreign_host") {
        const [identity] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.ownerId),
          eq(heartbeatRunEvents.eventType, PROCESS_IDENTITY_RECORDED)));
        await db.update(heartbeatRunEvents).set({ payload: { ...identity.payload, hostname: "another-host" } })
          .where(eq(heartbeatRunEvents.id, identity.id));
      }
      if (mode === "changed_process_birth") await db.update(heartbeatRuns).set({ processStartedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceId));
      if (mode === "foreign_runner") await db.update(heartbeatRuns).set({ runnerInstanceId: randomUUID() }).where(eq(heartbeatRuns.id, f.ownerId));
      if (mode === "foreign_workspace" || mode === "foreign_cwd") {
        const [owner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.ownerId));
        const input = parseNativeExecutionInput(owner.runnerProfileJson!.nativeExecutionInput);
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...owner.runnerProfileJson,
          nativeExecutionInput: { ...input,
            ...(mode === "foreign_workspace" ? { binding: { ...input.binding, executionWorkspaceId: "another-workspace" } }
              : { workspace: { ...input.workspace, cwd: join(base, "another-directory") } }),
          },
        } }).where(eq(heartbeatRuns.id, f.ownerId));
      }
      if (mode === "missing_provider_receipt") await db.delete(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, f.ownerId), eq(heartbeatRunEvents.eventType, "session.resumed")));
      if (mode === "normalized_receipt_identity") await db.update(heartbeatRunEvents).set({ sourceSeq: 2 }).where(and(
        eq(heartbeatRunEvents.runId, f.ownerId), eq(heartbeatRunEvents.eventType, "session.resumed")));
      if (mode === "provider_identity_conflict") {
        const [receipt] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.ownerId),
          eq(heartbeatRunEvents.eventType, "session.resumed")));
        const event = receipt.payload!.prpEvent as Record<string, unknown>;
        const changed = { ...event, payload: { providerSessionId: "another-thread", driverSessionId: "another-thread" } };
        await db.update(heartbeatRunEvents).set({ payload: { prpEvent: changed }, sourcePayloadSha256: nativeSha256(changed) })
          .where(eq(heartbeatRunEvents.id, receipt.id));
      }
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
      const proof = await verifyStoppedNativeSessionForContinuation(db, source);
      if (mode === "changed_journal") {
        expect(proof).not.toBeNull();
        await writeFile(join(f.root, "runner/runner-state.json"), "{}");
        expect(proof!.retire()).toBe(false);
      } else expect(proof).toBeNull();
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("holds a Retry while the task's own provider session close is still retained, then starts it", async () => {
    const base = await mkdtemp(join(tmpdir(), "retained-close-retry-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    let releaseClose = () => {};
    try {
      const f = await seed(base);
      // The source failed for another reason; only the runner's in-process
      // admission gate still holds this task's provider session close.
      await db.update(heartbeatRuns).set({ errorCode: "provider_transport_failed" }).where(eq(heartbeatRuns.id, f.sourceId));
      const settled = vi.fn();
      const unsubscribe = onNativeSessionCleanupSettled(settled);
      // The production release wake, observed on the delivery queue it signals.
      const wakeFailure = vi.fn();
      const unregisterWake = registerNativeCleanupReleaseWake(db, wakeFailure);
      const deferredWake = vi.fn();
      const unsubscribeDeferred = subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, deferredWake);
      const pendingClose = new Promise<void>(resolve => { releaseClose = resolve; });
      const identity = { runId: randomUUID(), sessionId: "retained-close-session", companyId: f.companyId, issueId: f.issueId, agentId: f.agentId };
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
      const session: NativeSession = {
        identity: () => identity, capabilities: async () => capabilities,
        async *events() { throw new Error("retained close transport stopped"); },
        startTurn: async () => ({ turnId: "retained-close-turn" }), result: async () => null,
        async snapshot() { return { backendKind: "mock", sessionId: "retained-close-driver", identity,
          providerSessionId: "retained-close-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
        close: () => pendingClose,
      };
      await expect(executeNativeSession({
        input: parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
          binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: identity.runId, executionWorkspaceId: f.workspaceId },
          task: { identifier: "TEST", title: "Continue saved work", description: null, prompt: "Continue saved work", workMode: "standard" },
          workspace: { cwd: base, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
            contract: { revision: "1", objective: "Continue saved work", criteria: [{ id: "done", requirement: "Save the result" }] } },
          interactionResponses: [], credentialBindings: [] }),
        backend: { descriptor: async () => ({ kind: "runner", name: "retained-close-backend", version: "1", capabilities }),
          openSession: async () => session },
        controlPlane: { openRun: async () => {}, checkpointSession: async () => {},
          appendEvent: async () => ({ cursor: 0, highestContiguousSourceSeq: 0, disposition: "committed" }),
          replayEvents: async () => ({ events: [], highestContiguousSourceSeq: 0 }), completeRun: async () => {} },
        runnerInstanceId: f.runnerInstanceId, controlPlaneInstanceId: "control",
      })).rejects.toThrow("retained close transport stopped");
      expect(nativeSessionCleanupBlock({ companyId: f.companyId, issueId: f.issueId })).toBe("pending");
      expect(nativeSessionCleanupBlock({ companyId: f.companyId, issueId: randomUUID() })).toBeNull();

      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        actorSource: "local_implicit", observedRunId: f.sourceId, idempotencyKey: randomUUID() });
      const heartbeat = heartbeatService(db);
      await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
      const queued = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      // No successor is dispatched that the runner would refuse at once.
      expect(await queued()).toHaveLength(0);
      const [held] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(held.payload).toMatchObject({ executionWait: { reason: "local_cleanup" } });

      // The close settles by itself; its release wakes the held Retry, which then starts.
      releaseClose();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ companyId: f.companyId, issueIds: [f.issueId] }));
      await vi.waitFor(() => expect(deferredWake).toHaveBeenCalled());
      expect(wakeFailure).not.toHaveBeenCalled();
      expect(nativeSessionCleanupBlock({ companyId: f.companyId, issueId: f.issueId })).toBeNull();
      unsubscribe();
      unregisterWake();
      unsubscribeDeferred();
      // The deferred-execution worker runs this pass on that wake.
      await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
      expect(await queued()).toHaveLength(1);
    } finally {
      releaseClose();
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(base, { recursive: true, force: true });
    }
  });
});
