import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, executionWorkspaces,
  heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, workAssessments, workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { nativeRunnerCheckpointWriter } from "../native-runtime/native-runner-checkpoint.js";
import { readUpgradeReadiness } from "./upgrade-readiness.js";
import { currentWorkspaceWorker } from "../native-runtime/native-workspace-platform-proof.js";
import { withNativeWorkspaceFinalizationOwnership } from "../native-runtime/native-workspace-finalization-ownership.js";
import { resumeNativeWorkspaceFinalization } from "../native-runtime/native-workspace-finalizer.js";
import { projectCommittedRun } from "../native-runtime/native-run-projection.js";

describe("post-result upgrade readiness", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const runs: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("post-result-upgrade-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    for (const [key, value] of Object.entries({ RAILWAY_PROJECT_ID: "project", RAILWAY_ENVIRONMENT_ID: "environment",
      RAILWAY_SERVICE_ID: "service", RAILWAY_DEPLOYMENT_ID: "deployment", PAPERCLIP_CLOUD_STACK_ID: "stack",
      PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example", PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "fixture-token" })) vi.stubEnv(key, value);
  }, 60_000);
  afterEach(async () => { if (runs.length) await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, runs)); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const resultId = randomUUID(), runnerInstanceId = randomUUID(), nativeSessionId = randomUUID();
    const controller = await currentNativeControllerIdentity();
    const leaseOwner = `execution:${randomUUID()}`;
    const remote = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId: "sandbox",
      remoteCwd: "/workspace", epoch: 1, state: "prepared", snapshotId: null };
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null, source: { kind: "empty" },
      location: { environmentId, leaseId, providerLeaseId: "sandbox", remoteCwd: "/workspace" }, writerRunId: runId, dirty: true };
    await db.insert(companies).values({ id: companyId, name: "Upgrade", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Accepted work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: "a".repeat(64), createdByActorType: "system", createdByActorId: "test" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "local_directory", name: "Remote", cwd: "/workspace", providerType: "cloud_sandbox", metadata: { remoteWorkspace: authority } });
    await db.insert(environments).values({ id: environmentId, name: `Sandbox ${environmentId}`, driver: "sandbox" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "running",
      runtimeMode: "native", nativePhase: "observed", runnerInstanceId, nativeSessionId, completionContractId: contractId,
      processPid: process.pid, processStartedAt: controller.processStartedAt,
      runnerProfileJson: { remoteWorkspace: remote, nativeExecutionInput: { binding: { executionWorkspaceId: workspaceId } } },
      contextSnapshot: { executionWorkspaceId: workspaceId } });
    runs.push(runId);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, executionWorkspaceId: workspaceId,
      issueId, heartbeatRunId: runId, provider: "daytona", providerLeaseId: "sandbox", leasePolicy: "retain_on_failure" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 });
    const root = await mkdtemp(path.join(os.tmpdir(), "post-result-header-"));
    const core = new DurablePrpControlPlane({ stateDirectory: root, identity: { runId, runnerInstanceId,
      normalizedSessionId: nativeSessionId, environmentLeaseId: workspaceId, turnId: "turn", itemId: "item" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const writer = nativeRunnerCheckpointWriter(db, { companyId, issueId, runId, leaseOwner, bootId: controller.bootId,
      authorityRunId: runId, generation: 1 });
    core.setCheckpointPersistence(writer);
    try { core.issueBootstrapTicket(); await core.flushCheckpoint(); }
    finally { await core.stop(); await rm(root, { recursive: true, force: true }); }
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: resultId, schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } }, canonicalSha256: "b".repeat(64) });
    await db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing", resultId }).where(eq(nativeRunFinalizations.runId, runId));
    return { companyId, issueId, runId, agentId, contractId, resultId, workspaceId, environmentId, leaseId, remote, authority, controller,
      probe: () => readUpgradeReadiness(db, { activeRunIds: new Set([runId]), counters: () => ({ activeRuns: 1, pendingWakes: 0, draining: false }) }) };
  }

  it("certifies accepted remote work without changing its lease, result or task admission", async () => {
    const f = await seed();
    const before = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await f.probe()).toMatchObject({ ready: true, recoverableRuns: 1, blockingRuns: 0, draining: false });
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual(before);
  });

  it.each(["result_accepted", "workspace_finalizing", "retryable_failure"])("retains the real recovery owner for %s", async phase => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ phase, leaseOwner: null, leaseExpiresAt: null,
      ...(phase === "retryable_failure" ? { failureCode: "native_workspace_sync_out_failed", nextAttemptAt: new Date(Date.now() + 60_000) } : {}),
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await f.probe()).toMatchObject({ ready: true, recoverableRuns: 1 });
  });

  it("requires the accepted terminal result, current task, remote lease and exact physical owner", async () => {
    const f = await seed();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const profile = run.runnerProfileJson!;
    const owner = { token: randomUUID(), controllerBootId: f.controller.bootId, hostname: os.hostname(),
      pid: f.controller.pid, processStartedAt: f.controller.processStartedAt.toISOString(), worker: currentWorkspaceWorker() };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.probe()).ready).toBe(true);
    for (const physical of [null, { ...owner, token: "" }, { ...owner, worker: undefined }, { ...owner, controllerBootId: randomUUID() },
      { ...owner, hostname: "another-host" }, { ...owner, processStartedAt: new Date(0).toISOString() },
      { ...owner, worker: { ...owner.worker, deploymentId: "another-deployment" } }, { ...owner, worker: { ...owner.worker, extra: true } }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeWorkspaceFinalizationOwner: physical ?? {} } }).where(eq(heartbeatRuns.id, f.runId));
      expect((await f.probe()).ready).toBe(false);
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    for (const patch of [{ controllerGeneration: 0 }, { controllerBootId: "another-boot" }, { phase: "unknown" }, { phase: "terminal_failure" }]) {
      await db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, f.runId));
      expect((await f.probe()).ready).toBe(false);
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 1, controllerBootId: f.controller.bootId, phase: "workspace_finalizing" }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    await expect(db.update(heartbeatRuns).set({ completionContractId: null }).where(eq(heartbeatRuns.id, f.runId)))
      .rejects.toMatchObject({ cause: { code: "23503" } });
    expect((await f.probe()).ready).toBe(true); // PostgreSQL retains the accepted result's exact contract binding.
    for (const terminal of [null, {}, { runTerminalState: "active" }, { runTerminalState: "unknown" }]) {
      await db.update(nativeRunResults).set({ resultJson: { terminal } }).where(eq(nativeRunResults.id, f.resultId));
      expect((await f.probe()).ready).toBe(false);
    }
    await db.update(nativeRunResults).set({ resultJson: { terminal: { runTerminalState: "succeeded" } } }).where(eq(nativeRunResults.id, f.resultId));
    await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, f.resultId));
    expect((await f.probe()).ready).toBe(false);
    await db.update(nativeRunResults).set({ schemaStatus: "accepted" }).where(eq(nativeRunResults.id, f.resultId));
    const foreignCheckout = randomUUID();
    await db.insert(heartbeatRuns).values({ id: foreignCheckout, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    for (const patch of [{ executionRunId: null }, { checkoutRunId: foreignCheckout }, { status: "cancelled" }, { assigneeAgentId: null }]) {
      await db.update(issues).set(patch).where(eq(issues.id, f.issueId));
      expect((await f.probe()).ready).toBe(false);
      await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId, status: "in_progress", assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));
    }
    for (const patch of [{ cleanupStatus: "pending" }, { status: "expired" }, { expiresAt: new Date(0) },
      { providerLeaseId: "another-sandbox" }, { heartbeatRunId: null }]) {
      await db.update(environmentLeases).set(patch).where(eq(environmentLeases.id, f.leaseId));
      expect((await f.probe()).ready).toBe(false);
      await db.update(environmentLeases).set({ status: "active", cleanupStatus: null, expiresAt: null,
        providerLeaseId: "sandbox", heartbeatRunId: f.runId }).where(eq(environmentLeases.id, f.leaseId));
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeWorkspaceSync: { state: "prepared" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.probe()).ready).toBe(false);
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: `native-finalizer:${randomUUID()}`, leaseExpiresAt: new Date(Date.now() + 600_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await f.probe()).ready).toBe(false);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await f.probe()).ready).toBe(true);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "");
    expect((await f.probe()).ready).toBe(false);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-token");
  });

  it("allows independent admitted work while observing both saved results", async () => {
    const first = await seed(), second = await seed();
    expect(await readUpgradeReadiness(db, { activeRunIds: new Set([first.runId, second.runId]),
      counters: () => ({ activeRuns: 2, pendingWakes: 0, draining: false }) })).toMatchObject({ ready: true, recoverableRuns: 2 });
  });

  it("requires the applied decision and saved workspace before certifying committed projection", async () => {
    const f = await seed(), assessmentId = randomUUID(), decisionId = randomUUID();
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      contractId: f.contractId, resultId: f.resultId, triggerKind: "native_result", triggerActorCompanyId: f.companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      assessmentId, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "done",
      reasonCode: "completion_contract_satisfied", decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
    await db.update(nativeRunFinalizations).set({ phase: "committed", assessmentId, decisionId, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(issues).set({ status: "done", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    expect((await f.probe()).ready).toBe(false);
    const [barrier] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() }).returning();
    expect((await f.probe()).ready).toBe(true);
    for (const patch of [{ applicationState: "proposed" }, { applicationState: "superseded" }]) {
      await db.update(statusDecisions).set(patch).where(eq(statusDecisions.id, decisionId));
      expect((await f.probe()).ready).toBe(false);
    }
    await db.update(statusDecisions).set({ applicationState: "applied" }).where(eq(statusDecisions.id, decisionId));
    await db.update(workspaceOperations).set({ status: "running" }).where(eq(workspaceOperations.id, barrier.id));
    expect((await f.probe()).ready).toBe(false);
    await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id, barrier.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await projectCommittedRun({ db, run, coordinator });
    await projectCommittedRun({ db, run, coordinator });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(1);
  });

  it("waits for a real signed stopped-worker receipt, then resumes workspace ownership once", async () => {
    const f = await seed();
    const worker = currentWorkspaceWorker()!;
    const owner = { token: randomUUID(), controllerBootId: f.controller.bootId, hostname: os.hostname(),
      pid: f.controller.pid, processStartedAt: f.controller.processStartedAt.toISOString(), worker };
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, f.runId));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "EdDSA", use: "sig" }] }));
    let stopped = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ runId: f.runId, ownerToken: owner.token, worker });
      if (!stopped) return new Response(null, { status: 409 });
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "paperclip-workspace-worker-stop+jwt", kid: "fixture" })).toString("base64url");
      const iat = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1",
        sub: "stack", runId: f.runId, ownerToken: owner.token, worker, stopped: true, iat, exp: iat + 60 })).toString("base64url");
      return Response.json({ receipt: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}` });
    });
    try {
      expect((await f.probe()).ready).toBe(true);
      expect(fetch).not.toHaveBeenCalled(); // Observation never acquires stop authority.
      vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "replacement");
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
        nativeWorkspaceFinalizationOwner: { ...owner, hostname: "previous-container", controllerBootId: "previous-boot" } } }).where(eq(heartbeatRuns.id, f.runId));
      const scope = { db, companyId: f.companyId, runId: f.runId };
      const copyback = vi.fn();
      expect(await withNativeWorkspaceFinalizationOwnership(scope, copyback)).toEqual({ acquired: false, reason: "platform_stop_pending" });
      expect(copyback).not.toHaveBeenCalled();
      stopped = true;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const joined = new Promise<void>(resolve => { release = resolve; });
      const first = withNativeWorkspaceFinalizationOwnership(scope, async ownership => {
        await ownership.assertHeld(); copyback(); enter(); await joined;
        await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
          executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
      });
      try {
        await entered;
        expect(await resumeNativeWorkspaceFinalization({ db, runId: f.runId })).toBeNull();
      } finally { release(); await first; }
      expect(await resumeNativeWorkspaceFinalization({ db, runId: f.runId })).toMatchObject({ status: "succeeded" });
      expect(copyback).toHaveBeenCalledOnce();
      const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(recovered.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
      expect(recovered.runnerProfileJson?.nativeWorkspaceOwnerStopProof).toMatchObject({ runId: f.runId, ownerToken: owner.token, stopped: true, worker });
    } finally { fetch.mockRestore(); vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "deployment"); }
  });
});
