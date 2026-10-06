import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  environmentLeases,
  executionWorkspaces,
  issues,
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import { buildJobManifest } from "../../../packages/plugins/sandbox-providers/kubernetes/src/pod-spec-builder.js";
import { buildSandboxCrManifest } from "../../../packages/plugins/sandbox-providers/kubernetes/src/sandbox-cr-builder.js";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "session-1" },
  sessionDisplayId: "session-1",
  provider: "test",
  model: "test-model",
})));

const bundledKubernetesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/plugins/sandbox-providers/kubernetes",
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat plugin environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat plugin environments", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-plugin-environment");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  it("acquires plugin environment leases through the heartbeat execution path", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const agentId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-heartbeat-"));
    tempRoots.push(workspaceRoot);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-heartbeat-lease",
            metadata: {
              remoteCwd: "/workspace/project",
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin Environment Heartbeat",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Plugin Sandbox",
      driver: "plugin",
      status: "active",
        config: {
        pluginKey,
        driverKey: "sandbox",
        driverConfig: {
          template: "base",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentAcquireLease", {
      driverKey: "sandbox",
      companyId,
      environmentId,
      executionWorkspaceId: expect.any(String),
      executionWorkspaceSettings: null,
      issueId: null,
      config: { template: "base" },
      agentId,
      runId: run!.id,
      workspaceMode: "shared_workspace",
      // Pins the HEARTBEAT-path lease call forwarding the AGENT's adapter type
      // (per-run adapter / mixed-harness envs). environment-runtime.ts has two
      // drivers calling environmentAcquireLease; regressions here previously
      // shipped by editing only the non-heartbeat one.
      adapterType: "codex_local",
    });
    await vi.waitFor(() => {
      expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
        driverKey: "sandbox",
        companyId,
        environmentId,
        issueId: null,
        config: { template: "base" },
        providerLeaseId: "plugin-heartbeat-lease",
        leaseMetadata: expect.objectContaining({
          driver: "plugin",
          pluginId,
          pluginKey,
          driverKey: "sandbox",
        }),
      });
    }, { timeout: 5_000 });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("enforces master-key isolation through heartbeat dispatch and the Kubernetes pod builders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-dispatch-"));
    tempRoots.push(root);
    const pluginId = randomUUID();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn((id: string) => id === pluginId ? { supportedMethods: ["environmentAcquireLease", "environmentReleaseLease"] } : null),
      call: vi.fn(async (_id: string, method: string, payload: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return { providerLeaseId: `isolated-${randomUUID()}`, metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentRealizeWorkspace") return { cwd: "/workspace", metadata: {} };
        if (method === "environmentExecute") {
          const commandText = Array.isArray(payload.args) ? payload.args.join(" ") : "";
          const stdout = commandText.includes("PAPERCLIP_GIT_CONTEXT_V1")
            ? "\0PAPERCLIP_GIT_CONTEXT_V1\0\0PAPERCLIP_GIT_CONTEXT_END\0"
            : commandText.includes("$PATH")
              ? "\0/usr/bin:/bin\0"
              : commandText.includes("expected_sha=")
                ? '{"uploaded":true}\n'
            : "";
          return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
        }
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });

    async function seedCandidate(input: {
      driver: "local" | "ssh" | "sandbox";
      provider?: string;
      acpx?: boolean;
    }) {
      const companyId = randomUUID();
      const projectId = randomUUID();
      const environmentId = input.driver === "local"
        ? (await environmentService(db).ensureLocalEnvironment()).id
        : randomUUID();
      const agentId = randomUUID();
      await db.insert(companies).values({
        id: companyId, name: "Isolated dispatch fixture",
        issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
        status: "active", defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(projects).values({ id: projectId, companyId, name: "Dispatch fixture", status: "active" });
      await db.insert(projectWorkspaces).values({
        id: randomUUID(), companyId, projectId, name: "Primary", cwd: root, isPrimary: true,
      });
      if (input.driver !== "local") {
        await db.insert(environments).values({
          id: environmentId, companyId, name: `Candidate ${environmentId}`,
          driver: input.driver, status: "active",
          config: input.driver === "sandbox" ? { provider: input.provider } : {},
        });
      }
      await db.insert(agents).values({
        id: agentId, companyId, name: "Candidate agent", role: "engineer",
        status: "idle", adapterType: "codex_local",
        adapterConfig: input.acpx ? { provider: "acpx", acpxAgent: "claude" } : {},
        runtimeConfig: {}, defaultEnvironmentId: environmentId, permissions: {},
      });
      return { companyId, projectId, environmentId, agentId };
    }

    async function runCandidate(agentId: string, projectId: string) {
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", contextSnapshot: { projectId },
      });
      expect(run).not.toBeNull();
      await vi.waitFor(async () => {
        const latest = await heartbeat.getRun(run!.id);
        expect(latest?.status).toMatch(/^(failed|succeeded)$/);
      }, { timeout: 10_000 });
      return (await heartbeat.getRun(run!.id))!;
    }

    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    try {
      for (const candidate of [
        { driver: "local" as const },
        { driver: "local" as const, acpx: true },
        { driver: "ssh" as const },
        { driver: "sandbox" as const, provider: "other" },
      ]) {
        const fixture = await seedCandidate(candidate);
        const run = await runCandidate(fixture.agentId, fixture.projectId);
        expect(run.status).toBe("failed");
        expect(run.error).toMatch(/Kubernetes sandbox provider/);
      }
      expect(workerManager.call).not.toHaveBeenCalled();
      expect(adapterExecute).not.toHaveBeenCalled();

      await db.insert(plugins).values({
        id: pluginId, pluginKey: "paperclip.kubernetes-sandbox-provider",
        packageName: "@paperclipai/plugin-kubernetes", packagePath: bundledKubernetesPath,
        version: "0.1.0", apiVersion: 1,
        categories: ["automation"], status: "ready", installOrder: 1,
        manifestJson: {
          id: "paperclip.kubernetes-sandbox-provider", apiVersion: 1, version: "0.1.0",
          displayName: "Kubernetes", description: "First-party sandbox provider",
          author: "Paperclip", categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: "kubernetes", kind: "sandbox_provider", displayName: "Kubernetes", configSchema: { type: "object" } }],
        },
      } as any);
      const admitted = await seedCandidate({ driver: "sandbox", provider: "kubernetes" });
      const admittedRun = await runCandidate(admitted.agentId, admitted.projectId);
      expect(admittedRun.status).toBe("succeeded");
      expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
        driverKey: "kubernetes", companyId: admitted.companyId,
        environmentId: admitted.environmentId, runId: admittedRun.id,
      }), undefined);
      expect(adapterExecute).toHaveBeenCalledTimes(1);

      for (const manifest of [
        buildJobManifest({ namespace: "paperclip-test", jobName: "agent-test", adapterType: "codex_local",
          image: "agent:test", envSecretName: "run-env", serviceAccountName: "tenant-sa",
          labels: {}, resources: {}, activeDeadlineSec: 60, ttlSecondsAfterFinished: 60 }),
        buildSandboxCrManifest({ namespace: "paperclip-test", sandboxName: "agent-test", adapterType: "codex_local",
          image: "agent:test", envSecretName: "run-env", serviceAccountName: "tenant-sa",
          labels: {}, resources: {} }),
      ]) {
        const spec = manifest.kind === "Job"
          ? (manifest.spec as any).template.spec
          : (manifest.spec as any).podTemplate.spec;
        expect(spec.automountServiceAccountToken).toBe(false);
        expect(spec.securityContext.runAsNonRoot).toBe(true);
        expect(spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
        expect(spec.volumes.every((volume: { emptyDir?: unknown }) => volume.emptyDir !== undefined)).toBe(true);
        expect(JSON.stringify(spec)).not.toMatch(/hostPath|docker\.sock|master\.key/);
      }

      await vi.waitFor(async () => {
        const leases = await db.select({ status: environmentLeases.status })
          .from(environmentLeases)
          .where(eq(environmentLeases.heartbeatRunId, admittedRun.id));
        expect(leases).toHaveLength(1);
        expect(leases[0]?.status).not.toBe("active");
      }, { timeout: 5_000 });
      vi.mocked(workerManager.call).mockClear();

      await db.update(plugins).set({ packagePath: root }).where(eq(plugins.id, pluginId));
      const localSpoof = await seedCandidate({ driver: "sandbox", provider: "kubernetes" });
      const localSpoofRun = await runCandidate(localSpoof.agentId, localSpoof.projectId);
      expect(localSpoofRun.status).toBe("failed");
      expect(localSpoofRun.error).toMatch(/bundled Kubernetes sandbox provider/);

      await db.update(plugins).set({
        packagePath: null, packageName: "@paperclipai/plugin-kubernetes",
      }).where(eq(plugins.id, pluginId));
      const npmSpoof = await seedCandidate({ driver: "sandbox", provider: "kubernetes" });
      const npmSpoofRun = await runCandidate(npmSpoof.agentId, npmSpoof.projectId);
      expect(npmSpoofRun.status).toBe("failed");
      expect(npmSpoofRun.error).toMatch(/bundled Kubernetes sandbox provider/);
      expect(await db.select().from(environmentLeases)
        .where(eq(environmentLeases.heartbeatRunId, npmSpoofRun.id))).toHaveLength(0);

      await db.update(plugins).set({ packagePath: null, packageName: "@other/spoofed-kubernetes" })
        .where(eq(plugins.id, pluginId));
      const spoofed = await seedCandidate({ driver: "sandbox", provider: "kubernetes" });
      const spoofedRun = await runCandidate(spoofed.agentId, spoofed.projectId);
      expect(spoofedRun.status).toBe("failed");
      expect(spoofedRun.error).toMatch(/bundled Kubernetes sandbox provider/);
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      expect(workerManager.call).not.toHaveBeenCalled();
    } finally {
      await heartbeat.drainActiveRunExecutions();
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it("inherits the instance default environment across companies while preserving explicit agent overrides", async () => {
    const sharedEnvironmentId = randomUUID();
    const overrideEnvironmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const companyAId = randomUUID();
    const companyBId = randomUUID();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const workspaceAId = randomUUID();
    const workspaceBId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workspaceRootA = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-company-a-"));
    const workspaceRootB = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-company-b-"));
    tempRoots.push(workspaceRootA, workspaceRootB);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, payload: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `plugin-heartbeat-lease-${String(payload.environmentId)}`,
            metadata: {
              remoteCwd: `/workspace/${String(payload.environmentId)}`,
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values([
      {
        id: sharedEnvironmentId,
        name: "Shared Plugin Sandbox",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "shared",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: overrideEnvironmentId,
        name: "Override Plugin Sandbox",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "override",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await instanceSettingsService(db).update({ defaultEnvironmentId: sharedEnvironmentId });

    await db.insert(companies).values([
      {
        id: companyAId,
        name: "Acme A",
        issuePrefix: `T${companyAId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        defaultResponsibleUserId: "responsible-user-a",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: companyBId,
        name: "Acme B",
        issuePrefix: `T${companyBId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        defaultResponsibleUserId: "responsible-user-b",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(projects).values([
      {
        id: projectAId,
        companyId: companyAId,
        name: "Company A Project",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: projectBId,
        companyId: companyBId,
        name: "Company B Project",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: workspaceAId,
        companyId: companyAId,
        projectId: projectAId,
        name: "Primary",
        cwd: workspaceRootA,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: workspaceBId,
        companyId: companyBId,
        projectId: projectBId,
        name: "Primary",
        cwd: workspaceRootB,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId: companyAId,
        name: "SharedEnvAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: null,
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: agentBId,
        companyId: companyBId,
        name: "OverrideEnvAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: overrideEnvironmentId,
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    const sharedRun = await heartbeat.wakeup(agentAId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId: projectAId },
    });
    const overrideRun = await heartbeat.wakeup(agentBId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId: projectBId },
    });

    expect(sharedRun).not.toBeNull();
    expect(overrideRun).not.toBeNull();
    await vi.waitFor(async () => {
      const [latestShared, latestOverride] = await Promise.all([
        heartbeat.getRun(sharedRun!.id),
        heartbeat.getRun(overrideRun!.id),
      ]);
      expect(latestShared?.status).toBe("succeeded");
      expect(latestOverride?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    const acquireCalls = workerManager.call.mock.calls
      .filter(([, method]) => method === "environmentAcquireLease");
    const acquirePayloads = acquireCalls.map(([, , payload]) => payload);

    expect(acquireCalls).toHaveLength(2);
    expect(acquirePayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: companyAId,
        environmentId: sharedEnvironmentId,
        config: { template: "shared" },
        agentId: agentAId,
        runId: sharedRun!.id,
        adapterType: "codex_local",
      }),
      expect.objectContaining({
        companyId: companyBId,
        environmentId: overrideEnvironmentId,
        config: { template: "override" },
        agentId: agentBId,
        runId: overrideRun!.id,
        adapterType: "codex_local",
      }),
    ]));
  }, 15_000);

  it("ignores stale non-reused workspace environment config in favor of the assignee selection", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const oldEnvironmentId = randomUUID();
    const newEnvironmentId = randomUUID();
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleExecutionWorkspaceId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-env-issue-"));
    tempRoots.push(workspaceRoot);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, payload: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `plugin-heartbeat-lease-${String(payload.environmentId)}`,
            metadata: {
              remoteCwd: `/workspace/${String(payload.environmentId)}`,
            },
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    await instanceSettingsService(db).updateExperimental({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin Environment Issue",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "sandbox",
            displayName: "Sandbox",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values([
      {
        id: oldEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "old",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: newEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "plugin",
        status: "active",
        config: {
          pluginKey,
          driverKey: "sandbox",
          driverConfig: {
            template: "new",
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: newEnvironmentId,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: staleExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Stale workspace",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
      metadata: {
        config: {
          environmentId: oldEnvironmentId,
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      title: "Environment matrix: e2b / codex_local",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionWorkspaceId: staleExecutionWorkspaceId,
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentAcquireLease", {
      driverKey: "sandbox",
      companyId,
      environmentId: newEnvironmentId,
      executionWorkspaceId: expect.any(String),
      executionWorkspaceSettings: { mode: "shared_workspace" },
      issueId,
      config: { template: "new" },
      agentId,
      runId: run!.id,
      workspaceMode: "shared_workspace",
      adapterType: "codex_local",
    });
  }, 15_000);
});
