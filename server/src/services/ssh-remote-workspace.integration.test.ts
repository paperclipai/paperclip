import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { buildSshEnvLabFixtureConfig } from "@paperclipai/adapter-utils/ssh";
import type { EnvironmentLease } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { requireRemoteWorkspaceTarget, hasRemoteRecoveryAttachment } from "./remote-workspace-transport.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import * as recoverySnapshots from "./workspace-recovery-snapshot.js";
import { sshWorkspaceTestsSupported, useSshWorkspaceFixture } from "./__tests__/ssh-remote-workspace-fixture.js";

describe.skipIf(!sshWorkspaceTestsSupported)("Cloud SSH durable workspace with a real SSH server", () => {
  const fixture = useSshWorkspaceFixture("cloud-ssh-workspace-");

  it("keeps Hello World through controller replacement and restores it to a new SSH allocation", async () => {
    const { root, sshd, database } = fixture;
    let { db } = fixture;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SSH workspace test", issuePrefix: "SSH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "SSH Claude", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write Hello World", assigneeAgentId: agentId });
    const config = await buildSshEnvLabFixtureConfig(sshd!);
    const [environment] = await db.insert(environments).values({ driver: "ssh", name: "SSH test", config: {} }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))), provider: "s3" as const };

    async function acquire(id: string, remoteCwd = config.remoteWorkspacePath, providerLeaseId = "ssh-fixture") {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id,
        heartbeatRunId: id, issueId, provider: "ssh", providerLeaseId, status: "active",
        metadata: { driver: "ssh", remoteCwd } }).returning();
      const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId: environment.id,
        leaseId: lease.id, remoteCwd, spec: { ...config, remoteCwd, useHostAuth: false } };
      return { lease: lease as EnvironmentLease, target };
    }

    async function stop(id: string, lease: EnvironmentLease) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, id));
      const [stopped] = await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease, { state: "stopped", providerLeaseId: lease.providerLeaseId }) } })
        .where(eq(environmentLeases.id, lease.id)).returning();
      return stopped as EnvironmentLease;
    }

    const first = await acquire(runId);
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" }, mode: "shared_workspace" });
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId, ...first });
    const firstTarget = { ...first.target, remoteCwd: prepared.remoteRoot, spec: { ...first.target.spec, remoteCwd: prepared.remoteRoot } };
    const result = await requireRemoteWorkspaceTarget(firstTarget).runner!.execute({ command: "node", args: ["-e",
      "require('fs').writeFileSync('hello_world.txt','Hello World\\n')"], cwd: prepared.remoteRoot, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    const stopped = await stop(runId, prepared.lease);
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, async () => {}))
      .rejects.toThrow("binding_missing");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: randomUUID() }, async () => {}))
      .rejects.toThrow("binding_missing");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, ownership =>
      saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId, lease: stopped,
        target: { ...firstTarget, spec: { ...firstTarget.spec, host: "127.0.0.1", port: 1 } }, assertOwned: ownership.assertHeld })))
      .rejects.toThrow();
    const [held] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, reserved.id));
    expect(readRemoteWorkspaceAuthority(held.metadata)).toMatchObject({ writerRunId: runId, dirty: true,
      snapshotId: readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId });
    expect(await readFile(path.join(prepared.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");
    const blockedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: blockedId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
    await expect(reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: blockedId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: prepared.workspace.id, source: { kind: "empty" } })).rejects.toMatchObject({ status: 409 });
    const peerIssueId = randomUUID(), peerRunId = randomUUID();
    await db.insert(issues).values({ id: peerIssueId, companyId, title: "Use the saved shared workspace", assigneeAgentId: agentId,
      executionWorkspaceId: prepared.workspace.id });
    await db.insert(heartbeatRuns).values({ id: peerRunId, companyId, agentId, issueId: peerIssueId, runtimeMode: "legacy", status: "running" });
    const finalized = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, async ownership => {
      await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId,
        lease: stopped, target: firstTarget, assertOwned: ownership.assertHeld });
      const handedOn = await reserveRemoteWorkspace({ db, storage, companyId, issueId: peerIssueId, runId: peerRunId, agentId,
        environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: prepared.workspace.id, source: { kind: "empty" } });
      expect(readRemoteWorkspaceAuthority(handedOn.metadata)).toMatchObject({ epoch: 2, writerRunId: peerRunId });
      await ownership.assertHeld();
      await expect(saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId,
        lease: stopped, target: firstTarget, assertOwned: ownership.assertHeld })).rejects.toThrow("authority_changed");
    });
    expect(finalized.acquired).toBe(true);
    const [finishedOwner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(finishedOwner.runnerProfileJson).not.toHaveProperty("nativeWorkspaceFinalizationOwner");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, async () => {}))
      .rejects.toThrow("binding_missing");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, peerRunId));

    // Replace the controller connection. The saved task and remote files are the authority.
    db = fixture.db = createDb(database.connectionString);
    const [saved] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, reserved.id), eq(executionWorkspaces.companyId, companyId)));
    const snapshotId = readRemoteWorkspaceAuthority(saved.metadata)!.snapshotId;
    expect(snapshotId).toBeTruthy();
    expect(await readFile(path.join(prepared.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");

    const followupId = randomUUID();
    const followup = await acquire(followupId);
    const reused = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: followupId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: saved.id, source: { kind: "empty" } });
    const continued = await prepareRemoteWorkspace({ db, storage, workspace: reused, runId: followupId, ...followup });
    expect(continued.remoteRoot).toBe(prepared.remoteRoot);
    await saveRemoteWorkspace({ db, storage, workspace: continued.workspace, runId: followupId,
      lease: await stop(followupId, continued.lease), target: followup.target, assertOwned: async () => {} });

    const [latest] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, saved.id));
    const restoredBase = path.join(root, "replacement-remote");
    await mkdir(restoredBase);
    const restoreId = randomUUID(), replacement = await acquire(restoreId, restoredBase, "replacement-ssh-allocation");
    const restoring = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: restoreId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: latest.id, source: { kind: "empty" } });
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: restoring, runId: restoreId, ...replacement });
    expect(restored.remoteRoot).not.toBe(prepared.remoteRoot);
    expect(await readFile(path.join(restored.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");
  }, 60_000);

  it("prepares a verified recovered copy on SSH without directory-sync support", async () => {
    const { root, sshd, db } = fixture;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sourceId = randomUUID(), operationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SSH recovery test", issuePrefix: "REC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery worker", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover earlier files", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
    const [environment] = await db.insert(environments).values({ driver: "ssh", name: "SSH recovery", config: {} }).returning();
    const config = await buildSshEnvLabFixtureConfig(sshd!);
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id,
      heartbeatRunId: runId, issueId, provider: "ssh", providerLeaseId: "ssh-recovery", status: "active" }).returning();
    const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId: environment.id,
      leaseId: lease.id, remoteCwd: config.remoteWorkspacePath, spec: { ...config, remoteCwd: config.remoteWorkspacePath } };
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "recovery-objects"))), provider: "s3" as const };
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null,
      source: { kind: "empty" }, recoverySourceRunIds: [sourceId] });
    const provenance = JSON.stringify({ operationId, sourceRunId: sourceId });
    // Start at the verified extraction boundary; source authorization and snapshot verification keep their existing owner.
    const extract = vi.spyOn(recoverySnapshots, "attachPreservedWorkspaceSnapshots").mockImplementationOnce(async input => {
      expect(input.sourceRunIds).toContain(sourceId);
      const recovered = path.join(input.cwd, "recovered", operationId);
      await mkdir(path.join(recovered, "files", "nested"), { recursive: true });
      await writeFile(path.join(recovered, "files", "nested", "preserved.txt"), "Earlier work\n");
      await writeFile(path.join(recovered, "provenance.json"), provenance);
      return [{ operationId, sourceRunId: sourceId, path: recovered }];
    });
    try {
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId, lease: lease as EnvironmentLease, target });
      const recovered = path.join(prepared.remoteRoot, ".paperclip-recovered", operationId);
      expect(await readFile(path.join(recovered, "files", "nested", "preserved.txt"), "utf8")).toBe("Earlier work\n");
      expect(await readFile(path.join(recovered, "provenance.json"), "utf8")).toBe(provenance);
      expect(await hasRemoteRecoveryAttachment({ target: requireRemoteWorkspaceTarget(target), remoteCwd: prepared.remoteRoot, operationId, provenance })).toBe(true);
      await writeFile(path.join(recovered, "files", "nested", "preserved.txt"), "A later edit\n");
      await prepareRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId, lease: prepared.lease, target });
      expect(await readFile(path.join(recovered, "files", "nested", "preserved.txt"), "utf8")).toBe("A later edit\n");
    } finally { extract.mockRestore(); }
  }, 60_000);
});
