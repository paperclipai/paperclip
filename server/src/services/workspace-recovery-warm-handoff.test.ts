import { inspectWorkspaceSource } from "./workspace-source-inspection.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { environmentService } from "./environments.js";
import { nativeWorkspaceSyncStateRoot, prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { verifiedWorkspaceSnapshotReceipt } from "./workspace-recovery-snapshot.js";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, agentWakeupRequests, executionWorkspaces } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { useWorkspaceRecoveryFixture, action, connectionString, db, failedWarmSource, replaceFixtureState, root, run, warmHandoffSource } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  describe("verified warm allocation handoffs", () => {
    let original: { db: typeof db; root: string; connectionString: string; home: string | undefined };
    let isolated: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let isolatedDb: typeof db | undefined;
    let isolatedRoot: string | undefined;
    beforeAll(async () => {
      original = { db, root, connectionString, home: process.env.PAPERCLIP_HOME };
      const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_HANDOFF_TEST_DATABASE_URL");
      if (external) {
        await applyPendingMigrations(external);
        isolated = { connectionString: external, cleanup: async () => {} };
      } else isolated = await startEmbeddedPostgresTestDatabase("workspace-warm-handoff-");
      isolatedDb = createDb(isolated.connectionString);
      if (external) await isolatedDb.execute(sql`TRUNCATE TABLE companies CASCADE`);
      isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-warm-handoff-files-"));
      replaceFixtureState({ db: isolatedDb, root: isolatedRoot, connectionString: isolated.connectionString });
      process.env.PAPERCLIP_HOME = path.join(root, "home");
    }, 30_000);
    afterAll(async () => {
      await isolatedDb?.$client.end(); await isolated?.cleanup();
      if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
      if (original) {
        replaceFixtureState({ db: original.db, root: original.root, connectionString: original.connectionString });
        if (original.home === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = original.home;
      }
    });
  it.each([{ hops: 1, snapshot: false }, { hops: 2, snapshot: false }, { hops: 2, snapshot: true }])(
    "settles adopted warm source history: $hops handoffs, snapshot=$snapshot", async ({ hops, snapshot }) => {
      const f = await failedWarmSource(false, hops);
      if (snapshot) {
        const runner = targets.get(f.lease.id)!.runner!;
        runner.syncIn = async () => ({ filesTransferred: 0, bytesTransferred: 0, operations: [] });
        runner.syncOut = async operations => {
          for (const operation of operations) for (const file of operation.files)
            await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
          return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
        };
        await rm(path.join(nativeWorkspaceSyncStateRoot(), f.runId), { recursive: true });
      }
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(lease).toMatchObject({ status: "released", cleanupStatus: "success",
        leasePolicy: snapshot ? "retain_on_failure" : "reuse_by_environment" });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(!snapshot);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retry.requestId!)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      if (snapshot) {
        const state = readSystemRecovery((await action(f.actionId)).evidence)!;
        expect(await verifiedWorkspaceSnapshotReceipt(db, { companyId: f.companyId, issueId: f.issueId,
          runId: f.runId, actionId: f.actionId, operationIds: state.preservationOperationIds })).not.toBeNull();
        expect(lease.metadata?.nativeSourceRetention).toMatchObject({ settlement: "snapshot_retained" });
      } else expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
    }, 30_000);

  it("keeps adopted warm history held when a predecessor changes after export", async () => {
    const f = await failedWarmSource(false, 1);
    const history = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId),
      eq(environmentLeases.providerLeaseId, f.providerLeaseId)));
    const predecessor = history.find(lease => lease.id !== f.lease.id)!;
    const stop = f.runtime.retryPendingSandboxTeardown.getMockImplementation()!;
    f.runtime.retryPendingSandboxTeardown.mockImplementationOnce(async input => {
      const receipt = await stop(input);
      await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, predecessor.id));
      return receipt;
    });
    await recoverRetainedWorkspace(f.input);
    const state = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(state.state).not.toBe("complete");
    expect(state.failure?.code).toBe("allocation_ownership_ambiguous");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].leasePolicy).toBe("retain_on_failure");
    expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
  }, 30_000);

  it.each([1, 2])("recovers a stopped native source after %s verified warm predecessor handoffs", async hops => {
    const f = await warmHandoffSource(hops);
    expect((await run(f.priorRunId)).runnerProfileJson?.nativeWorkspaceSync).toMatchObject({ state: "finalized", leaseId: f.priorLeaseId });
    const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.priorLeaseId));
    expect(previous).toMatchObject({ status: "expired", cleanupStatus: "success", providerLeaseId: f.providerLeaseId });
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
    const source = await run(f.runId), freshProviderLeaseId = randomUUID();
    const [fresh] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date() }).returning();
    const remoteCwd = path.join(root, fresh.id, "remote");
    const freshLease = await environmentService(db).acquireLease({ companyId: f.companyId, environmentId: f.lease.environmentId!,
      issueId: f.issueId, heartbeatRunId: fresh.id, provider: "daytona", providerLeaseId: freshProviderLeaseId,
      metadata: { ...f.lease.metadata, remoteCwd } });
    const freshTarget = { ...targets.get(f.lease.id)!, leaseId: freshLease.id, remoteCwd,
      sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: freshProviderLeaseId } };
    expect(await prepareNativeWorkspaceSync({ db, companyId: f.companyId, workspaceId: f.issueId,
      workspaceLocalDir: f.host, runId: fresh.id, lease: freshLease, target: freshTarget, resourceDisposition: "keep_running" })).not.toBeNull();
    expect(await resumeNativeWorkspaceSync({ db, runId: fresh.id, target: freshTarget })).toBe(true);
    expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
      .toMatchObject({ status: "verified" });
  }, 30_000);

  it.each(["active", "active_run", "active_control", "foreign_company", "environment", "workspace", "task", "agent", "unfinalized", "owner", "missing_proof", "conflicting_proof", "dangling_proof", "extra_history"])(
    "keeps ambiguous warm source history fenced: %s", async fault => {
      const f = await warmHandoffSource();
      const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.priorLeaseId));
      if (fault === "active") await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, previous.id));
      if (fault === "active_run") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.priorRunId));
      if (fault === "active_control") adapterExecutionControls.set(f.priorRunId, createAdapterExecutionControl());
      if (fault === "foreign_company") {
        const [foreign] = await db.insert(companies).values({ name: "Foreign owner", issuePrefix: `F${randomUUID().slice(0, 6)}` }).returning();
        await db.update(environmentLeases).set({ companyId: foreign.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "environment") {
        const [other] = await db.insert(environments).values({ name: randomUUID(), driver: "sandbox" }).returning();
        await db.update(environmentLeases).set({ environmentId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "workspace") {
        const [other] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "isolated_workspace", strategyType: "test", name: "Other workspace" }).returning();
        await db.update(environmentLeases).set({ executionWorkspaceId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "task") {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
        await db.update(environmentLeases).set({ issueId: other.id }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "agent") {
        const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other agent", adapterType: "paperclip_runner" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.priorRunId));
      }
      if (fault === "unfinalized") {
        const prior = await run(f.priorRunId), reference = prior.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prior.runnerProfileJson, nativeWorkspaceSync: { ...reference, state: "prepared", finalHostSha256: null } } }).where(eq(heartbeatRuns.id, prior.id));
      }
      if (fault === "owner") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.priorRunId));
      if (fault === "missing_proof") {
        const metadata = { ...previous.metadata }; delete metadata.reusableLeaseSuccessor;
        await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, previous.id));
      }
      if (fault === "conflicting_proof") await db.update(environmentLeases).set({ metadata: { ...previous.metadata,
        reusableLeaseSuccessor: { ...(previous.metadata!.reusableLeaseSuccessor as Record<string, unknown>), successorRunId: randomUUID() } } }).where(eq(environmentLeases.id, previous.id));
      if (fault === "dangling_proof") await db.update(environmentLeases).set({ metadata: { ...previous.metadata, reusableLeasePredecessor: {} } }).where(eq(environmentLeases.id, previous.id));
      if (fault === "extra_history") await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: previous.environmentId,
        heartbeatRunId: f.priorRunId, issueId: f.issueId, provider: "daytona", providerLeaseId: f.providerLeaseId,
        status: "expired", leasePolicy: "reuse_by_environment", cleanupStatus: "success", metadata: previous.metadata });
      try {
        expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
          .toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
        await expect(readFile(path.join(f.host, "after-warm-stop.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { adapterExecutionControls.get(f.priorRunId)?.finish(); adapterExecutionControls.delete(f.priorRunId); }
    }, 30_000);

  it("keeps server handoff receipts across metadata updates and same-run reacquisition", async () => {
    const f = await warmHandoffSource(1, async lease => {
      const proof = lease.metadata!.reusableLeasePredecessor;
      expect(proof).toMatchObject({ schema: "paperclip.reusable-lease-handoff.v1", successorLeaseId: lease.id });
      const forged = { schema: "forged-provider-metadata" };
      const updated = await environmentService(db).updateLeaseMetadata(lease.id, { ...lease.metadata,
        reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged, marker: "updated" });
      expect(updated!.metadata?.reusableLeasePredecessor).toEqual(proof);
      expect(updated!.metadata?.reusableLeaseSuccessor).toBeUndefined();
      await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
      const reacquired = await environmentService(db).acquireLease({ companyId: lease.companyId, environmentId: lease.environmentId!,
        issueId: lease.issueId, heartbeatRunId: lease.heartbeatRunId, provider: lease.provider, providerLeaseId: lease.providerLeaseId,
        leasePolicy: "reuse_by_environment", reusesReusableLeaseId: lease.id,
        metadata: { ...updated!.metadata, reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged } });
      expect(reacquired.id).toBe(lease.id);
      expect(reacquired.metadata?.reusableLeasePredecessor).toEqual(proof);
      expect(reacquired.metadata?.reusableLeaseSuccessor).toBeUndefined();
    });
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("does not manufacture handoff authority from injected fresh or orphan lease metadata", async () => {
    const f = await warmHandoffSource(), source = await run(f.runId);
    const forged = { schema: "paperclip.reusable-lease-handoff.v1", successorLeaseId: f.lease.id };
    const values = { companyId: f.companyId, environmentId: f.lease.environmentId!, issueId: f.issueId,
      heartbeatRunId: source.id, provider: "daytona", providerLeaseId: randomUUID(),
      metadata: { agentId: source.agentId, reusableLeasePredecessor: forged, reusableLeaseSuccessor: forged } };
    const fresh = await environmentService(db).acquireLease(values);
    const orphan = await environmentService(db).insertPendingCleanupLease({ ...values, providerLeaseId: randomUUID(), failureReason: "test" });
    for (const lease of [fresh, orphan]) {
      expect(lease.metadata?.reusableLeasePredecessor).toBeUndefined();
      expect(lease.metadata?.reusableLeaseSuccessor).toBeUndefined();
    }
  }, 30_000);

  it("rolls back both handoff links and keeps provider mismatches or retained sources fenced", async () => {
    const f = await warmHandoffSource(), source = await run(f.runId), service = environmentService(db);
    const values = { companyId: f.companyId, environmentId: f.lease.environmentId!, issueId: f.issueId,
      heartbeatRunId: f.priorRunId, provider: "daytona", providerLeaseId: randomUUID(),
      leasePolicy: "reuse_by_environment" as const, metadata: { agentId: source.agentId } };
    const prior = await service.acquireLease(values);
    await service.releaseLease(prior.id, "released", { cleanupStatus: "success" });
    const [before] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, prior.id));
    const rollback = new Error("rollback_handoff");
    await expect(db.transaction(async tx => {
      const acquired = await environmentService(tx as unknown as typeof db).acquireLease({ ...values, heartbeatRunId: f.runId, replacesReusableLeaseId: prior.id });
      expect(acquired.metadata?.reusableLeasePredecessor).toMatchObject({ previousLeaseId: prior.id, successorLeaseId: acquired.id });
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, prior.id)))[0]).toEqual(before);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, values.providerLeaseId))).toHaveLength(1);
    await expect(service.acquireLease({ ...values, heartbeatRunId: f.runId, provider: "foreign-provider", replacesReusableLeaseId: prior.id })).rejects.toThrow("ownership changed");
    await expect(service.acquireLease({ ...values, providerLeaseId: f.providerLeaseId, replacesReusableLeaseId: f.lease.id })).rejects.toThrow("ownership changed");
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date() }).returning();
    await service.acquireLease({ ...values, heartbeatRunId: later.id, providerLeaseId: f.providerLeaseId });
    expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
      .toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
  }, 30_000);

  });

});
