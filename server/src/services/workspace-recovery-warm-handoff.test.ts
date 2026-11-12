import { inspectWorkspaceSource } from "./workspace-source-inspection.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { environmentService } from "./environments.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import * as nativeWorkspaceSync from "./native-runtime/native-workspace-sync.js";
import { nativeWorkspaceSyncStateRoot, prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { readSystemRecovery, createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { verifiedWorkspaceSnapshotReceipt } from "./workspace-recovery-snapshot.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, executionWorkspaces } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { nativeWorkspaceFinalizationLockKey } from "./native-runtime/native-workspace-finalization-ownership.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { claimNativeSessionResumptions } from "./native-runtime/native-finalization-reconciler.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { legacyShutdownWorkspaceResourceProtected } from "./legacy-shutdown-workspace-settlement.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { useWorkspaceRecoveryFixture, action, connectionString, db, failedWarmSource, replaceFixtureState, root, run, seed, warmHandoffSource } from "./__tests__/workspace-recovery-fixture.js";
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

  // Regression: a native run resumed a warm sandbox and was interrupted before
  // provider work. The restore hold stopped that sandbox and changed its lease
  // to retain_on_failure. Recovery saved the files, but nothing returned the
  // lease to reuse, so the next run paid a new sandbox and a full realize.
  it.each([
    ["the hold recorded its original policy", "current", "reuse_by_environment"],
    // Old-saved/new-resumed: a previous release wrote the marker without the
    // original policy. The reuse scope that only a reusable acquisition writes
    // still proves it.
    ["an older release saved the hold over a scoped reusable lease", "legacy_scoped", "reuse_by_environment"],
    ["an older release saved the hold without reuse proof", "legacy_unscoped", "retain_on_failure"],
  ] as const)("returns a settled restore hold to warm reuse when %s", async (_label, marker, policy) => {
    const f = await warmHandoffSource(1);
    const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(held).toMatchObject({ leasePolicy: "retain_on_failure", status: "released" });
    expect(held.metadata?.workspaceRestoreRecovery).toMatchObject({ schema: "paperclip.workspace-restore-recovery.v1", runId: f.runId });
    if (marker !== "current") {
      const { originalLeasePolicy: _original, ...legacyMarker } = held.metadata!.workspaceRestoreRecovery as Record<string, unknown>;
      await db.update(environmentLeases).set({ metadata: { ...held.metadata, workspaceRestoreRecovery: legacyMarker,
        ...(marker === "legacy_scoped" ? { reusableSandboxLease: { version: 1, companyId: f.companyId } } : {}) } })
        .where(eq(environmentLeases.id, f.lease.id));
    }
    expect(await legacyShutdownWorkspaceResourceProtected(db, held)).toBe(true);
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    const [settled] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(settled).toMatchObject({ leasePolicy: policy, status: "released", cleanupStatus: "success",
      providerLeaseId: f.providerLeaseId });
    expect(settled.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped" });
    if (policy === "reuse_by_environment") {
      expect(settled.metadata?.workspaceRestoreRecovery).toBeUndefined();
      expect(settled.metadata?.workspaceRestoreRecoverySettled).toMatchObject({ runId: f.runId, actionId: f.actionId,
        restoredLeasePolicy: "reuse_by_environment" });
      expect(await legacyShutdownWorkspaceResourceProtected(db, settled)).toBe(false);
      expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
        .toMatchObject({ status: "verified" });
    } else {
      expect(settled.metadata?.workspaceRestoreRecovery).toMatchObject({ runId: f.runId });
      expect(await legacyShutdownWorkspaceResourceProtected(db, settled)).toBe(true);
    }
  }, 30_000);

  it.each([1, 2])("recovers saved work after %s warm handoffs that began with another task in the same workspace", async hops => {
    const f = await warmHandoffSource(hops, undefined, { firstOwnerInSharedWorkspace: true });
    const [first] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.priorLeaseId));
    expect(first).toMatchObject({ issueId: f.firstOwnerIssueId, executionWorkspaceId: f.executionWorkspaceId, status: "expired" });
    expect(new Set([f.firstOwnerIssueId, f.issueId, f.executionWorkspaceId]).size).toBe(3);
    await recoverRetainedWorkspace(f.input);
    const state = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(state.failure?.code ?? null).toBeNull();
    expect(state.state).toBe("complete");
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await readFile(path.join(f.host, "after-warm-stop.txt"), "utf8")).toBe("stopped turn work\n");
  }, 30_000);

  it.each(["lease_task", "unshared_workspace", "other_workspace"])(
    "keeps a cross-task predecessor fenced unless its own records prove the shared workspace: %s", async fault => {
      const f = await warmHandoffSource(1, undefined, { firstOwnerInSharedWorkspace: true });
      const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Unrelated task" }).returning();
      if (fault === "lease_task") await db.update(environmentLeases).set({ issueId: other.id }).where(eq(environmentLeases.id, f.priorLeaseId));
      if (fault === "unshared_workspace") await db.update(environmentLeases).set({ executionWorkspaceId: null })
        .where(eq(environmentLeases.id, f.priorLeaseId));
      if (fault === "other_workspace") {
        const [otherWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "isolated_workspace",
          strategyType: "test", name: "Other workspace" }).returning();
        await db.update(environmentLeases).set({ issueId: f.issueId, executionWorkspaceId: otherWorkspace.id })
          .where(eq(environmentLeases.id, f.priorLeaseId));
      }
      expect(await inspectWorkspaceSource(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId }))
        .toMatchObject({ status: "blocked", failureCode: "allocation_ownership_ambiguous" });
      await expect(readFile(path.join(f.host, "after-warm-stop.txt"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("unblocks a pending workspace selection only after a superseded retry's real files are preserved", async () => {
    const f = await seed();
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: null, nativePhase: "retryable_failure",
      startedAt: new Date(1), finishedAt: new Date(2) }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      recoveryState: "resuming_session", nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "ephemeral",
      releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", nativePhase: "committed",
      startedAt: new Date(3), finishedAt: new Date(4), contextSnapshot: { previousRunId: f.runId, taskRetryRequestId: randomUUID() } });
    await db.insert(executionWorkspaces).values({ id: f.issueId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Shared files", mode: "shared_workspace", strategyType: "project_primary", cwd: f.host });
    const actor = { type: "board" as const, source: "local_implicit" as const, isInstanceAdmin: true };
    const workspaces = executionWorkspaceService(db);
    await workspaces.selectTaskWorkspace({ companyId: f.companyId, issueId: f.issueId, actor,
      selection: { kind: "existing", workspaceId: f.issueId }, expectedBindingRevision: 0, requestKey: randomUUID() });
    const admission = { companyId: f.companyId, issueId: f.issueId, actor, runId: randomUUID() };
    await expect(workspaces.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run still owns workspace recovery");
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "recovery", runIds: [f.runId] })).toEqual([]);
    await expect(workspaces.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run still owns workspace recovery");
    const [preservation] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await recoverRetainedWorkspace({ ...f.input, actionId: preservation.id });
    expect(readSystemRecovery((await action(preservation.id)).evidence)?.state).toBe("complete");
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(await workspaces.applyPendingTaskWorkspaceSelection(admission)).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "blocked", assigneeAgentId: source.agentId, executionWorkspaceId: f.issueId,
      workspacePendingSelection: null, executionWorkspaceSettings: { mode: "shared_workspace" } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["HTTP Retry", "manual admission Retry", "new comment", "automatic cleanup"] as const)("repairs a retained failure through %s without admitting work before verified stop", async entry => {
    const f = await seed("native", true, "keep_running");
    const source = await run(f.runId);
    const manual = entry === "manual admission Retry";
    await db.update(heartbeatRuns).set({ resultJson: null,
      errorCode: manual ? "native_restart_recovery_blocked" : "execution_finalization_deadline_exceeded",
      ...(manual ? { processPid: 1386, nativePhase: "terminal_failure" } : {}) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "reuse_by_environment",
      releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    if (manual) {
      const systemRecovery = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId))!,
        new SystemRecoveryFailure("allocation_ownership_ambiguous", "user_action_required"));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", resultId: null,
        failureCode: "native_restart_recovery_blocked", failureDetail: { recoveryMode: "exact_checkpoint_resume", systemRecovery } })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
      await db.update(issueRecoveryActions).set({ status: "active", outcome: "blocked", cause: "native_restart_recovery_blocked",
        fingerprint: `native-restart:${f.runId}`, returnOwnerAgentId: source.agentId, wakePolicy: null, maxAttempts: 3,
        evidence: { runId: f.runId, automaticAdmissionExhausted: true, executorStopEvidence: "unverified",
          providerPid: 1386, checkpointPreserved: true },
        nextAction: "Automatic admission checks exhausted; original executor stop and state remain unverified" })
        .where(eq(issueRecoveryActions.id, f.actionId));
    } else {
      await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
        cause: "execution_finalization_deadline_exceeded", evidence: { runId: f.runId, providerOwnership: "unverified",
          automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    // Leave admission observable without substituting a fake model turn.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    f.runtime.retryPendingSandboxTeardown.mockImplementation(async () => {
      await stopped;
      return { providerLeaseId: f.providerLeaseId, state: "stopped" };
    });
    const errors = vi.fn(), heartbeat = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, heartbeat.resumeRemoteStopComments);
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    try {
      await worker.ready;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      let requestId: string | undefined;
      let commentId: string | undefined;
      if (manual) expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
        .toMatchObject({ state: "failed", canRetry: true, observedRunId: f.runId });
      if (entry === "HTTP Retry" || manual) {
        const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
        const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
        requestId = retry.body.requestId;
        expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202)).body.requestId).toBe(requestId);
      } else if (entry === "new comment") {
        const response = await request(app).post(`/api/issues/${f.issueId}/comments`)
          .send({ body: "Is this fixed?" }).expect(201);
        commentId = response.body.id;
        expect(await successors()).toHaveLength(0);
      } else {
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "board", body: "Is this fixed?" }).returning();
        commentId = comment.id;
        const wake = { source: "automation" as const, triggerDetail: "system" as const,
          reason: "issue_reopened_via_comment", requestedByActorType: "user" as const, requestedByActorId: "board",
          payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
          contextSnapshot: { source: "issue.comment.reopen", issueId: f.issueId, wakeCommentId: comment.id },
        };
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: source.agentId,
          source: wake.source, triggerDetail: wake.triggerDetail, reason: wake.reason,
          requestedByActorType: "user", requestedByActorId: "board", status: "deferred_issue_execution",
          payload: { ...wake.payload, _paperclipWakeContext: { ...wake.contextSnapshot, wakeReason: wake.reason,
            wakeSource: wake.source, wakeTriggerDetail: wake.triggerDetail, wakeCommentIds: [comment.id] } },
        });
        expect(await successors()).toHaveLength(0);
        if (entry === "automatic cleanup") await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
      }
      await expect.poll(() => f.runtime.retryPendingSandboxTeardown.mock.calls.length, { timeout: 20_000 }).toBe(1);
      if (!manual) {
        if (requestId) await heartbeat.resumeTaskRetry(f.companyId, requestId);
        else await heartbeat.resumeQueuedRuns();
      }
      expect(await successors()).toHaveLength(0);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].metadata)
        .not.toHaveProperty("remoteExecutionTermination");
      if (manual) expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
        .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
      await expect(readFile(path.join(f.host, "saved.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      releaseStop();
      await expect.poll(async () => (await successors()).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await successors();
      if (commentId) expect(successor.contextSnapshot?.wakeCommentIds).toContain(commentId);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      if (requestId) expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      else expect(successor.contextSnapshot?.previousRunId).toBe(f.runId);
      await Promise.all([requestId ? heartbeat.resumeTaskRetry(f.companyId, requestId) : heartbeat.resumeQueuedRuns(),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      expect(await successors()).toHaveLength(1);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      expect((await run(f.runId)).status).toBe("failed");
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(reloaded.body.active).toBeNull();
      const records = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(records.some(record => readSystemRecovery(record.evidence)?.state === "complete")).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally { releaseStop(); await coordinator.stop(); await worker.stop(); }
  }, 40_000);

  it("wakes physical preservation from HTTP Retry before passive history without replaying the provider", async () => {
    for (let index = 0; index < 5; index++) {
      const old = await seed();
      await recoverRetainedWorkspace(old.input);
      await db.update(issueRecoveryActions).set({
        id: `00000000-000${index}-4000-8000-${randomUUID().slice(-12)}`,
      }).where(eq(issueRecoveryActions.id, old.actionId));
    }
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const exhausted = failSystemRecovery(readSystemRecovery(before.evidence)!,
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted",
      evidence: { ...before.evidence, systemRecovery: exhausted } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const competingCleanup = await retainedWorkspaceCandidates(db, undefined, false, true);
    expect(competingCleanup).toHaveLength(5);
    expect(competingCleanup.every(row => row.action.id.startsWith("00000000"))).toBe(true);
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const recovered = vi.fn(async () => {});
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, recovered);
    try {
      await worker.ready;
      await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, f.companyId));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
      const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const repeated = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const coalesced = await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ ...body, idempotencyKey: randomUUID() }).expect(202);
      expect(repeated.body.requestId).toBe(retry.body.requestId);
      expect(coalesced.body.requestId).toBe(retry.body.requestId);
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(JSON.stringify(reloaded.body)).toContain('"state":"complete"');
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("hands an exhausted system export repair to the board instead of leaving it system-owned", async () => {
    // Regression: the bounded export budget ran out, but the action stayed active and
    // system-owned for hours. The board saw no owner, and replies started nothing.
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const adopted = readSystemRecovery(before.evidence)!;
    const now = Date.now();
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted",
      nextAction: "Finalization retry budget exhausted. Retry workspace export and merge from the retained sandbox; do not submit another provider turn.",
      evidence: { ...before.evidence, systemRecovery: { ...adopted, revision: adopted.revision + 1, phase: "preserve_files",
        state: "scheduled", attempts: 6, retriesUsed: 5, firstFailureAt: now - 3_600_000, deadlineAt: now - 1_000, nextAttemptAt: null,
        failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "f".repeat(64) } } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    const exhausted = await action(f.actionId);
    expect(readSystemRecovery(exhausted.evidence)?.state).toBe("exhausted");
    expect(exhausted).toMatchObject({ status: "active", ownerType: "board" });
    expect(exhausted.nextAction).toMatch(/stopped after 6 attempts/);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.workspaceRecovery).toMatchObject({ status: "blocked", canRetry: true });
    expect(blocker?.nextAction).toMatch(/Retry to try again/);
    expect(blocker?.nextAction).not.toMatch(/send a (new )?message/i);
    // Nothing physical or provider-facing ran after the budget was spent.
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    // The board's Retry starts one new bounded system generation.
    await requestWorkspaceRecovery({ ...f.input, idempotencyKey: randomUUID(), actorId: "board" });
    const retried = await action(f.actionId);
    expect(retried.ownerType).toBe("system");
    expect(readSystemRecovery(retried.evidence)).toMatchObject({ state: "scheduled", attempts: 0 });
  }, 30_000);

  it("hands a repair that was already exhausted and system-owned to the board without another attempt", async () => {
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const spent = failSystemRecovery({ ...readSystemRecovery(before.evidence)!, attempts: 6, retriesUsed: 5 },
      new SystemRecoveryFailure("export_interrupted", "retry_transient"));
    expect(spent.state).toBe("exhausted");
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", ownerType: "system",
      evidence: { ...before.evidence, systemRecovery: spent,
        workspaceRecovery: { ...readWorkspaceRecovery(before.evidence)!, status: "blocked", attempt: 6, retryable: true } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    const handed = await action(f.actionId);
    expect(handed).toMatchObject({ status: "active", ownerType: "board" });
    expect(readSystemRecovery(handed.evidence)).toEqual(spent);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.nextAction).toMatch(/Retry to try again/);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    // Repeat sweeps are idempotent and still grant no attempt.
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(spent);
  }, 30_000);

  it("reconstructs a resolved files-only preservation obligation at startup without replay", async () => {
    const f = await seed("legacy");
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" };
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
      evidence: { ...before.evidence, automaticRecovery } }).where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, async () => {});
    try {
      await worker.ready;
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect((await action(f.actionId)).evidence.automaticRecovery).toEqual(automaticRecovery);
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("fills a free export slot across the candidate cursor while another export is held and joins both at shutdown", async () => {
    const orderedSeed = async (position: number) => {
      const fixture = await seed();
      const id = `00000002-000${position}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
      return fixture;
    };
    const held = await orderedSeed(2);
    const fixtures = [held];
    const runtimeFor = (runId: string) => fixtures.find(fixture => fixture.runId === runId)!.environmentRuntime;
    const runtime = { ...held.environmentRuntime,
      resumeWorkspaceRecoveryLease: (input: Parameters<typeof held.environmentRuntime.resumeWorkspaceRecoveryLease>[0]) =>
        runtimeFor(input.source.runId).resumeWorkspaceRecoveryLease(input),
      retryPendingSandboxTeardown: (input: Parameters<typeof held.environmentRuntime.retryPendingSandboxTeardown>[0]) =>
        runtimeFor(input.lease.heartbeatRunId!).retryPendingSandboxTeardown(input),
    };
    let active = 0, maximum = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const countExport = (fixture: typeof held, pause = false) => {
      const resume = fixture.runtime.resumeRunLease.getMockImplementation()!;
      fixture.runtime.resumeRunLease.mockImplementation(async input => {
        active += 1; maximum = Math.max(maximum, active);
        try { if (pause) await gate; return await resume(input); } finally { active -= 1; }
      });
    };
    countExport(held, true);
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, runtime, async () => {});
    try {
      await expect.poll(() => held.runtime.resumeRunLease.mock.calls.length, { timeout: 20_000 }).toBe(1);
      // Start the middle candidate only after the highest candidate occupies
      // one slot. The next producer then sorts before that saved cursor.
      const fast = await orderedSeed(1); fixtures.push(fast); countExport(fast);
      await requestTaskRetry({ db, companyId: fast.companyId, issueId: fast.issueId, actorId: "board",
        observedRunId: fast.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(fast.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      const third = await orderedSeed(0); fixtures.push(third); countExport(third);
      await requestTaskRetry({ db, companyId: third.companyId, issueId: third.issueId, actorId: "board",
        observedRunId: third.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(third.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("running");
      expect(maximum).toBeLessThanOrEqual(2);
      expect(await readFile(path.join(third.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, third.companyId))).toHaveLength(1);
      let stopped = false;
      const stopping = Promise.all([coordinator.stop(), worker.stop()]).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping;
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("complete");
      expect(errors).not.toHaveBeenCalled();
    } finally { release(); await coordinator.stop(); await worker.stop(); }
  }, 60_000);

  it("rotates past due sources whose physical locks belong to other workers", async () => {
    const blocked = [await seed(), await seed()], available = await seed();
    for (const [index, fixture] of [...blocked, available].entries()) {
      await adoptSystemRecovery(db, fixture);
      const id = `00000001-000${index}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
    }
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const held = blocked.map(fixture => {
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const lock = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(fixture.companyId, fixture.runId)}, 0))`);
        ready(); await gate;
      });
      return { acquired, lock };
    });
    try {
      await Promise.all(held.map(item => item.acquired));
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(readSystemRecovery((await action(available.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(available.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
    } finally { unlock(); await Promise.all(held.map(item => item.lock)); }
  }, 30_000);

  it("coalesces Retry while preservation owns its physical operation", async () => {
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const resume = f.runtime.resumeRunLease.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementation(async input => { await gate; return resume(input); });
    const preserving = recoverRetainedWorkspace(f.input);
    let requestId: string | null | undefined;
    try {
      await expect.poll(() => f.runtime.resumeRunLease.mock.calls.length).toBe(1);
      const request = { db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        idempotencyKey: randomUUID(), observedRunId: f.runId };
      const first = await requestTaskRetry(request);
      requestId = first.requestId;
      const second = await requestTaskRetry({ ...request, idempotencyKey: randomUUID() });
      expect(second.requestId).toBe(first.requestId);
    } finally { release(); await preserving; }
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.intentId).toBe(requestId);
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("adopts only the exact historical infrastructure notice, preserving prose and user-action notices", async () => {
    const f = await seed("legacy", false);
    const metadata = { version: 1 as const, sourceRunId: f.runId,
      sections: [{ rows: [{ type: "key_value" as const, label: "Recovery action", value: f.actionId }] }] };
    const base = { companyId: f.companyId, issueId: f.issueId, body: "Original technical history",
      authorType: "system" as const, presentation: { kind: "system_notice" as const, tone: "danger" as const,
        title: "Recovery needs attention", detailsDefaultOpen: false }, metadata };
    const comments = await db.insert(issueComments).values([
      base,
      { ...base, authorType: "user", authorUserId: "board" },
      { ...base, metadata: { ...metadata, sourceRunId: randomUUID() } },
      { ...base, metadata: { ...metadata, recoveryResponsibility: "user" as const } },
    ]).returning();
    await adoptSystemRecovery(db, f);
    await adoptSystemRecovery(db, f);
    const rows = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(rows.find(row => row.id === comments[0].id)?.metadata?.recoveryResponsibility).toBe("system");
    for (const original of comments.slice(1)) {
      expect(rows.find(row => row.id === original.id)?.metadata).toEqual(original.metadata);
    }
    expect(rows.every(row => row.body === base.body)).toBe(true);
  });

});
