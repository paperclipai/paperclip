import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  builtInManagedResources,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  environmentCustomImageSetupSessions,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("environmentService leases", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof environmentService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = environmentService(db);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(environmentCustomImageSetupSessions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(environments);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Lease Fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { companyId, agentId, environmentId, runId };
  }

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("acquires and releases a lease for a run", async () => {
    const { companyId, environmentId, runId } = await seedEnvironment();

    const lease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      metadata: { driver: "local" },
    });

    expect(lease.status).toBe("active");
    expect(lease.heartbeatRunId).toBe(runId);

    const released = await svc.releaseLease(lease.id);

    expect(released?.status).toBe("released");
    expect(released?.releasedAt).not.toBeNull();
  });

  it("releases all active leases for a run without touching unrelated rows", async () => {
    const { companyId, agentId, environmentId, runId } = await seedEnvironment();
    const otherRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const targetLease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
    });
    const otherLease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: otherRunId,
    });

    const released = await svc.releaseLeasesForRun(runId);

    expect(released.map((lease) => lease.id)).toEqual([targetLease.id]);

    const stillActive = await svc.listLeases(environmentId, { status: "active" });
    expect(stillActive.map((lease) => lease.id)).toEqual([otherLease.id]);
  });

  it("aggregates delete blast radius counts into static and active tiers", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const environmentId = randomUUID();
    const otherEnvironmentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const secretId = randomUUID();
    const otherSecretId = randomUUID();
    const now = new Date();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Acme",
        status: "active",
        issuePrefix: "ACM",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        status: "active",
        issuePrefix: "OTH",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(environments).values([
      {
        id: environmentId,
        name: "Shared SSH",
        driver: "ssh",
        status: "active",
        config: {
          host: "fixture.example.test",
          port: 22,
          username: "fixture",
          remoteWorkspacePath: "/srv/paperclip",
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherEnvironmentId,
        name: "Other SSH",
        driver: "ssh",
        status: "active",
        config: {
          host: "other.example.test",
          port: 22,
          username: "fixture",
          remoteWorkspacePath: "/srv/paperclip",
        },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      defaultEnvironmentId: environmentId,
      general: {},
      experimental: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values([
      {
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: environmentId,
        permissions: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        companyId,
        name: "OtherCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: otherEnvironmentId,
        permissions: {},
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        environmentId,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Workspace",
      status: "active",
      providerType: "git_worktree",
      metadata: {
        config: {
          environmentId,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companySecrets).values([
      {
        id: secretId,
        companyId,
        key: "env-secret",
        name: "Env Secret",
        provider: "local_encrypted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherSecretId,
        companyId: otherCompanyId,
        key: "other-env-secret",
        name: "Other Env Secret",
        provider: "local_encrypted",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companySecretBindings).values([
      {
        companyId,
        secretId,
        targetType: "environment",
        targetId: environmentId,
        configPath: "env.OPENAI_API_KEY",
        createdAt: now,
        updatedAt: now,
      },
      {
        companyId: otherCompanyId,
        secretId: otherSecretId,
        targetType: "environment",
        targetId: environmentId,
        configPath: "env.ANTHROPIC_API_KEY",
        createdAt: now,
        updatedAt: now,
      },
      {
        companyId,
        secretId,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.OPENAI_API_KEY",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await svc.acquireLease({
      companyId,
      environmentId,
    });
    const releasedLease = await svc.acquireLease({
      companyId,
      environmentId,
    });
    await svc.releaseLease(releasedLease.id);
    await db.insert(environmentCustomImageSetupSessions).values([
      {
        environmentId,
        provider: "fake-plugin",
        status: "waiting_for_user",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const impact = await svc.getDeleteBlastRadius(environmentId);

    expect(impact).toEqual({
      environmentId,
      canDelete: false,
      deleteBlockedReasons: ["instance_default"],
      pendingCleanupLeaseCount: 0,
      reusableSandboxLeaseCount: 0,
      reusableSandboxLeaseHolders: [],
      staticReferences: {
        isManagedLocal: false,
        isInstanceDefault: true,
        agentDefaultCount: 1,
        executionWorkspaceSelectionCount: 1,
        issueSelectionCount: 1,
        projectSelectionCount: 1,
        secretBindingCount: 2,
      },
      activeRuntimeUse: {
        activeLeaseCount: 1,
        activeCustomImageSetupSessionCount: 1,
        hasActiveRuntimeUse: true,
      },
    });
  });

  it("guards removeIfDeletable with atomic local/default predicates", async () => {
    const localEnvId = randomUUID();
    const defaultEnvId = randomUUID();
    const deletableEnvId = randomUUID();
    const now = new Date();

    await db.insert(environments).values([
      {
        id: localEnvId,
        name: "Local Guard",
        driver: "local",
        status: "active",
        config: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: defaultEnvId,
        name: "Default SSH Guard",
        driver: "ssh",
        status: "active",
        config: {
          host: "default.example.test",
          port: 22,
          username: "fixture",
          remoteWorkspacePath: "/srv/paperclip",
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: deletableEnvId,
        name: "Deletable SSH Guard",
        driver: "ssh",
        status: "active",
        config: {
          host: "delete.example.test",
          port: 22,
          username: "fixture",
          remoteWorkspacePath: "/srv/paperclip",
        },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      defaultEnvironmentId: defaultEnvId,
      general: {},
      experimental: {},
      createdAt: now,
      updatedAt: now,
    });

    const removedLocal = await svc.removeIfDeletable(localEnvId);
    const localRows = await db.select().from(environments).where(eq(environments.id, localEnvId));

    expect(removedLocal).toBeNull();
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.driver).toBe("local");

    const removedDefault = await svc.removeIfDeletable(defaultEnvId);
    const defaultRows = await db.select().from(environments).where(eq(environments.id, defaultEnvId));

    expect(removedDefault).toBeNull();
    expect(defaultRows).toHaveLength(1);

    const removedDeletable = await svc.removeIfDeletable(deletableEnvId);
    const deletedRows = await db.select().from(environments).where(eq(environments.id, deletableEnvId));

    expect(removedDeletable?.id).toBe(deletableEnvId);
    expect(deletedRows).toHaveLength(0);
  });

  it("blocks delete while a pending_cleanup lease still holds the sandbox reference", async () => {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Pending Cleanup Guard",
      driver: "ssh",
      status: "active",
      config: {
        host: "pending.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: now,
      updatedAt: now,
    });
    await svc.insertPendingCleanupLease({
      companyId,
      environmentId,
      provider: "fake-plugin",
      providerLeaseId: "sandbox-1",
      failureReason: "teardown_failed",
    });

    const impact = await svc.getDeleteBlastRadius(environmentId);
    expect(impact?.canDelete).toBe(false);
    expect(impact?.deleteBlockedReasons).toContain("pending_sandbox_cleanup");
    expect(impact?.pendingCleanupLeaseCount).toBe(1);
    expect(await svc.hasUnresolvedPendingCleanupLeases(environmentId)).toBe(true);

    const removed = await svc.removeIfDeletable(environmentId);
    const rows = await db.select().from(environments).where(eq(environments.id, environmentId));
    expect(removed).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("atomically blocks delete while a reusable sandbox lease is still live", async () => {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Reusable Sandbox Guard",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    const projectId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project",
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier: "ACME-7",
      title: "Reusable lease holder",
      status: "todo",
      priority: "medium",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "ACME-7-reusable-lease-holder",
      status: "active",
      providerType: "git_worktree",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    const lease = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId: workspaceId,
      issueId,
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: "sandbox-reusable-1",
      metadata: {
        driver: "sandbox",
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const activeImpact = await svc.getDeleteBlastRadius(environmentId);
    expect(activeImpact?.canDelete).toBe(false);
    expect(activeImpact?.deleteBlockedReasons).toContain("reusable_sandbox_lease");
    expect(activeImpact?.reusableSandboxLeaseCount).toBe(1);
    expect(activeImpact?.reusableSandboxLeaseHolders).toEqual([
      {
        leaseId: lease.id,
        executionWorkspaceId: workspaceId,
        executionWorkspaceName: "ACME-7-reusable-lease-holder",
        issueId,
        issueIdentifier: "ACME-7",
        issueTitle: "Reusable lease holder",
      },
    ]);
    expect(await svc.removeIfDeletable(environmentId)).toBeNull();

    // A released reusable lease still owns a provider sandbox that may be
    // resumed, so it must remain protected until scoped cleanup destroys it.
    await svc.releaseLease(lease.id, "released");
    const releasedImpact = await svc.getDeleteBlastRadius(environmentId);
    expect(releasedImpact?.canDelete).toBe(false);
    expect(releasedImpact?.reusableSandboxLeaseCount).toBe(1);
    expect(await svc.removeIfDeletable(environmentId)).toBeNull();

    const rows = await db.select().from(environments).where(eq(environments.id, environmentId));
    expect(rows).toHaveLength(1);
    const storedLease = await svc.getLeaseById(lease.id);
    expect(storedLease?.environmentId).toBe(environmentId);
  });

  it("allows delete with an active ephemeral lease", async () => {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Ephemeral Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" },
      createdAt: now,
      updatedAt: now,
    });
    await svc.acquireLease({
      companyId,
      environmentId,
      leasePolicy: "ephemeral",
      provider: "fake",
      providerLeaseId: "sandbox-ephemeral-1",
    });

    const impact = await svc.getDeleteBlastRadius(environmentId);
    expect(impact?.activeRuntimeUse.activeLeaseCount).toBe(1);
    expect(impact?.reusableSandboxLeaseCount).toBe(0);
    expect(impact?.canDelete).toBe(true);
    expect((await svc.removeIfDeletable(environmentId))?.id).toBe(environmentId);
  });

  it("allows delete once the pending_cleanup lease resolves", async () => {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Resolved Cleanup Guard",
      driver: "ssh",
      status: "active",
      config: {
        host: "resolved.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: now,
      updatedAt: now,
    });
    const lease = await svc.insertPendingCleanupLease({
      companyId,
      environmentId,
      provider: "fake-plugin",
      providerLeaseId: "sandbox-1",
      failureReason: "teardown_failed",
    });
    // The sweep marks a cleaned orphan `expired`, so it leaves the terminal
    // `pending_cleanup` state and no longer blocks the delete.
    await svc.releaseLease(lease.id, "expired", { cleanupStatus: "success" });

    const impact = await svc.getDeleteBlastRadius(environmentId);
    expect(impact?.canDelete).toBe(true);
    expect(impact?.pendingCleanupLeaseCount).toBe(0);
    expect(impact?.reusableSandboxLeaseCount).toBe(0);
    expect(await svc.hasUnresolvedPendingCleanupLeases(environmentId)).toBe(false);

    const removed = await svc.removeIfDeletable(environmentId);
    const rows = await db.select().from(environments).where(eq(environments.id, environmentId));
    expect(removed?.id).toBe(environmentId);
    expect(rows).toHaveLength(0);
  });

  it("records the orphan with a null reference when a delete already removed the environment", async () => {
    // A delete wins the untracked window before the orphan record lands. The
    // record must still persist, so the sweep keeps a durable handle to the
    // remote sandbox.
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Deleted Before Record",
      driver: "ssh",
      status: "active",
      config: {
        host: "deleted.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: now,
      updatedAt: now,
    });

    const removed = await svc.removeIfDeletable(environmentId);
    expect(removed?.id).toBe(environmentId);

    // The foreign key does not reject the insert. The insert reads the absent
    // environment and stores a null reference with the immutable provider
    // metadata, so the teardown still runs later.
    const lease = await svc.insertPendingCleanupLease({
      companyId,
      environmentId,
      provider: "fake-plugin",
      providerLeaseId: "sandbox-orphan-1",
      metadata: { provider: "fake-plugin", config: { provider: "fake-plugin" } },
      failureReason: "acquire_rejected_teardown_failed",
    });

    expect(lease.environmentId).toBeNull();
    expect(lease.status).toBe("pending_cleanup");
    expect(lease.provider).toBe("fake-plugin");
    expect(lease.providerLeaseId).toBe("sandbox-orphan-1");

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environmentId).toBeNull();
    expect(rows[0]?.metadata).toMatchObject({ provider: "fake-plugin" });
  });

  it("keeps the orphan when an environment delete and the orphan record race", async () => {
    // Race the delete against the orphan record. The record locks the
    // environment row `for update`, and the delete refuses while a
    // `pending_cleanup` lease exists, so the two writes serialize into one of
    // two safe outcomes. The orphan row persists in both.
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Delete Vs Record Race",
      driver: "ssh",
      status: "active",
      config: {
        host: "race.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: now,
      updatedAt: now,
    });

    const [removed, lease] = await Promise.all([
      svc.removeIfDeletable(environmentId),
      svc.insertPendingCleanupLease({
        companyId,
        environmentId,
        provider: "fake-plugin",
        providerLeaseId: "sandbox-orphan-2",
        metadata: { provider: "fake-plugin", config: { provider: "fake-plugin" } },
        failureReason: "acquire_rejected_teardown_failed",
      }),
    ]);

    // The orphan row always persists, so no ordering strands the sandbox.
    const leaseRows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.status, "pending_cleanup"));
    expect(leaseRows).toHaveLength(1);
    expect(leaseRows[0]?.id).toBe(lease.id);
    expect(leaseRows[0]?.provider).toBe("fake-plugin");

    const environmentRows = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId));
    if (removed) {
      // The delete won. The environment is gone, and the orphan keeps a null
      // reference with its immutable provider metadata.
      expect(environmentRows).toHaveLength(0);
      expect(leaseRows[0]?.environmentId).toBeNull();
    } else {
      // The record won. The orphan keeps the environment reference, and the
      // delete refused because the `pending_cleanup` lease now exists.
      expect(environmentRows).toHaveLength(1);
      expect(leaseRows[0]?.environmentId).toBe(environmentId);
    }
  });

  it("keeps the recorded provider immutable when a provider change and the orphan record race", async () => {
    // Race a provider change against the orphan record for the original
    // provider. The recorded lease must keep the original provider and its
    // immutable teardown metadata, so a later retry targets the original
    // provider, never the reconfigured one.
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Provider Change Vs Record Race",
      driver: "sandbox",
      status: "active",
      config: { provider: "provider-a" },
      createdAt: now,
      updatedAt: now,
    });

    const [, lease] = await Promise.all([
      svc.update(environmentId, {
        driver: "sandbox",
        config: { provider: "provider-b" },
      }),
      svc.insertPendingCleanupLease({
        companyId,
        environmentId,
        provider: "provider-a",
        providerLeaseId: "sandbox-orphan-3",
        metadata: { provider: "provider-a", config: { provider: "provider-a" } },
        failureReason: "acquire_rejected_teardown_failed",
      }),
    ]);

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(rows[0]?.provider).toBe("provider-a");
    expect(rows[0]?.metadata).toMatchObject({ provider: "provider-a" });

    // The environment now points at the reconfigured provider, but the recorded
    // teardown context stays independent of it.
    const environmentRows = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId));
    expect((environmentRows[0]?.config as { provider?: string } | null)?.provider).toBe("provider-b");
  });

  it("creates and then reuses the default local environment for a company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await svc.ensureLocalEnvironment(companyId);
    const reused = await svc.ensureLocalEnvironment(companyId);

    expect(created.driver).toBe("local");
    expect(reused.id).toBe(created.id);

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Local");
  });

  it("leaves an existing default local environment untouched", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const archivedAt = new Date("2025-01-01T00:00:00.000Z");
    const [existing] = await db
      .insert(environments)
      .values({
        name: "Archived Local",
        description: "Operator-managed local environment",
        driver: "local",
        status: "archived",
        config: { shell: "zsh" },
        metadata: { owner: "operator" },
        createdAt: archivedAt,
        updatedAt: archivedAt,
      })
      .returning();

    const ensured = await svc.ensureLocalEnvironment(companyId);

    expect(ensured.id).toBe(existing?.id);
    expect(ensured.name).toBe("Archived Local");
    expect(ensured.status).toBe("archived");
    expect(ensured.metadata).toEqual({ owner: "operator" });

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt.toISOString()).toBe(archivedAt.toISOString());
  });

  it("adopts a pre-existing local row on a cloud-managed instance by stamping the platform marker", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [existing] = await db
      .insert(environments)
      .values({
        name: "Tenant Local",
        driver: "local",
        status: "active",
        config: { shell: "zsh" },
        metadata: { owner: "operator" },
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      })
      .returning();

    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
    try {
      const adopted = await svc.ensureLocalEnvironment(companyId);

      expect(adopted.id).toBe(existing?.id);
      expect(adopted.name).toBe("Tenant Local");
      expect(adopted.metadata).toEqual({ owner: "operator", managedByPaperclip: true });

      // Re-ensuring an already-adopted row must not rewrite it.
      const adoptedRow = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0]);
      const reused = await svc.ensureLocalEnvironment(companyId);
      expect(reused.metadata).toEqual({ owner: "operator", managedByPaperclip: true });
      const reusedRow = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0]);
      expect(reusedRow?.updatedAt.toISOString()).toBe(adoptedRow?.updatedAt.toISOString());
    } finally {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    }
  });

  it("does not stamp the platform marker on self-hosted instances (regression)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      name: "Tenant Local",
      driver: "local",
      status: "active",
      config: {},
      metadata: { owner: "operator" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ensured = await svc.ensureLocalEnvironment(companyId);

    expect(ensured.metadata).toEqual({ owner: "operator" });
  });

  it("deduplicates concurrent default local environment creation", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.ensureLocalEnvironment(companyId)),
    );

    expect(new Set(results.map((environment) => environment.id)).size).toBe(1);

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driver).toBe("local");
    expect(rows[0]?.status).toBe("active");
  });

  it("ensures, refreshes, and finds a managed Kubernetes sandbox environment", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No managed k8s env yet.
    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();

    const created = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com"],
    });

    expect(created.driver).toBe("sandbox");
    expect(created.config.provider).toBe("kubernetes");
    expect(created.config.backend).toBe("job");
    expect(created.config.runtimeClassName).toBe("gvisor");
    expect(created.metadata?.managedKubernetesSandbox).toBe(true);

    // Idempotent: second call refreshes config in place, no new row.
    const refreshed = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.config.egressAllowFqdns).toEqual([
      "api.anthropic.com",
      "api.openai.com",
    ]);

    const found = await svc.findKubernetesEnvironment(companyId);
    expect(found?.id).toBe(created.id);

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows.filter((row) => row.driver === "sandbox")).toHaveLength(1);
  });

  it("deduplicates concurrent managed Kubernetes environment creation", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No partial unique index covers sandbox drivers yet, so dedup is
    // post-insert convergence (prefer the oldest row, delete the loser).
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.ensureKubernetesEnvironment(companyId, { inCluster: true, backend: "job" }),
      ),
    );

    expect(new Set(results.map((environment) => environment.id)).size).toBe(1);

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.metadata as Record<string, unknown>)?.managedKubernetesSandbox).toBe(true);
  });

  it("ensures and refreshes a managed sandbox environment for an arbitrary provider", async () => {
    const companyId = await seedCompany();
    const createdResult = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      description: "Managed Daytona sandbox environment.",
      provider: "daytona",
      config: { target: "us" },
    });
    const created = createdResult.environment;
    expect(createdResult).toMatchObject({ action: "added", stockStatus: "missing" });

    expect(created.driver).toBe("sandbox");
    expect(created.name).toBe("Daytona");
    expect(created.config.provider).toBe("daytona");
    expect(created.config.target).toBe("us");
    expect(created.metadata?.managedByPaperclip).toBe(true);
    expect(created.metadata?.managedSandboxProvider).toBe("daytona");

    // A stock update advances config and name in place, and a description
    // omitted from the spec is cleared rather than pinned forever.
    const refreshedResult = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona (EU)",
      provider: "daytona",
      config: { target: "eu" },
    });
    const refreshed = refreshedResult.environment;
    expect(refreshedResult).toMatchObject({
      action: "updated",
      stockStatus: "stock_update_available",
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.name).toBe("Daytona (EU)");
    expect(refreshed.config.target).toBe("eu");
    expect(refreshed.description).toBeNull();

    const [binding] = await db
      .select()
      .from(builtInManagedResources)
      .where(and(
        eq(builtInManagedResources.companyId, companyId),
        eq(builtInManagedResources.resourceKind, "environment"),
      ));
    expect(binding).toMatchObject({
      resourceId: created.id,
      stockHash: refreshedResult.stockHash,
    });
    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((entry) => entry.action)).toEqual([
      "environment.managed_stock_added",
      "environment.managed_stock_updated",
    ]);

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(1);
  });

  it("lists the companies that own a managed sandbox environment", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A", status: "active", issuePrefix: "CA", createdAt: new Date(), updatedAt: new Date() },
      { id: companyB, name: "Company B", status: "active", issuePrefix: "CB", createdAt: new Date(), updatedAt: new Date() },
    ]);
    // Two companies provision the same managed sandbox slot, so both bind to the
    // one environment row.
    const created = await svc.ensureManagedSandboxEnvironment({
      companyId: companyA,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    });
    const environmentId = created.environment.id;
    await svc.ensureManagedSandboxEnvironment({
      companyId: companyB,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    });

    const owners = await svc.listBoundCompanyIds(environmentId);
    expect(owners.slice().sort()).toEqual([companyA, companyB].sort());

    // An operator-created environment has no managed binding, so it lists no
    // owner and stays instance-global.
    const unboundId = randomUUID();
    await db.insert(environments).values({
      id: unboundId,
      name: "Operator sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await svc.listBoundCompanyIds(unboundId)).toEqual([]);
  });

  it("preserves tenant env vars across managed sandbox boot reconciles", async () => {
    // The cloud contract lets tenants add env vars — and only env vars —
    // to the managed sandbox environment. The provisioner reconciles
    // name/config/metadata/status on every boot; it must never touch the
    // tenant's env vars, or a redeploy would silently wipe them.
    const companyId = await seedCompany();
    const created = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    })).environment;
    expect(created.envVars).toEqual({});

    await svc.update(created.id, { envVars: { MY_TOOL_TOKEN_REF: "binding-ref", PLAIN: "value" } });

    const reconciled = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona (EU)",
      provider: "daytona",
      config: { target: "eu" },
    })).environment;
    expect(reconciled.id).toBe(created.id);
    expect(reconciled.config.target).toBe("eu");
    expect(reconciled.envVars).toEqual({ MY_TOOL_TOKEN_REF: "binding-ref", PLAIN: "value" });
  });

  it("treats stock_current as an environment-row no-op and preserves user-owned fields", async () => {
    const companyId = await seedCompany();
    const created = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      description: "Managed stock",
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "v1",
    });
    const operatorUpdatedAt = new Date("2026-08-06T12:00:00.000Z");
    await db
      .update(environments)
      .set({
        envVars: { OPERATOR_FLAG: "kept" },
        metadata: {
          ...created.environment.metadata,
          operatorNote: "keep me",
        },
        updatedAt: operatorUpdatedAt,
      })
      .where(eq(environments.id, created.environment.id));
    const [bindingBefore] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    const activityBefore = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    const reconciled = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      description: "Managed stock",
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "v1",
    });
    const [bindingAfter] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));

    expect(reconciled).toMatchObject({
      action: "unchanged",
      stockStatus: "stock_current",
      updateAvailable: false,
    });
    expect(reconciled.environment.updatedAt).toEqual(operatorUpdatedAt);
    expect(reconciled.environment.envVars).toEqual({ OPERATOR_FLAG: "kept" });
    expect(reconciled.environment.metadata?.operatorNote).toBe("keep me");
    expect(bindingAfter?.updatedAt).toEqual(bindingBefore?.updatedAt);
    const activityAfter = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(activityAfter).toHaveLength(activityBefore.length);
  });

  it("classifies operator drift, preserves the row, and exposes the pending stock update", async () => {
    const companyId = await seedCompany();
    const created = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      description: "Managed stock",
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "v1",
    });
    const [bindingBefore] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    const operatorUpdatedAt = new Date("2026-08-06T12:01:00.000Z");
    await db
      .update(environments)
      .set({
        description: "Operator description",
        config: { provider: "daytona", target: "operator" },
        updatedAt: operatorUpdatedAt,
      })
      .where(eq(environments.id, created.environment.id));

    const reconciled = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona v2",
      description: "Managed stock v2",
      provider: "daytona",
      config: { target: "eu" },
      stockVersion: "v2",
    });
    const [bindingAfter] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));

    expect(reconciled).toMatchObject({
      action: "skipped",
      stockStatus: "operator_modified",
      updateAvailable: true,
    });
    expect(reconciled.environment).toMatchObject({
      name: "Daytona",
      description: "Operator description",
      config: { provider: "daytona", target: "operator" },
      updatedAt: operatorUpdatedAt,
    });
    expect(bindingAfter?.stockHash).toBe(bindingBefore?.stockHash);
    expect(bindingAfter?.stockVersion).toBe("v1");
    expect(reconciled.stockHash).not.toBe(bindingAfter?.stockHash);
    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(activityLog.createdAt);
    expect(activity.at(-1)?.action).toBe("environment.managed_stock_skipped");
  });

  it("adopts the managed slot on a provider switch and drops the stale kubernetes marker", async () => {
    const companyId = await seedCompany();
    const kubernetes = await svc.ensureKubernetesEnvironment(companyId, { inCluster: true, backend: "job" });
    expect(kubernetes.metadata?.managedKubernetesSandbox).toBe(true);

    const daytona = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    })).environment;

    expect(daytona.id).toBe(kubernetes.id);
    expect(daytona.name).toBe("Daytona");
    expect(daytona.config.provider).toBe("daytona");
    expect(daytona.config.backend).toBeUndefined();
    expect(daytona.metadata?.managedSandboxProvider).toBe("daytona");
    expect(daytona.metadata?.managedKubernetesSandbox).toBeUndefined();
    expect(await svc.findKubernetesEnvironment()).toBeNull();

    // And back: the kubernetes wrapper re-adopts the same row.
    const restored = await svc.ensureKubernetesEnvironment(companyId, { inCluster: true, backend: "job" });
    expect(restored.id).toBe(kubernetes.id);
    expect(restored.metadata?.managedKubernetesSandbox).toBe(true);
  });

  it("archives the managed sandbox row only for its own provider and reactivates on ensure", async () => {
    const companyId = await seedCompany();
    // Nothing provisioned yet: archiving is a no-op.
    expect(await svc.archiveManagedSandboxEnvironment({ provider: "daytona" })).toBeNull();

    const created = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    })).environment;
    expect(created.status).toBe("active");

    // Another provider's unavailability leaves this provider's row alone.
    expect(await svc.archiveManagedSandboxEnvironment({ provider: "kubernetes" })).toBeNull();

    const archived = await svc.archiveManagedSandboxEnvironment({ provider: "daytona" });
    expect(archived?.id).toBe(created.id);
    expect(archived?.status).toBe("archived");
    const archiveActivity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityId, created.id),
      ))
      .orderBy(activityLog.createdAt);
    expect(archiveActivity.at(-1)?.action).toBe(
      "environment.managed_provider_unavailable_archived",
    );

    // Already archived: a repeat call is a no-op.
    expect(await svc.archiveManagedSandboxEnvironment({ provider: "daytona" })).toBeNull();

    // The next healthy boot's ensure re-activates the same row.
    const restored = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    })).environment;
    expect(restored.id).toBe(created.id);
    expect(restored.status).toBe("active");
  });

  it("reactivates a reconciler-archived row without replacing operator drift", async () => {
    const companyId = await seedCompany();
    const created = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      description: "Managed stock",
      provider: "daytona",
      config: { target: "us" },
      stockVersion: "v1",
    });
    await db
      .update(environments)
      .set({
        description: "Operator description",
        config: { provider: "daytona", target: "operator" },
      })
      .where(eq(environments.id, created.environment.id));

    expect((await svc.archiveManagedSandboxEnvironment({ provider: "daytona" }))?.status)
      .toBe("archived");
    const [archivedBinding] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    expect(archivedBinding?.defaultsJson).toMatchObject({
      description: "Managed stock",
      status: "archived",
    });

    const restored = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona v2",
      description: "Managed stock v2",
      provider: "daytona",
      config: { target: "eu" },
      stockVersion: "v2",
    });
    expect(restored).toMatchObject({
      action: "skipped",
      stockStatus: "operator_modified",
      updateAvailable: true,
      environment: {
        status: "active",
        name: "Daytona",
        description: "Operator description",
        config: { provider: "daytona", target: "operator" },
      },
    });
    const [reactivatedBinding] = await db
      .select()
      .from(builtInManagedResources)
      .where(eq(builtInManagedResources.companyId, companyId));
    expect(reactivatedBinding?.defaultsJson).toMatchObject({
      description: "Managed stock",
      status: "active",
    });
    expect(reactivatedBinding?.stockVersion).toBe("v1");
    expect(restored.stockHash).not.toBe(reactivatedBinding?.stockHash);
  });

  it("preserves an operator archive decision made after provider archival", async () => {
    const companyId = await seedCompany();
    const created = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    });
    expect((await svc.archiveManagedSandboxEnvironment({ provider: "daytona" }))?.status)
      .toBe("archived");
    expect((await svc.update(created.environment.id, { status: "archived" }))?.status)
      .toBe("archived");

    const reconciled = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    });
    expect(reconciled).toMatchObject({
      action: "skipped",
      stockStatus: "operator_modified",
      updateAvailable: true,
      environment: { status: "archived" },
    });
  });

  it("preserves an existing unmanaged sandbox row holding the desired name", async () => {
    const companyId = await seedCompany();
    const handMade = await svc.create({
      name: "Daytona",
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona", target: "us" },
    });
    expect(handMade.metadata?.managedByPaperclip).toBeUndefined();

    const reconciliation = await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "eu" },
    });
    expect(reconciliation).toMatchObject({
      action: "skipped",
      stockStatus: "operator_modified",
      updateAvailable: true,
    });
    expect(reconciliation.environment.id).toBe(handMade.id);
    expect(reconciliation.environment.config.target).toBe("us");
    expect(reconciliation.environment.metadata?.managedByPaperclip).toBeUndefined();

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(1);
  });

  it("keeps the current name when the desired name belongs to another row", async () => {
    const companyId = await seedCompany();
    await svc.create({
      name: "Daytona",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
    });
    const kubernetes = await svc.ensureKubernetesEnvironment(companyId, { inCluster: true });

    // The managed slot is adopted, but the rename would collide with the ssh
    // row on environments_name_idx; the ensure keeps the existing name.
    const adopted = (await svc.ensureManagedSandboxEnvironment({
      companyId,
      name: "Daytona",
      provider: "daytona",
      config: { target: "us" },
    })).environment;
    expect(adopted.id).toBe(kubernetes.id);
    expect(adopted.name).toBe(kubernetes.name);
    expect(adopted.config.provider).toBe("daytona");
  });

  it("returns a conflict when creating a second environment with the same name", async () => {
    await seedEnvironment();

    await svc.create({
      name: "Shared Fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
    });

    await expect(svc.create({
      name: "Shared Fixture",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    })).rejects.toMatchObject({
      status: 409,
      message: 'An environment named "Shared Fixture" already exists for this instance.',
    });
  });

  it("returns a conflict when renaming an environment to an existing name", async () => {
    const { environmentId } = await seedEnvironment();
    const otherEnvironmentId = randomUUID();
    const now = new Date();

    await db.insert(environments).values({
      id: otherEnvironmentId,
      name: "Other Fixture",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
      createdAt: now,
      updatedAt: now,
    });

    await expect(svc.update(otherEnvironmentId, {
      name: "Lease Fixture",
    })).rejects.toMatchObject({
      status: 409,
      message: 'An environment named "Lease Fixture" already exists for this instance.',
    });

    const original = await svc.getById(environmentId);
    expect(original?.name).toBe("Lease Fixture");
  });

  it("rejects a second managed-sandbox row for the same company at the DB level", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const now = new Date();
    await db.insert(environments).values({
      name: "First",
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
      createdAt: now,
      updatedAt: now,
    });

    // Partial unique index environments_company_managed_sandbox_idx rejects a
    // second row matching driver='sandbox' AND managedByPaperclip=true for the
    // same company. This is the DB-level invariant that replaced the previous
    // application-side post-insert convergence loop.
    const secondInsert = db.insert(environments).values({
      name: "Second",
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
      createdAt: new Date(now.getTime() + 1),
      updatedAt: new Date(now.getTime() + 1),
    });
    let raisedConstraint: string | null = null;
    try {
      await secondInsert;
    } catch (error) {
      raisedConstraint =
        (error as { constraint_name?: string; cause?: { constraint_name?: string } })
          ?.constraint_name ??
        (error as { cause?: { constraint_name?: string } })?.cause?.constraint_name ??
        "unknown";
    }
    expect(raisedConstraint).toBe("environments_managed_sandbox_idx");

    // Index does NOT cover tenant-created sandbox rows (no managedByPaperclip
    // marker) — operators must be able to keep multiple tenant sandbox envs.
    await db.insert(environments).values({
      name: "Tenant Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      metadata: { tenant: true },
      createdAt: new Date(now.getTime() + 2),
      updatedAt: new Date(now.getTime() + 2),
    });

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(2);
  });

  it("does not treat a non-kubernetes sandbox environment as the managed k8s env", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await svc.create(companyId, {
      name: "Fake Sandbox",
      driver: "sandbox",
      config: { provider: "fake", image: "busybox", reuseLease: false },
    });

    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();
  });

  it("ignores a config.provider=kubernetes sandbox env without the managed marker", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A tenant-created sandbox env with config.provider "kubernetes" but WITHOUT
    // the managed metadata marker must NOT be treated as the managed k8s env,
    // otherwise it would bypass the operator gVisor runtimeClass / Cilium egress.
    await svc.create(companyId, {
      name: "Tenant K8s Sandbox",
      driver: "sandbox",
      config: { provider: "kubernetes", reuseLease: false },
    });

    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();

    // The managed env (created via ensureKubernetesEnvironment) carries the
    // marker and is the only one found.
    const managed = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
    });
    const found = await svc.findKubernetesEnvironment(companyId);
    expect(found?.id).toBe(managed.id);
  });

  it("allows multiple SSH environments for the same company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await svc.create(companyId, {
      name: "Production SSH",
      driver: "ssh",
      config: { host: "prod.example.com", username: "deploy" },
    });
    const second = await svc.create(companyId, {
      name: "Staging SSH",
      driver: "ssh",
      config: { host: "staging.example.com", username: "deploy" },
    });

    expect(first.id).not.toBe(second.id);

    const rows = await db.select().from(environments);
    expect(rows.filter((row) => row.driver === "ssh")).toHaveLength(2);
  });

  describe("acquireLease company-binding guard", () => {
    async function seedSandboxEnvironment(name = "Managed Sandbox") {
      const companyId = randomUUID();
      const environmentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(environments).values({
        id: environmentId,
        name,
        driver: "sandbox",
        status: "active",
        config: { provider: "daytona" },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { companyId, environmentId };
    }

    async function bindEnvironmentToCompany(environmentId: string, companyId: string) {
      await db.insert(builtInManagedResources).values({
        companyId,
        bundleKey: "managed-environment",
        resourceKind: "environment",
        resourceKey: "managed-sandbox",
        resourceId: environmentId,
        stockVersion: "1",
        stockHash: "hash",
      });
    }

    it("rejects an acquire when a bind lands after the route check", async () => {
      const { companyId, environmentId } = await seedSandboxEnvironment();
      // The other company owns a managed binding that a reconciliation committed
      // after the route guard read an empty binding list.
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: "OTA",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await bindEnvironmentToCompany(environmentId, otherCompanyId);

      await expect(
        svc.acquireLease({ companyId, environmentId, assertCompanyBinding: true }),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "environment_company_mismatch" },
      });
      // The insert never ran, so the caller holds no lease.
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environmentId));
      expect(leaseRows).toHaveLength(0);
    });

    it("acquires when the environment is unbound (instance-global)", async () => {
      const { companyId, environmentId } = await seedSandboxEnvironment("Unbound Sandbox");

      const lease = await svc.acquireLease({ companyId, environmentId, assertCompanyBinding: true });
      expect(lease.status).toBe("active");
      expect(lease.companyId).toBe(companyId);
    });

    it("acquires when the environment is bound to the caller company", async () => {
      const { companyId, environmentId } = await seedSandboxEnvironment("Own Sandbox");
      await bindEnvironmentToCompany(environmentId, companyId);

      const lease = await svc.acquireLease({ companyId, environmentId, assertCompanyBinding: true });
      expect(lease.status).toBe("active");
    });

    it("does not check the binding for callers that omit the flag", async () => {
      const { companyId, environmentId } = await seedSandboxEnvironment("Legacy Path Sandbox");
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Co 2",
        issuePrefix: "OTB",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await bindEnvironmentToCompany(environmentId, otherCompanyId);

      // The heartbeat run path does not set the flag, so the binding check does
      // not run and the lease acquires as before.
      const lease = await svc.acquireLease({ companyId, environmentId });
      expect(lease.status).toBe("active");
    });
  });
});
