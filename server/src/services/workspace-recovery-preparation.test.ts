import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { heartbeatRunEvents, agents, completionContracts, companies, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations, executionWorkspaces, executionWorkspaceSnapshots } from "@paperclipai/db";
import { prepareHeartbeatWorkspace } from "./heartbeat/workspace-preparation.js";
import { selectHeartbeatEnvironment } from "./heartbeat/environment-selection.js";
import { attachPreservedRemoteWorkspaceSnapshots } from "./remote-workspace-recovery-attachments.js";
import { Readable } from "node:stream";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildEnvironmentLeaseContext } from "./environment-runtime.js";
import { createHeartbeatWorkspaceResolver, resolveExecutionWorkspaceReuseRequestForIssue } from "./heartbeat/workspaces.js";
import { environmentService } from "./environments.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { instanceSettingsService } from "./instance-settings.js";
import { readSystemRecovery, createSystemRecovery } from "./system-recovery-state.js";
import * as storageBackend from "../storage/index.js";
import { getStorageService } from "../storage/index.js";
import { attachPreservedWorkspaceSnapshots, preserveWorkspaceSnapshot } from "./workspace-recovery-snapshot.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { createHeartbeatRunOutput } from "./heartbeat/run-output.js";
import { objectLogFixture } from "./heartbeat/__tests__/object-log-fixture.js";
import { useWorkspaceRecoveryFixture, action, boardRecoveryApp, connectionString, db, failedRemotePreparation, fixtureCompanyIds, receiptOnlyRecoveryApp, root, run, stoppedWorkspaceWorker } from "./workspace-recovery.test-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it.each(["new message", "saved message", "Retry"] as const)(
    "continues recovered preparation with an inherited session through %s", async entry => {
    const f = await failedRemotePreparation();
    await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const source = await run(f.runId), app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    if (entry !== "saved message") await recoverRetainedWorkspace(f.input);
    let requestId: string | undefined, commentId: string | undefined;
    if (entry === "Retry") {
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      requestId = receipt.requestId;
      await heartbeat.resumeTaskRetry(f.companyId, requestId!);
    } else {
      const body = { body: "Continue from the saved work", reopen: true, clientRequestId: randomUUID() };
      const comment = (await request(app).post(`/api/issues/${f.issueId}/comments`).send(body).expect(201)).body;
      commentId = comment.id;
      expect((await request(app).post(`/api/issues/${f.issueId}/comments`).send(body).expect(201)).body.id).toBe(commentId);
      await expect.poll(async () => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`))).length).toBe(1);
      if (entry === "saved message") {
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
        await recoverRetainedWorkspace(f.input);
      }
      await heartbeat.resumeRemoteStopComments(await run(f.runId));
    }
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    await expect.poll(async () => (await successors()).length).toBe(1);
    const [successor] = await successors();
    expect(successor.contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.runId,
      ...(commentId ? { wakeCommentIds: [commentId] } : { taskRetryRequestId: requestId }) });
    await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
      requestId ? heartbeat.resumeTaskRetry(f.companyId, requestId) : heartbeat.resumeExecutionWaitComments()]);
    expect(await successors()).toHaveLength(1);
    const queue = (await request(app).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    expect(queue.executionWait ?? null).toBeNull();
    if (commentId) expect(queue).toMatchObject({ state: "queued", entries: [{ comment: { id: commentId } }] });
    else expect(queue.entries).toEqual([]);
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
      .toMatchObject({ state: "working", canRetry: false });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const original = await run(f.runId);
    expect(original).toMatchObject({ status: "failed", error: source.error, sessionIdBefore: source.sessionIdBefore });
    expect(await hasVerifiedWorkspaceRepair(db, original)).toBe(true);
    const remote = original.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
  }, 30_000);

  it.each(["retained_history", "ordinary_followup"])("restores the newest recovered tick bytes after a later workspace selection: %s", async kind => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    try {
      const f = await failedRemotePreparation();
      const tickLog = Array.from({ length: 12 }, (_, i) => `2026-11-06T07:${String(21 + i).padStart(2, "0")}:00Z\n`).join("");
      await writeFile(path.join(f.remote, "ticks.log"), tickLog);
      if (kind === "retained_history") {
        const readonlySource = path.join(f.remote, "source-assets");
        await mkdir(readonlySource); await writeFile(path.join(readonlySource, "asset.txt"), "Preserved source asset\n"); await chmod(readonlySource, 0o555);
      }
      await recoverRetainedWorkspace(f.input);
      const initial = await run(f.runId), oldRunId = randomUUID(), oldActionId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: oldRunId, companyId: f.companyId, issueId: f.issueId,
        agentId: initial.agentId, status: "failed", contextSnapshot: { issueId: f.issueId },
        createdAt: new Date(initial.createdAt.getTime() - 60_000), finishedAt: new Date(initial.createdAt.getTime() - 30_000) });
      await db.insert(issueRecoveryActions).values({ id: oldActionId, companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "native_continuation_requires_reconciliation",
        fingerprint: oldRunId, nextAction: "Historical preserved files", evidence: { runId: oldRunId } });
      const oldRoot = path.join(root, oldRunId); await mkdir(oldRoot);
      await writeFile(path.join(oldRoot, "ticks.log"), "2026-11-06T07:21:00Z\n");
      const oldProviderId = randomUUID();
      const [oldLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: oldRunId, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: oldProviderId,
        status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
      await preserveWorkspaceSnapshot({ db, companyId: f.companyId, issueId: f.issueId, runId: oldRunId,
        actionId: oldActionId, leaseId: oldLease.id, providerLeaseId: oldProviderId,
        target: { ...targets.get(f.lease.id)!, leaseId: oldLease.id, remoteCwd: oldRoot }, assertHeld: async () => {} });
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId,
        error: "native_remote_recovery_lease_mismatch", errorCode: "setup_failed", sessionIdBefore: randomUUID(),
      }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, phase: "terminal_failure" });
      const [placeholder] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
        sourceIssueId: f.issueId, name: "Later empty placeholder", providerType: "cloud_sandbox",
        mode: "isolated_workspace", strategyType: "project_primary", cwd: `/workspaces/${randomUUID()}`,
        metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1,
          snapshotId: null, source: { kind: "empty" }, writerRunId: f.runId, dirty: false, location: null },
        ...(kind === "retained_history" ? { remoteWorkspaceRecoverySourceRunIds: [oldRunId] } : {}),
          remoteWorkspaceSnapshotRepositories: { snapshotId: randomUUID(), repositories: [] } },
      }).returning();
      await db.update(issues).set({ executionWorkspaceId: placeholder.id }).where(eq(issues.id, f.issueId));
      const source = await run(f.runId);
      expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(true);
      const sourceReference = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
      const savedSource = await createSavedWorkspaceLoader(db)({ companyId: f.companyId,
        workspaceId: f.workspaceId, snapshotId: sourceReference.snapshotId });
      try { expect(await readFile(path.join(savedSource.root, "ticks.log"), "utf8")).toBe(tickLog); }
      finally { await savedSource.cleanup(); }
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
        actorId: "local-board", actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(receipt.accepted).toBe(true);
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
      expect(successor).toBeDefined();
      const readiness = await readFreshWorkspaceReadiness(db, successor);
      expect(readiness).toMatchObject({ mode: "resume_preserved_workspace" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [agent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
      const selection = await selectHeartbeatEnvironment(db, {
        run: successor, agent,
        task: { issueRef: issue, issueContext: issue, issueId: f.issueId, context: successor.contextSnapshot!,
          executionProjectId: issue.projectId, workspaceProjectContext: null, boundSourceWorkspace: null,
          freshWorkspace: readiness, hasSelectedWorkspaceSource: false, taskWorkspaceIntent: null, responsibleUserId: "local-board" },
        policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
          isolatedWorkspacesEnabled: true, requestedExecutionWorkspaceMode: "isolated_workspace",
          projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null },
        config: { config: {}, sourceWorkspaceConfig: {}, issueAssigneeOverrides: null },
        services: { environmentsSvc: environmentService(db), executionWorkspacesSvc: executionWorkspaceService(db),
          instanceSettings: instanceSettingsService(db), findSharedWorkspaceHolder: async () => null,
          findExecutionWorkspaceHolder: async () => null },
      });
        await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor.id));
        const storage = { ...getStorageService(), provider: "s3" as const };
        const reserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId,
          runId: successor.id, agentId: source.agentId, environmentId: f.lease.environmentId!,
          projectId: null, projectWorkspaceId: null, existingWorkspaceId: selection.existingExecutionWorkspace?.id ?? null,
          source: { kind: "empty" } });
        const allocationPath = path.join(root, successor.id); await mkdir(allocationPath);
        const allocation = await realpath(allocationPath);
        const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: successor.id, environmentId: f.lease.environmentId, provider: "daytona",
          providerLeaseId: randomUUID(), status: "active" }).returning();
        const target = { ...targets.get(f.lease.id)!, leaseId: lease.id, remoteCwd: allocation,
          runner: { ...targets.get(f.lease.id)!.runner!, syncIn: async operations => {
            for (const operation of operations) for (const file of operation.files) {
              await mkdir(path.dirname(file.targetPath), { recursive: true });
              await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
            }
            return { filesTransferred: 1, bytesTransferred: 0, operations: [] };
          } } } satisfies AdapterSandboxExecutionTarget;
        const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: successor.id,
          lease: lease as EnvironmentLease, target });
        const recovered = prepared.workspace.metadata?.remoteWorkspaceRecoveredFiles as Array<{ path: string }> | undefined;
        const contents = await Promise.all(["", ...(recovered ?? []).map(item => `${item.path}/files`)]
          .map(relative => readFile(path.join(prepared.remoteRoot, relative, "ticks.log"), "utf8").catch(() => null)));
        if (kind === "retained_history") expect(contents).toContain("2026-11-06T07:21:00Z\n");
        expect(contents).toContain(tickLog);
        if (kind === "retained_history") {
          const currentSidecar = (recovered as Array<{ path: string; sourceRunId: string }>).find(item => item.sourceRunId === source.id)!;
          expect(await readFile(path.join(prepared.remoteRoot, currentSidecar.path, "files", "source-assets", "asset.txt"), "utf8"))
            .toBe("Preserved source asset\n");
          expect((await lstat(path.join(prepared.remoteRoot, currentSidecar.path, "files", "source-assets"))).mode & 0o777).toBe(0o555);
        }
        const continuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
          agentId: agent.id, runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
        const providerContext: Record<string, unknown> = { ...successor.contextSnapshot,
          executionContinuation: continuation, paperclipWake: { issue: { id: f.issueId }, executionContinuation: continuation } };
        const workspaces = executionWorkspaceService(db);
        const current = (await workspaces.getStoredById(f.companyId, placeholder.id))!;
        const currentIssue = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
        const environment = (await environmentService(db).getById(f.lease.environmentId!))!;
        const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: f.environmentRuntime });
        const acquire = vi.spyOn(orchestrator, "acquireForRun").mockResolvedValue({ environment,
          lease: prepared.lease, leaseContext: buildEnvironmentLeaseContext({ persistedExecutionWorkspace: current }), executionTransport: null });
        const storageRead = vi.spyOn(storageBackend, "getStorageService").mockReturnValue(storage);
        targets.set(lease.id, { ...target, remoteCwd: prepared.remoteRoot });
        const localEnvironment = await environmentService(db).ensureLocalEnvironment(f.companyId);
        try {
          const boundary = await prepareHeartbeatWorkspace(db, { run: await run(successor.id), agent,
            task: { issueRef: currentIssue, issueId: f.issueId, wasIssueAssignee: true,
              context: providerContext, responsibleUserId: "local-board", previousSessionParams: null, freshWorkspace: readiness },
            policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
              isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
              requestedExecutionWorkspaceMode: "isolated_workspace", useIsolatedTaskDirectory: true,
              nativeChatWorkspaceScope: null, projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null,
              environmentExecutionWorkspaceSettings: null, executionPolicy: { executionMode: "any" } },
            environment: { selectedEnvironmentId: environment.id, localEnvironment, selectedEnvironmentForConfig: environment,
              environmentResolution: { environmentId: environment.id, source: "agent" }, resolvedInstanceSettings: await instanceSettingsService(db).get() },
            config: { mergedConfig: {}, configSnapshot: null, secretManifest: [] },
            reuse: { ...selection, existingExecutionWorkspace: current, reusableExistingExecutionWorkspace: current,
              requestedShouldReuseExisting: true, workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({
                issueExecutionWorkspaceId: current.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: current.status }),
              runOptions: {} },
            services: { envOrchestrator: orchestrator, executionWorkspacesSvc: workspaces, workspaceOperationsSvc: workspaceOperationService(db),
              ...createHeartbeatWorkspaceResolver(db), appendRunEvent: vi.fn() },
            controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
          });
          const paths = providerContext.recoveredWorkspaceFiles as Array<{ sourceRunId: string; path: string }>;
          const newest = paths?.find(item => item.sourceRunId === source.id);
          expect(newest).toBeDefined();
          const prompt = renderPaperclipWakePrompt(providerContext.paperclipWake);
          expect(prompt).toContain(newest!.path);
          const readback = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["-e",
            "const fs=require('node:fs');const p=JSON.parse(process.argv[1]);const text=fs.readFileSync(require('node:path').join(p.cwd,p.path,'files/ticks.log'),'utf8');const lines=text.trimEnd().split('\\n');process.stdout.write(JSON.stringify({count:lines.length,first:lines[0],last:lines.at(-1)}));",
            JSON.stringify({ cwd: boundary.executionWorkspace.cwd, path: newest!.path })],
          (error, stdout) => error ? reject(error) : resolve(stdout)));
          expect(JSON.parse(readback)).toEqual({ count: 12, first: "2026-11-06T07:21:00Z", last: "2026-11-06T07:32:00Z" });
          expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionWorkspaceId).toBe(placeholder.id);
          const editedLog = `${tickLog}User preserved annotation\n`;
          await writeFile(path.join(boundary.executionWorkspace.cwd, newest!.path, "files", "ticks.log"), editedLog);
          let [selectedWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, placeholder.id));
          if (kind === "retained_history") {
            const olderPaths = selectedWorkspace.metadata!.remoteWorkspaceRecoveredFiles as Array<{ operationId: string; sourceRunId: string; path: string }>;
            const [legacy] = await db.update(executionWorkspaces).set({ metadata: { ...selectedWorkspace.metadata,
              remoteWorkspaceRecoveredFiles: olderPaths.map(({ operationId, sourceRunId, path }) => ({ operationId, sourceRunId, path })) } })
              .where(eq(executionWorkspaces.id, selectedWorkspace.id)).returning();
            const upgraded = await prepareRemoteWorkspace({ db, storage, workspace: legacy, runId: successor.id,
              lease: boundary.activeEnvironmentLease!.lease, target: boundary.executionTarget });
            expect(upgraded.workspace.metadata?.remoteWorkspaceRecoveredFiles).toEqual(expect.arrayContaining(olderPaths.map(item =>
              expect.objectContaining({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: item.path }))));
            expect(await readFile(path.join(upgraded.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
            selectedWorkspace = upgraded.workspace;
          }
          await saveRemoteWorkspace({ db, storage, workspace: selectedWorkspace, runId: successor.id,
            lease: boundary.activeEnvironmentLease!.lease, target: boundary.executionTarget, assertOwned: async () => {} });
          await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
            .where(eq(environmentLeases.id, lease.id));
          const coldAllocationPath = path.join(root, randomUUID()); await mkdir(coldAllocationPath);
          const [coldLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
            heartbeatRunId: successor.id, environmentId: f.lease.environmentId, provider: "daytona",
            providerLeaseId: randomUUID(), status: "active" }).returning();
          const coldWorkspace = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId,
            runId: successor.id, agentId: source.agentId, environmentId: f.lease.environmentId!, projectId: null,
            projectWorkspaceId: null, existingWorkspaceId: placeholder.id, source: { kind: "empty" } });
          const cold = await prepareRemoteWorkspace({ db, storage, workspace: coldWorkspace, runId: successor.id,
            lease: coldLease as EnvironmentLease, target: { ...target, leaseId: coldLease.id, remoteCwd: await realpath(coldAllocationPath) } });
          expect(await readFile(path.join(cold.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
          if (kind === "retained_history") {
            await saveRemoteWorkspace({ db, storage, workspace: cold.workspace, runId: successor.id,
              lease: cold.lease, target: { ...target, leaseId: coldLease.id, remoteCwd: cold.remoteRoot }, assertOwned: async () => {} });
            await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
            await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, coldLease.id));
            const [child] = await db.insert(issues).values({ companyId: f.companyId, parentId: f.issueId,
              assigneeAgentId: agent.id, title: "Shared workspace continuation", status: "in_progress", executionWorkspaceId: placeholder.id }).returning();
            const [childRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id, issueId: child.id,
              status: "running", contextSnapshot: { issueId: child.id } }).returning();
            const [saved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, placeholder.id));
            const olderPaths = saved.metadata!.remoteWorkspaceRecoveredFiles as Array<{ operationId: string; sourceRunId: string; path: string }>;
            const [earlierChild] = await db.insert(issues).values({ companyId: f.companyId, parentId: f.issueId,
              title: "Earlier related recovery source", status: "done", executionWorkspaceId: placeholder.id }).returning();
            const [related] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, issueId: earlierChild.id,
              agentId: agent.id, status: "failed", contextSnapshot: { issueId: earlierChild.id } }).returning();
            const [relatedAction] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: earlierChild.id,
              kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "native_continuation_requires_reconciliation",
              fingerprint: related.id, nextAction: "Saved related files", evidence: { runId: related.id } }).returning();
            const [relatedLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: earlierChild.id,
              heartbeatRunId: related.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(),
              status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
            await preserveWorkspaceSnapshot({ db, companyId: f.companyId, issueId: earlierChild.id, runId: related.id,
              actionId: relatedAction.id, leaseId: relatedLease.id, providerLeaseId: relatedLease.providerLeaseId!,
              target: { ...targets.get(f.lease.id)!, leaseId: relatedLease.id, remoteCwd: oldRoot }, assertHeld: async () => {} });
            const [attachedRelated] = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: earlierChild.id,
              sourceRunIds: [related.id], cwd: cold.remoteRoot });
            olderPaths.push({ operationId: attachedRelated.operationId, sourceRunId: related.id,
              path: `.paperclip-recovered/${attachedRelated.operationId}` });
            const [migration] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
              executionWorkspaceId: placeholder.id, phase: "remote_workspace_migration", status: "succeeded",
              metadata: { legacyRecoverySources: [{ runId: related.id, issueId: earlierChild.id }] } }).returning();
            const marker = { schema: "paperclip.legacy-workspace-recovery-migration.v1", operationId: migration.id };
            await db.update(heartbeatRuns).set({ runnerProfileJson: { legacyWorkspaceRecoveryMigration:
              { ...marker, workspaceId: placeholder.id } } }).where(eq(heartbeatRuns.id, related.id));
            await db.update(executionWorkspaces).set({ metadata: { ...saved.metadata, legacyWorkspaceRecoveryMigration: marker,
              remoteWorkspaceRecoveredFiles:
              olderPaths.map(({ operationId, sourceRunId, path }) => ({ operationId, sourceRunId, path })) } }).where(eq(executionWorkspaces.id, saved.id));
            const shared = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: child.id,
              runId: childRun.id, agentId: agent.id, environmentId: f.lease.environmentId!, projectId: null,
              projectWorkspaceId: null, existingWorkspaceId: placeholder.id, source: { kind: "empty" } });
            const [childLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: child.id,
              heartbeatRunId: childRun.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: coldLease.providerLeaseId, status: "active" }).returning();
            const inherited = await prepareRemoteWorkspace({ db, storage, workspace: shared, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: cold.remoteRoot } });
            expect(inherited.workspace.metadata?.remoteWorkspaceRecoveredFiles).toEqual(expect.arrayContaining(olderPaths.map(item =>
              expect.objectContaining({ operationId: item.operationId, sourceRunId: item.sourceRunId, path: item.path }))));
            expect(await readFile(path.join(inherited.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
            const [withoutProof] = await db.update(executionWorkspaces).set({ metadata: { ...inherited.workspace.metadata,
              remoteWorkspaceRecoveredFiles: olderPaths.map(({ operationId, sourceRunId, path }) => ({ operationId, sourceRunId, path })) } })
              .where(eq(executionWorkspaces.id, inherited.workspace.id)).returning();
            for (const fault of ["migration_status", "source_marker_workspace", "history_issue"]) {
              await db.update(workspaceOperations).set({ status: fault === "migration_status" ? "failed" : "succeeded",
                metadata: { legacyRecoverySources: [{ runId: related.id, issueId: fault === "history_issue" ? randomUUID() : earlierChild.id }] } })
                .where(eq(workspaceOperations.id, migration.id));
              await db.update(heartbeatRuns).set({ runnerProfileJson: { legacyWorkspaceRecoveryMigration:
                { ...marker, workspaceId: fault === "source_marker_workspace" ? randomUUID() : placeholder.id } } })
                .where(eq(heartbeatRuns.id, related.id));
              await expect(prepareRemoteWorkspace({ db, storage, workspace: withoutProof, runId: childRun.id,
                lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: cold.remoteRoot } }))
                .rejects.toThrow("remote_workspace_recovery_receipt_invalid");
            }
            await db.update(workspaceOperations).set({ status: "succeeded", metadata: {
              legacyRecoverySources: [{ runId: related.id, issueId: earlierChild.id }] } }).where(eq(workspaceOperations.id, migration.id));
            await db.update(heartbeatRuns).set({ runnerProfileJson: { legacyWorkspaceRecoveryMigration:
              { ...marker, workspaceId: placeholder.id } } }).where(eq(heartbeatRuns.id, related.id));
            await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.id,
              (olderPaths.find(item => item.sourceRunId === source.id))!.operationId));
            await expect(prepareRemoteWorkspace({ db, storage, workspace: withoutProof, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: cold.remoteRoot } }))
              .rejects.toThrow("remote_workspace_recovery_receipt_invalid");
            expect(await readFile(path.join(inherited.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
            await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id,
              (olderPaths.find(item => item.sourceRunId === source.id))!.operationId));
            const immutableAssets = path.join(inherited.remoteRoot, "readonly-assets");
            await mkdir(immutableAssets); await writeFile(path.join(immutableAssets, "asset.txt"), "Read-only workspace asset\n");
            await chmod(immutableAssets, 0o555);
            await saveRemoteWorkspace({ db, storage, workspace: inherited.workspace, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: inherited.remoteRoot },
              assertOwned: async () => {} });
            const [selectedSaved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, inherited.workspace.id));
            const [snapshotOnly] = await db.update(executionWorkspaces).set({ metadata: {
              ...Object.fromEntries(Object.entries(selectedSaved.metadata!).filter(([key]) => key !== "legacyWorkspaceRecoveryMigration")),
              remoteWorkspaceRecoveredFiles: olderPaths.map(({ operationId, sourceRunId, path }) => ({ operationId, sourceRunId, path })) } })
              .where(eq(executionWorkspaces.id, inherited.workspace.id)).returning();
            const snapshotReserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: child.id,
              runId: childRun.id, agentId: agent.id, environmentId: f.lease.environmentId!, projectId: null,
              projectWorkspaceId: null, existingWorkspaceId: snapshotOnly.id, source: { kind: "empty" } });
            const snapshotRetained = await prepareRemoteWorkspace({ db, storage, workspace: snapshotReserved, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: inherited.remoteRoot } });
            expect(snapshotRetained.workspace.metadata?.remoteWorkspaceRecoveredFiles).toHaveLength(olderPaths.length);
            expect((await lstat(immutableAssets)).mode & 0o777).toBe(0o555);
            expect(await readFile(path.join(immutableAssets, "asset.txt"), "utf8")).toBe("Read-only workspace asset\n");
            expect(await readFile(path.join(snapshotRetained.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
            const legacySnapshot = { ...snapshotRetained.workspace, metadata: { ...snapshotRetained.workspace.metadata,
              remoteWorkspaceRecoveredFiles: olderPaths.map(({ operationId, sourceRunId, path }) => ({ operationId, sourceRunId, path })) } };
            const authority = readRemoteWorkspaceAuthority(legacySnapshot.metadata)!;
            await db.update(executionWorkspaceSnapshots).set({ status: "uploaded" }).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
            await expect(prepareRemoteWorkspace({ db, storage, workspace: legacySnapshot, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: inherited.remoteRoot } }))
              .rejects.toThrow("remote_workspace_recovery_receipt_invalid");
            await db.update(executionWorkspaceSnapshots).set({ status: "committed" }).where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
            await expect(prepareRemoteWorkspace({ db, storage, workspace: { ...legacySnapshot, metadata: { ...legacySnapshot.metadata,
              remoteWorkspace: { ...authority, snapshotId: sourceReference.snapshotId } } }, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: inherited.remoteRoot } }))
              .rejects.toThrow("remote_workspace_recovery_receipt_invalid");
            const unreadable = { ...storage, getObject: vi.fn().mockRejectedValue(new Error("fixture: selected snapshot unavailable")) };
            await expect(prepareRemoteWorkspace({ db, storage: unreadable, workspace: legacySnapshot, runId: childRun.id,
              lease: childLease as EnvironmentLease, target: { ...target, leaseId: childLease.id, remoteCwd: inherited.remoteRoot } }))
              .rejects.toThrow("fixture: selected snapshot unavailable");
            expect(await readFile(path.join(snapshotRetained.remoteRoot, newest!.path, "files", "ticks.log"), "utf8")).toBe(editedLog);
          }
          if (kind === "ordinary_followup") {
            await rm(path.join(cold.remoteRoot, newest!.path), { recursive: true });
            await saveRemoteWorkspace({ db, storage, workspace: cold.workspace, runId: successor.id,
              lease: cold.lease, target: { ...target, leaseId: coldLease.id, remoteCwd: cold.remoteRoot }, assertOwned: async () => {} });
            await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
            await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
              .where(eq(environmentLeases.id, coldLease.id));
            const [normal] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id, issueId: f.issueId,
              status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId } }).returning();
            const ordinaryWorkspace = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId,
              runId: normal.id, agentId: agent.id, environmentId: f.lease.environmentId!, projectId: null,
              projectWorkspaceId: null, existingWorkspaceId: placeholder.id, source: { kind: "empty" } });
            const ordinaryAllocation = await realpath(await mkdtemp(path.join(root, "ordinary-")));
            const [ordinaryLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
              heartbeatRunId: normal.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(), status: "active" }).returning();
            const ordinary = await prepareRemoteWorkspace({ db, storage, workspace: ordinaryWorkspace, runId: normal.id,
              lease: ordinaryLease as EnvironmentLease, target: { ...target, leaseId: ordinaryLease.id, remoteCwd: ordinaryAllocation } });
            expect(await lstat(path.join(ordinary.remoteRoot, newest!.path)).then(() => true, () => false)).toBe(false);
            expect(ordinary.workspace.metadata?.remoteWorkspaceRecoveredFiles ?? []).toEqual([]);
          }
        } finally { acquire.mockRestore(); storageRead.mockRestore(); }
      expect((await run(f.runId)).error).toBe("native_remote_recovery_lease_mismatch");
    } finally { vi.unstubAllEnvs(); }
  }, 30_000);

  it("reads canonical attachments from the caller's storage backend", async () => {
    const f = await failedRemotePreparation(); await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId), destination = await mkdtemp(path.join(root, "injected-storage-"));
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, status: "running", responsibleUserId: "local-board", contextSnapshot: { issueId: f.issueId } }).returning();
    const global = getStorageService(), read = global.getObject.bind(global);
    const injected = { ...global, getObject: vi.fn(read) };
    const wrongBackend = vi.spyOn(global, "getObject").mockRejectedValue(new Error("wrong storage backend"));
    try {
      const scope = { db, companyId: f.companyId, issueId: f.issueId, runId: writer.id, workspaceId: randomUUID(),
        sourceRunIds: [source.id], cwd: destination, storage: injected };
      const attached = await attachPreservedRemoteWorkspaceSnapshots(scope);
      expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
      expect(injected.getObject).toHaveBeenCalled();
      expect(wrongBackend).not.toHaveBeenCalled();
    } finally { wrongBackend.mockRestore(); }
  }, 30_000);

  it("restores ordinary same-workspace Retry after reservation advances current authority", async () => {
    vi.stubEnv("DATABASE_URL", connectionString);
    try {
      const f = await failedRemotePreparation(); await recoverRetainedWorkspace(f.input);
      const source = await run(f.runId);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
        actorSource: "local_implicit", observedRunId: source.id, idempotencyKey: randomUUID() });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
      expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor.id));
      const storage = { ...getStorageService(), provider: "s3" as const };
      const reserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: f.issueId,
        runId: successor.id, agentId: source.agentId, environmentId: f.lease.environmentId!, projectId: null,
        projectWorkspaceId: null, existingWorkspaceId: f.workspaceId, source: { kind: "empty" } });
      expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(false);
      const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: successor.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(), status: "active" }).returning();
      const target = { ...targets.get(f.lease.id)!, leaseId: lease.id,
        remoteCwd: await realpath(await mkdtemp(path.join(root, "same-workspace-"))),
        runner: { ...targets.get(f.lease.id)!.runner!, syncIn: async operations => {
          for (const operation of operations) for (const file of operation.files) {
            await mkdir(path.dirname(file.targetPath), { recursive: true }); await cp(file.sourcePath, file.targetPath, { recursive: true });
          }
          return { filesTransferred: 1, bytesTransferred: 0, operations: [] };
        } } } satisfies AdapterSandboxExecutionTarget;
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: successor.id,
        lease: lease as EnvironmentLease, target });
      expect(prepared.workspace.id).toBe(f.workspaceId);
      expect(await readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(prepared.workspace.metadata?.remoteWorkspaceRecoveredFiles ?? []).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  }, 30_000);

  it.each(["missing_receipt", "missing_reference", "prepared_reference", "missing_snapshot_id", "uncommitted", "foreign_snapshot", "wrong_lease", "missing_object", "corrupt_object", "wrong_company", "wrong_issue"])(
    "refuses canonical recovery attachments with %s evidence", async fault => {
    const f = await failedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId), remote = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, status: "running", responsibleUserId: "local-board", contextSnapshot: { issueId: f.issueId } }).returning();
    const destination = path.join(root, writer.id); await mkdir(destination);
    const [receipt] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery"), eq(workspaceOperations.status, "succeeded")));
    if (fault === "missing_receipt") await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.id, receipt.id));
    if (fault === "missing_reference") await db.update(heartbeatRuns).set({ runnerProfileJson:
      Object.fromEntries(Object.entries(source.runnerProfileJson!).filter(([key]) => key !== "remoteWorkspace")) }).where(eq(heartbeatRuns.id, source.id));
    if (fault === "prepared_reference" || fault === "missing_snapshot_id") await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...source.runnerProfileJson, remoteWorkspace: { ...source.runnerProfileJson!.remoteWorkspace as object,
        ...(fault === "prepared_reference" ? { state: "prepared" } : { snapshotId: null }) },
    } }).where(eq(heartbeatRuns.id, source.id));
    if (fault === "uncommitted") await db.update(executionWorkspaceSnapshots).set({ status: "uploaded" }).where(eq(executionWorkspaceSnapshots.id, remote.snapshotId));
    if (fault === "foreign_snapshot") await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
      remoteWorkspace: { ...source.runnerProfileJson!.remoteWorkspace as object, snapshotId: randomUUID() } } }).where(eq(heartbeatRuns.id, source.id));
    if (fault === "wrong_lease") await db.update(workspaceOperations).set({ metadata: { ...receipt.metadata, leaseId: randomUUID() } })
      .where(eq(workspaceOperations.id, receipt.id));
    const storage = getStorageService(), getObject = storage.getObject.bind(storage);
    const failingRead = ["missing_object", "corrupt_object"].includes(fault) ? vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (fault === "missing_object") throw new Error("fixture: object missing");
      const object = await getObject(...args); object.stream.destroy();
      return { ...object, stream: Readable.from([Buffer.from("corrupt")]) };
    }) : undefined;
    try {
      await expect(attachPreservedRemoteWorkspaceSnapshots({ db,
        companyId: fault === "wrong_company" ? randomUUID() : f.companyId,
        issueId: fault === "wrong_issue" ? randomUUID() : f.issueId,
        runId: writer.id, workspaceId: randomUUID(), sourceRunIds: [source.id], cwd: destination })).rejects.toThrow();
      expect(await readdir(destination)).toEqual(fault === "missing_object" || fault === "corrupt_object" ? [".paperclip-recovered"] : []);
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally { failingRead?.mockRestore(); }
  }, 30_000);

  it.each(["unchanged", "advanced"])("deduplicates immutable canonical sidecars when the source workspace is %s", async state => {
    const f = await failedRemotePreparation(); await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId), destination = path.join(root, randomUUID()); await mkdir(destination);
    await writeFile(path.join(destination, "later.txt"), "Later selected work\n");
    const [selected] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Later selected workspace", cwd: destination, mode: "isolated_workspace", strategyType: "project_primary" }).returning();
    await db.update(issues).set({ executionWorkspaceId: selected.id }).where(eq(issues.id, f.issueId));
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, status: "running", responsibleUserId: "local-board", contextSnapshot: { issueId: f.issueId } }).returning();
    const scope = { db, companyId: f.companyId, issueId: f.issueId, runId: writer.id,
      workspaceId: selected.id, sourceRunIds: [source.id, source.id], cwd: destination };
    const first = await attachPreservedRemoteWorkspaceSnapshots(scope);
    expect(first).toHaveLength(1);
    expect(await readFile(path.join(first[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    await writeFile(path.join(first[0].path, "files", "saved.txt"), "User edited sidecar\n");
    if (state === "advanced") {
      vi.stubEnv("DATABASE_URL", connectionString);
      try {
        const [child] = await db.insert(issues).values({ companyId: f.companyId, parentId: f.issueId,
          assigneeAgentId: source.agentId, title: "Later legitimate workspace writer", status: "in_progress", executionWorkspaceId: f.workspaceId }).returning();
        const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
          issueId: child.id, status: "running", responsibleUserId: "local-board", contextSnapshot: { issueId: child.id } }).returning();
        const storage = { ...getStorageService(), provider: "s3" as const };
        const reserved = await reserveRemoteWorkspace({ db, storage, companyId: f.companyId, issueId: child.id,
          runId: later.id, agentId: source.agentId, environmentId: f.lease.environmentId!, projectId: null,
          projectWorkspaceId: null, existingWorkspaceId: f.workspaceId, source: { kind: "empty" } });
        const allocation = await realpath(await mkdtemp(path.join(root, "later-writer-")));
        const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: child.id,
          heartbeatRunId: later.id, environmentId: f.lease.environmentId, provider: "daytona", providerLeaseId: randomUUID(), status: "active" }).returning();
        const target = { ...targets.get(f.lease.id)!, leaseId: lease.id, remoteCwd: allocation,
          runner: { ...targets.get(f.lease.id)!.runner!, syncIn: async operations => {
            for (const operation of operations) for (const file of operation.files) {
              await mkdir(path.dirname(file.targetPath), { recursive: true }); await cp(file.sourcePath, file.targetPath, { recursive: true });
            }
            return { filesTransferred: 1, bytesTransferred: 0, operations: [] };
          } } } satisfies AdapterSandboxExecutionTarget;
        const advanced = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: later.id, lease: lease as EnvironmentLease, target });
        await writeFile(path.join(advanced.remoteRoot, "later.txt"), "newer source workspace bytes\n");
        await saveRemoteWorkspace({ db, storage, workspace: advanced.workspace, runId: later.id, lease: advanced.lease,
          target: { ...target, remoteCwd: advanced.remoteRoot }, assertOwned: async () => {} });
        expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(false);
        const old = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
        expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, old.snapshotId)))[0].status).toBe("superseded");
      } finally { vi.unstubAllEnvs(); }
    }
    expect(await attachPreservedRemoteWorkspaceSnapshots(scope)).toEqual(first);
    expect(await readFile(path.join(first[0].path, "files", "saved.txt"), "utf8")).toBe("User edited sidecar\n");
    expect(await readFile(path.join(destination, "later.txt"), "utf8")).toBe("Later selected work\n");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionWorkspaceId).toBe(selected.id);
    expect(await readdir(path.join(destination, ".paperclip-recovered"))).toEqual([first[0].operationId]);
  }, 30_000);

  it("admits one HTTP Retry after a failed native preparation has verified saved work", async () => {
    const f = await failedRemotePreparation();
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    expect(source).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, executionStage: "preparing",
      status: "failed", errorCode: "setup_failed", nativeIssueId: null, nativeSessionId: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(await hasVerifiedWorkspaceRepair(db, source)).toBe(true);
    const app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: {
      previousRunId: f.runId, taskRetryRequestId: receipt.requestId } });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
      .toMatchObject({ status: "coalesced", runId: successors[0].id });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    const remote = source.runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect((await run(f.runId)).error).toBe(source.error);
  }, 30_000);

  async function recoveredPreparationRetryChain(mode: "certified" | "inherited_session" | "historical_warning" | "empty_object_log" = "inherited_session") {
    const f = await failedRemotePreparation("retained", mode !== "certified", mode === "historical_warning");
    await recoverRetainedWorkspace(f.input);
    if (mode !== "certified") await db.update(heartbeatRuns).set({ errorCode: "adapter_failed",
      sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const source = await run(f.runId);
    const [completed] = mode !== "certified" ? await db.insert(heartbeatRuns).values({
      companyId: f.companyId, issueId: f.issueId, agentId: source.agentId, status: "succeeded",
      createdAt: new Date(source.createdAt.getTime() - 1000), finishedAt: source.createdAt,
      sessionIdAfter: source.sessionIdBefore, resultJson: { summary: "Earlier turn completed" },
    }).returning() : [];
    if (completed) await db.update(heartbeatRuns).set({ retryOfRunId: completed.id }).where(eq(heartbeatRuns.id, source.id));
    if (mode === "empty_object_log") await recordPreparationObjectLog(source);
    const [failed] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, issueId: f.issueId,
      agentId: source.agentId, runtimeMode: "legacy", status: "failed", retryOfRunId: source.id,
      sessionIdBefore: source.sessionIdBefore,
      startedAt: new Date(), finishedAt: new Date(), executionStage: "preparing", errorCode: "setup_failed",
      error: "The workspace still has an unfinished writer or save operation.",
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      contextSnapshot: { issueId: f.issueId, source: "issue.continuation_recovery" },
      resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).returning();
    return { ...f, source, failed, completed };
  }

  async function recordPreparationObjectLog(source: typeof heartbeatRuns.$inferSelect, outputText?: string) {
    const store = objectLogFixture();
    const output = createHeartbeatRunOutput(db, { run: source, runId: source.id, issueId: source.issueId,
      runLogStore: store, identityRedactor: { chunk: (_stream, value) => value, redact: value => value },
      secretKeys: new Set(), appendRunEvent: vi.fn(), getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    const handlers = await output.begin(source);
    if (outputText) await handlers.onLog("stdout", outputText);
    const summary = await store.finalize(output.handle!);
    await output.flushOutputProgress({ force: true });
    await db.update(heartbeatRuns).set({ logBytes: summary.bytes, logSha256: summary.sha256,
      logCompressed: summary.compressed, stdoutExcerpt: output.stdoutExcerpt, stderrExcerpt: output.stderrExcerpt,
    }).where(eq(heartbeatRuns.id, source.id));
    return { store, summary };
  }

  it.each(["certified", "inherited_session", "historical_warning", "empty_object_log"] as const)("admits one HTTP Retry through a failed automatic successor after its preparation ancestor is recovered: %s", async mode => {
    const f = await recoveredPreparationRetryChain(mode);
    const app = boardRecoveryApp(), heartbeat = heartbeatService(db);
    const intent = { observedRunId: f.failed.id, idempotencyKey: randomUUID() };
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: {
      forceFreshSession: true, previousRunId: f.failed.id, taskRetryRequestId: receipt.requestId } });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    expect(await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.source.agentId, runId: successors[0].id, context: successors[0].contextSnapshot!,
      summary: null, exposeLowTrustRaw: false })).toMatchObject({ interruptedRunId: f.failed.id });
    const remote = (await run(f.source.id)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    expect((await run(f.runId)).error).toBe(f.source.error);
    if (f.completed) expect(await run(f.completed.id)).toEqual(f.completed);
  }, 30_000);

  it.each(["unknown_size", "unknown_digest", "wrong_digest", "nonempty_size", "foreign_reference", "other_store",
    "stdout", "stderr", "output_sequence", "output_time", "output_bytes", "output_stream", "compressed", "recorded_output"] as const)(
    "keeps a logged preparation ancestor held without complete empty-output proof: %s", async gate => {
      const f = await recoveredPreparationRetryChain("empty_object_log");
      if (gate === "recorded_output") await recordPreparationObjectLog(await run(f.source.id), "Provider work was recorded.\n");
      const patch: Partial<typeof heartbeatRuns.$inferInsert> = gate === "unknown_size" ? { logBytes: null }
        : gate === "unknown_digest" ? { logSha256: null }
        : gate === "wrong_digest" ? { logSha256: "0".repeat(64) }
        : gate === "nonempty_size" ? { logBytes: 1 }
        : gate === "foreign_reference" ? { logRef: `${f.companyId}/${f.source.agentId}/${randomUUID()}` }
        : gate === "other_store" ? { logStore: "s3_archive" }
        : gate === "stdout" ? { stdoutExcerpt: "Recorded provider output" }
        : gate === "stderr" ? { stderrExcerpt: "Recorded diagnostic output" }
        : gate === "output_sequence" ? { lastOutputSeq: 1 }
        : gate === "output_time" ? { lastOutputAt: new Date() }
        : gate === "output_bytes" ? { lastOutputBytes: 1 }
        : gate === "output_stream" ? { lastOutputStream: "stdout" }
        : gate === "compressed" ? { logCompressed: true } : {};
      if (Object.keys(patch).length) await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.source.id));
      const receipt = (await request(boardRecoveryApp()).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.failed.id, idempotencyKey: randomUUID() }).expect(202)).body;
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await action(f.actionId)).evidence.explicitUserContinuation).toBeUndefined();
    }, 30_000);

  it.each(["foreign_company", "foreign_task", "foreign_agent", "conflicting_binding", "missing_edge", "cycle", "forged_context",
    "live_predecessor", "live_controller", "unknown_stop", "failed_cleanup", "pending_cleanup", "failed_save",
    "unsafe_workspace", "operator_stop", "wrong_actor", "wrong_generation", "wrong_recovery_source", "sibling_hold", "completed_ancestor",
    "provider_event", "native_input", "session_checkpoint", "controller_recovery", "native_result", "process", "runtime_selected",
    "unknown_result", "provider_usage", "invalid_accounting", "foreign_lease_issue", "foreign_started_event", "invalid_started_event",
    "warning_reason", "provider_warning", "extra_after_warning", "unknown_failure_code", "missing_failure_code", "operator_stop_mislabeled"] as const)(
    "keeps ancestor Retry held when current proof changes: %s", async gate => {
      const f = await recoveredPreparationRetryChain(["warning_reason", "provider_warning", "extra_after_warning"].includes(gate)
        ? "historical_warning" : "inherited_session");
      const heartbeat = heartbeatService(db), app = receiptOnlyRecoveryApp();
      const original = readSystemRecovery((await action(f.actionId)).evidence)!;
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.failed.id, idempotencyKey: randomUUID() }).expect(202)).body;
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({
        generationId: original.generationId, attempts: original.attempts, intentId: receipt.requestId });
      if (["foreign_company", "foreign_task", "foreign_agent", "conflicting_binding"].includes(gate)) {
        const companyId = gate === "foreign_company" ? randomUUID() : f.companyId;
        if (companyId !== f.companyId) {
          await db.insert(companies).values({ id: companyId, name: "Other company", issuePrefix: `X${companyId.slice(0, 6)}` });
          fixtureCompanyIds.add(companyId);
        }
        const agentId = gate === "foreign_company" || gate === "foreign_agent" ? randomUUID() : f.source.agentId;
        if (agentId !== f.source.agentId) await db.insert(agents).values({ id: agentId, companyId,
          name: "Other owner", adapterType: "paperclip_runner" });
        const issueId = gate === "foreign_company" || gate === "foreign_task" || gate === "conflicting_binding" ? randomUUID() : f.issueId;
        if (issueId !== f.issueId) await db.insert(issues).values({ id: issueId, companyId, title: "Other work" });
        const [bridge] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId,
          nativeIssueId: gate === "conflicting_binding" ? f.issueId : issueId, status: "failed", finishedAt: new Date(), retryOfRunId: f.source.id,
          createdAt: f.source.createdAt, contextSnapshot: { issueId: f.issueId } }).returning();
        await db.update(heartbeatRuns).set({ retryOfRunId: bridge.id }).where(eq(heartbeatRuns.id, f.failed.id));
      }
      if (gate === "missing_edge" || gate === "forged_context") await db.update(heartbeatRuns).set({ retryOfRunId: null,
        ...(gate === "forged_context" ? { contextSnapshot: { ...f.failed.contextSnapshot,
          previousRunId: f.source.id, retryOfRunId: f.source.id } } : {}) }).where(eq(heartbeatRuns.id, f.failed.id));
      if (gate === "cycle") await db.update(heartbeatRuns).set({ retryOfRunId: f.source.id }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "live_predecessor") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "live_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "provider_event" || gate === "extra_after_warning") await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, runId: f.source.id, agentId: f.source.agentId, stream: "system", level: "info",
        eventType: gate === "provider_event" ? "session.started" : "lifecycle", message: "Unexpected later event" });
      if (["native_input", "session_checkpoint", "controller_recovery"].includes(gate)) {
        const key = gate === "native_input" ? "nativeExecutionInput" : gate === "session_checkpoint" ? "sessionCheckpoint" : "nativeControllerRecovery";
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.source.runnerProfileJson, [key]: { sessionId: randomUUID() } } })
          .where(eq(heartbeatRuns.id, f.source.id));
      }
      if (gate === "native_result") {
        const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.companyId, f.companyId));
        await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId, completionContractId: contract.id })
          .where(eq(heartbeatRuns.id, f.source.id));
        await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.source.id,
          completionContractId: contract.id, schemaStatus: "accepted", canonicalSha256: "unexpected", serverFingerprint: "unexpected",
          resultJson: { terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, result: CONTROL_PLANE_CONFORMANCE_RESULT } });
      }
      if (gate === "process") await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "runtime_selected") await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "unknown_result") await db.update(heartbeatRuns).set({ resultJson: { ...f.source.resultJson, unknownOutcome: true } })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "provider_usage" || gate === "invalid_accounting") await db.update(heartbeatRuns).set({ usageJson: gate === "provider_usage"
        ? { inputTokens: 1 } : { ledgerScope: { issueId: randomUUID(), projectId: null, billingCode: null } } }).where(eq(heartbeatRuns.id, f.source.id));
      if (["foreign_started_event", "invalid_started_event", "warning_reason", "provider_warning"].includes(gate))
        await db.update(heartbeatRunEvents).set(gate === "foreign_started_event" || gate === "provider_warning"
          ? { sourceEventId: randomUUID() } : { payload: gate === "warning_reason" ? { reason: "unknown", revision: randomUUID() } : { unknown: true } })
          .where(and(eq(heartbeatRunEvents.runId, f.source.id), eq(heartbeatRunEvents.seq, 1)));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      if (gate === "foreign_lease_issue") {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other allocation owner" }).returning();
        await db.update(environmentLeases).set({ issueId: other.id }).where(eq(environmentLeases.id, lease.id));
      }
      if (gate === "unknown_stop") await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        remoteExecutionTermination: null } }).where(eq(environmentLeases.id, lease.id));
      if (gate === "failed_cleanup") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
      if (gate === "pending_cleanup") await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        pendingCleanupInFlight: true } }).where(eq(environmentLeases.id, lease.id));
      if (gate === "failed_save") await db.update(workspaceOperations).set({ status: "failed" }).where(and(
        eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.source.id),
        eq(workspaceOperations.phase, "workspace_recovery")));
      if (gate === "unsafe_workspace") {
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
        await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
          remoteWorkspace: { ...(workspace.metadata!.remoteWorkspace as object), dirty: true, writerRunId: f.source.id } } })
          .where(eq(executionWorkspaces.id, f.workspaceId));
      }
      if (gate === "operator_stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted" })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (["unknown_failure_code", "missing_failure_code", "operator_stop_mislabeled"].includes(gate)) await db.update(heartbeatRuns)
        .set({ errorCode: gate === "missing_failure_code" ? null : gate === "operator_stop_mislabeled" ? "operator_interrupted" : "unknown_failure" })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (gate === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" })
        .where(eq(agentWakeupRequests.id, wake.id));
      if (gate === "wrong_generation") await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
        taskRetry: { ...(wake.payload!.taskRetry as object), generationId: randomUUID() } } }).where(eq(agentWakeupRequests.id, wake.id));
      if (gate === "wrong_recovery_source") {
        const record = await action(f.actionId);
        const systemRecovery = { ...readSystemRecovery(record.evidence)!, sourceRunId: randomUUID(),
          intentId: null, state: "exhausted" as const };
        await db.update(issueRecoveryActions).set({ evidence: { ...record.evidence, systemRecovery } })
          .where(eq(issueRecoveryActions.id, record.id));
        const next = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
          actorSource: "local_implicit", observedRunId: f.failed.id, idempotencyKey: randomUUID() });
        expect(next.requestId).toBe(receipt.requestId);
        expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(systemRecovery);
      }
      if (gate === "sibling_hold" || gate === "completed_ancestor") {
        const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId,
          issueId: f.issueId, status: gate === "completed_ancestor" ? "succeeded" : "failed", finishedAt: new Date(),
          createdAt: new Date(f.source.createdAt.getTime() - 1000), runnerProfileJson: f.source.runnerProfileJson }).returning();
        const originalAction = await action(f.actionId);
        const systemRecovery = { ...createSystemRecovery(other.id), state: "exhausted" as const };
        const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: other.id,
          status: "resolved", outcome: "blocked", nextAction: "Existing hold", evidence: { ...originalAction.evidence,
            runId: other.id, systemRecovery } }).returning();
        if (gate === "completed_ancestor") await db.update(heartbeatRuns).set({ retryOfRunId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
        const next = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
          actorSource: "local_implicit", observedRunId: f.failed.id, idempotencyKey: randomUUID() });
        expect(next.requestId).toBe(receipt.requestId);
        expect(readSystemRecovery((await action(hold.id)).evidence)).toEqual(systemRecovery);
      }
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await action(f.actionId)).evidence.explicitUserContinuation).toBeUndefined();
    }, 30_000);

  it.each(["current worker", "stopped worker"] as const)("resumes the same failed-preparation HTTP Retry from the real preservation worker: %s", async mode => {
    const f = await failedRemotePreparation();
    const stoppedWorker = mode === "stopped worker" ? await stoppedWorkspaceWorker(f) : undefined;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null,
      metadata: { ...lease.metadata, remoteExecutionTermination: null } }).where(eq(environmentLeases.id, lease.id));
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    f.runtime.retryPendingSandboxTeardown.mockImplementation(async () => {
      await stopped;
      return { providerLeaseId: f.providerLeaseId, state: "stopped" };
    });
    const errors = vi.fn(), heartbeat = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, heartbeat.resumeRemoteStopComments);
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${requestId}`));
    let requestId: string;
    try {
      await worker.ready;
      const app = boardRecoveryApp(), intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
      const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
      requestId = receipt.requestId;
      expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(requestId);
      await expect.poll(() => f.runtime.retryPendingSandboxTeardown.mock.calls.length, { timeout: 20_000 }).toBe(1);
      expect(await successors()).toHaveLength(0);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0].metadata?.remoteExecutionTermination).toBeFalsy();
      releaseStop();
      await expect.poll(async () => (await successors()).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await successors();
      expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: requestId });
      expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      if (mode === "stopped worker") {
        expect(stoppedWorker!.proof).toHaveBeenCalledWith({ runId: f.runId, ownerToken: stoppedWorker!.owner.token,
          worker: stoppedWorker!.deploymentWorker });
        expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceOwnerStopProof).toEqual(stoppedWorker!.stopProof);
        expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
      }
      const remote = (await run(f.runId)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
      const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId, snapshotId: remote.snapshotId });
      try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
      finally { await saved.cleanup(); }
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, requestId), heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      expect(await successors()).toHaveLength(1);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      expect((await run(f.runId))).toMatchObject({ status: "failed", errorCode: "setup_failed" });
      expect(errors).not.toHaveBeenCalled();
    } finally { releaseStop(); await coordinator.stop(); await worker.stop(); stoppedWorker?.proof.mockRestore(); }
  }, 40_000);

});
