import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  PluginEnvironmentConfig,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import type {
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import { environmentService } from "./environments.js";
import {
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  stripSandboxProviderEnvelope,
} from "./environment-config.js";
import {
  acquireSandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  isBuiltinSandboxProvider,
  releaseSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
} from "./sandbox-provider-runtime.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  destroyPluginEnvironmentLease,
  executePluginEnvironmentCommand,
  realizePluginEnvironmentWorkspace,
  resolvePluginSandboxProviderDriverByKey,
  resolvePluginExecuteRpcTimeoutMs,
  resumePluginEnvironmentLease,
} from "./plugin-environment-driver.js";
import { collectSecretRefPaths } from "./json-schema-secret-refs.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

function stripSecretRefValuesFromPluginLeaseMetadata(input: {
  metadata: Record<string, unknown> | null | undefined;
  schema: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const sanitized = structuredClone(input.metadata ?? {}) as Record<string, unknown>;

  for (const path of collectSecretRefPaths(input.schema)) {
    const keys = path.split(".");
    const parents: Array<{ container: Record<string, unknown>; key: string }> = [];
    let cursor: Record<string, unknown> | null = sanitized;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index]!;
      const next = cursor?.[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor = null;
        break;
      }
      parents.push({ container: cursor, key });
      cursor = next as Record<string, unknown>;
    }

    if (!cursor) continue;

    const leafKey = keys[keys.length - 1]!;
    if (!Object.prototype.hasOwnProperty.call(cursor, leafKey)) continue;
    delete cursor[leafKey];

    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const { container, key } = parents[index]!;
      const value = container[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).length === 0
      ) {
        delete container[key];
      } else {
        break;
      }
    }
  }

  return sanitized;
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  /**
   * UUID of the owning heartbeat run, or null for ad-hoc invocations
   * (e.g. operator-initiated `Test` probes) that are not tied to a run.
   * Null leases must be released by id via `getDriver(...).releaseRunLease`
   * since `releaseRunLeases(heartbeatRunId)` cannot find them.
   */
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceMode: ExecutionWorkspace["mode"] | null;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}

function resolvePluginSandboxRpcTimeoutMs(config: Record<string, unknown>): number | undefined {
  const timeoutCandidates = [
    typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    typeof config.bridgeRequestTimeoutMs === "number" ? config.bridgeRequestTimeoutMs : undefined,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (timeoutCandidates.length === 0) {
    return undefined;
  }

  return resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: Math.max(...timeoutCandidates),
    config,
  });
}

export interface EnvironmentDriverLeaseInput {
  environment: Environment;
  lease: EnvironmentLease;
}

export interface EnvironmentDriverRealizeWorkspaceInput extends EnvironmentDriverLeaseInput {
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface EnvironmentDriverExecuteInput extends EnvironmentDriverLeaseInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface EnvironmentRuntimeDriver {
  readonly driver: string;
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentLease>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
  resumeRunLease?(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null>;
  destroyRunLease?(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null>;
  realizeWorkspace?(input: EnvironmentDriverRealizeWorkspaceInput): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  execute?(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult>;
}

export interface EnvironmentRuntimeLeaseRecord {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLeaseDriverKey(lease: Pick<EnvironmentLease, "metadata">, environment: Pick<Environment, "driver">): string {
  const leaseDriver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : null;
  return leaseDriver ?? environment.driver;
}

export function findReusableSandboxLeaseId(input: {
  config: SandboxEnvironmentConfig;
  leases: Array<Pick<EnvironmentLease, "providerLeaseId" | "metadata">>;
}): string | null {
  return findReusableSandboxProviderLeaseId(input);
}

function createLocalEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "local",

    async acquireRunLease(input) {
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: {
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? null,
      });
      return {
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? "/",
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSshEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "ssh",

    async acquireRunLease(input) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
      });
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "ssh",
        providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
        metadata: {
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          host: parsed.config.host,
          port: parsed.config.port,
          username: parsed.config.username,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSandboxEnvironmentDriver(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
  } = {},
): EnvironmentRuntimeDriver {
  const pluginWorkerManager = options.pluginWorkerManager;
  const pluginWorkerReadyTimeoutMs = options.pluginWorkerReadyTimeoutMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS;
  const pluginWorkerReadyPollMs = options.pluginWorkerReadyPollMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS;
  const environmentsSvc = environmentService(db);

  async function resolveSandboxProviderPlugin(input: { provider: string }) {
    const running = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: true,
    });
    if (running) {
      return { state: "running" as const, resolved: running };
    }

    const installed = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: false,
    });
    if (!installed) {
      return { state: "missing" as const, resolved: null };
    }

    if (installed.plugin.status !== "ready") {
      return { state: "not_ready" as const, resolved: installed };
    }

    if (!pluginWorkerManager) {
      return { state: "worker_unavailable" as const, resolved: installed };
    }

    const deadline = Date.now() + Math.max(0, pluginWorkerReadyTimeoutMs);
    while (Date.now() < deadline) {
      const retried = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: input.provider,
        workerManager: pluginWorkerManager,
        requireRunning: true,
      });
      if (retried) {
        return { state: "running" as const, resolved: retried };
      }
      await delay(Math.max(1, pluginWorkerReadyPollMs));
    }

    return { state: "worker_unavailable" as const, resolved: installed };
  }

  async function resolvePluginSandboxRuntimeConfig(input: {
    environment: Environment;
    lease: EnvironmentLease;
    provider: string;
  }): Promise<Record<string, unknown>> {
    const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
    if (metadataConfig && metadataConfig.provider === input.provider) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
        id: input.environment.id,
        driver: "sandbox",
        config: sandboxConfigForLeaseMetadata(metadataConfig),
      });
      if (parsed.driver === "sandbox") {
        return parsed.config as unknown as Record<string, unknown>;
      }
    }

    if (input.environment.driver === "sandbox") {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(
          db,
          input.lease.companyId,
          input.environment,
        );
        if (parsed.driver === "sandbox" && parsed.config.provider === input.provider) {
          return parsed.config as unknown as Record<string, unknown>;
        }
      } catch {
        // Lease metadata below is intentionally kept sufficient for cleanup
        // after the environment config changes or becomes invalid.
      }
    }

    return {
      provider: input.provider,
      ...sanitizePluginSandboxConfigFromLeaseMetadata(input.lease.metadata),
    };
  }

  return {
    driver: "sandbox",

    async acquireRunLease(input) {
      const storedParsed = parseEnvironmentDriverConfig(input.environment);
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
      });
      if (parsed.driver !== "sandbox" || storedParsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for driver "${input.environment.driver}".`);
      }

      // Check if this provider should be handled by a plugin.
      if (!isBuiltinSandboxProvider(parsed.config.provider)) {
        const pluginProvider = await resolveSandboxProviderPlugin({
          provider: parsed.config.provider,
        });
        if (pluginProvider.state === "missing") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is not registered as a built-in provider and no matching plugin is available.`,
          );
        }
        if (pluginProvider.state === "not_ready") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but that plugin is currently ${pluginProvider.resolved.plugin.status}.`,
          );
        }
        if (pluginProvider.state === "worker_unavailable") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but its worker is not running.`,
          );
        }
        if (!pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed, but sandbox plugin workers are unavailable in this server process.`,
          );
        }

        const workerConfig = stripSandboxProviderEnvelope(parsed.config);
        const storedConfig = storedParsed.config;
        // Ad-hoc tests (heartbeatRunId === null) must never resume an existing
        // provider lease. If they did, releasing the test lease at the end of
        // the probe would tear down the live heartbeat run that owns it.
        // We also filter out leases whose policy is not reuse_by_environment
        // so any non-reusable lease (including ad-hoc test leases that
        // landed in the table from older code paths) cannot be matched.
        const reusableExistingLeases = parsed.config.reuseLease && input.heartbeatRunId !== null
          ? (await environmentsSvc.listLeases(input.environment.id))
              .filter((lease) => lease.leasePolicy === "reuse_by_environment")
          : [];
        const reusableProviderLeaseId = parsed.config.reuseLease && input.heartbeatRunId !== null
          ? findReusableSandboxLeaseId({ config: storedConfig, leases: reusableExistingLeases })
          : null;
        const reusableLease = reusableProviderLeaseId
          ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
          : null;

        const providerLease = reusableLease?.providerLeaseId
          ? await pluginWorkerManager.call(
              pluginProvider.resolved.plugin.id,
              "environmentResumeLease",
              {
                driverKey: parsed.config.provider,
                companyId: input.companyId,
                environmentId: input.environment.id,
                issueId: input.issueId,
                config: workerConfig,
                providerLeaseId: reusableLease.providerLeaseId,
                leaseMetadata: reusableLease.metadata ?? undefined,
              },
              resolvePluginSandboxRpcTimeoutMs(workerConfig),
            ).then((resumed) =>
              typeof resumed.providerLeaseId === "string" && resumed.providerLeaseId.length > 0
                ? resumed
                : null,
            ).catch(() => null)
          : null;
        const acquiredLease = providerLease ?? await pluginWorkerManager.call(
          pluginProvider.resolved.plugin.id,
          "environmentAcquireLease",
          {
            driverKey: parsed.config.provider,
            companyId: input.companyId,
            environmentId: input.environment.id,
            issueId: input.issueId,
            config: workerConfig,
            // Plugin SDK requires a string; ad-hoc test leases use a fresh
            // UUID so providers that validate or persist the runId still see
            // a well-formed identifier.
            runId: input.heartbeatRunId ?? randomUUID(),
            workspaceMode: input.executionWorkspaceMode ?? undefined,
          },
          resolvePluginSandboxRpcTimeoutMs(workerConfig),
        );

        // Ad-hoc test leases are never publishable for reuse: storing them
        // as `reuse_by_environment` would let a concurrent heartbeat resume
        // the test's provider lease and lose its sandbox when the test ends.
        const resolvedLeasePolicy = parsed.config.reuseLease && input.heartbeatRunId !== null
          ? "reuse_by_environment"
          : "ephemeral";

        return await environmentsSvc.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: resolvedLeasePolicy,
          provider: parsed.config.provider,
          providerLeaseId: acquiredLease.providerLeaseId,
          expiresAt: acquiredLease.expiresAt ? new Date(acquiredLease.expiresAt) : undefined,
          metadata: {
            driver: input.environment.driver,
            executionWorkspaceMode: input.executionWorkspaceMode,
            pluginId: pluginProvider.resolved.plugin.id,
            pluginKey: pluginProvider.resolved.plugin.pluginKey,
            sandboxProviderPlugin: true,
            ...sandboxConfigForLeaseMetadata(storedConfig),
            ...stripSecretRefValuesFromPluginLeaseMetadata({
              metadata: acquiredLease.metadata,
              schema: pluginProvider.resolved.driver.configSchema as Record<string, unknown> | null | undefined,
            }),
          },
        });
      }

      // Built-in sandbox provider path. Same guard as the plugin-backed path:
      // ad-hoc tests (heartbeatRunId === null) must never resume an existing
      // provider lease, or releasing the test lease will terminate the live
      // heartbeat run that shares it. Filter to leases whose policy is
      // reuse_by_environment so non-reusable rows can never be matched.
      const reusableProviderLeaseId = parsed.config.reuseLease && input.heartbeatRunId !== null
        ? (await environmentsSvc
            .listLeases(input.environment.id)
            .then((leases) =>
              findReusableSandboxLeaseId({
                config: parsed.config,
                leases: leases.filter((lease) => lease.leasePolicy === "reuse_by_environment"),
              }),
            ))
        : null;

      const providerLease = await acquireSandboxProviderLease({
        config: parsed.config,
        environmentId: input.environment.id,
        heartbeatRunId: input.heartbeatRunId ?? randomUUID(),
        issueId: input.issueId,
        reusableProviderLeaseId,
      });

      // Same ephemeral-policy-for-tests guard as the plugin-backed path:
      // ad-hoc test leases must not be publishable for reuse.
      const resolvedLeasePolicy = parsed.config.reuseLease && input.heartbeatRunId !== null
        ? "reuse_by_environment"
        : "ephemeral";

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: resolvedLeasePolicy,
        provider: parsed.config.provider,
        providerLeaseId: providerLease.providerLeaseId,
        metadata: {
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          ...providerLease.metadata,
        },
      });
    },

    async releaseRunLease(input) {
      // Check if this lease was acquired through a plugin.
      if (input.lease.metadata?.sandboxProviderPlugin) {
        return await releasePluginBackedSandboxLease(input);
      }

      const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);

      // If no built-in provider handles this metadata, try plugin path.
      if (!metadataConfig) {
        const looseConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
        if (looseConfig && !isBuiltinSandboxProvider(looseConfig.provider)) {
          return await releasePluginBackedSandboxLease(input);
        }
      }

      const parsed = metadataConfig
        ? await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
            id: input.environment.id,
            driver: "sandbox",
            config: metadataConfig as unknown as Record<string, unknown>,
          })
        : await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment);
      if (parsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for lease "${input.lease.id}".`);
      }

      let cleanupStatus: "success" | "failed" = "success";
      try {
        await releaseSandboxProviderLease({
          config: parsed.config,
          providerLeaseId: input.lease.providerLeaseId,
          status: input.status,
        });
      } catch {
        cleanupStatus = "failed";
      }
      const releaseStatus = input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? "retained" as const
        : input.status;
      return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
        failureReason: input.status === "failed" ? "adapter_or_run_failure" : undefined,
        cleanupStatus,
      });
    },

    async realizeWorkspace(input) {
      // Plugin-backed sandbox providers: delegate workspace realization.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey =
          readString(input.lease.metadata?.provider) ??
          (input.environment.driver === "sandbox"
            ? (parseEnvironmentDriverConfig(input.environment).config as SandboxEnvironmentConfig).provider
            : null);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          return await pluginWorkerManager.call(pluginId, "environmentRealizeWorkspace", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            workspace: input.workspace,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
        }
      }

      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },

    async execute(input) {
      // Plugin-backed sandbox providers: delegate command execution.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey = readString(input.lease.metadata?.provider);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const sanitizedConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
          return await pluginWorkerManager.call(pluginId, "environmentExecute", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: sanitizedConfig,
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
          }, resolvePluginExecuteRpcTimeoutMs({
            requestedTimeoutMs: input.timeoutMs,
            config: sanitizedConfig,
          }));
        }
      }
      throw new Error("Sandbox driver does not support direct command execution for built-in providers.");
    },
  };

  async function releasePluginBackedSandboxLease(
    input: EnvironmentDriverReleaseInput,
  ): Promise<EnvironmentLease | null> {
    const metadata = input.lease.metadata ?? {};
    const pluginId = readString(metadata.pluginId);
    const providerKey = readString(metadata.provider);

    let cleanupStatus: "success" | "failed" = "success";
    if (pluginId && providerKey && pluginWorkerManager?.isRunning(pluginId)) {
      try {
        const config = await resolvePluginSandboxRuntimeConfig({
          environment: input.environment,
          lease: input.lease,
          provider: providerKey,
        });
        await pluginWorkerManager.call(pluginId, "environmentReleaseLease", {
          driverKey: providerKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
          providerLeaseId: input.lease.providerLeaseId,
          leaseMetadata: metadata,
        }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
      } catch {
        cleanupStatus = "failed";
      }
    } else {
      cleanupStatus = "failed";
    }

    const releaseStatus =
      input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? ("retained" as const)
        : input.status;
    return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
      failureReason: input.status === "failed" ? "adapter_or_run_failure" : undefined,
      cleanupStatus,
    });
  }
}

function parseExpiresAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pluginDriverProviderKey(config: PluginEnvironmentConfig): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS = new Set([
  "driver",
  "executionWorkspaceMode",
  "pluginId",
  "pluginKey",
  "providerMetadata",
  "shellCommand",
  "sandboxProviderPlugin",
]);

function sanitizePluginSandboxConfigFromLeaseMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sandboxConfigForLeaseMetadata(config: SandboxEnvironmentConfig): Record<string, unknown> {
  return { ...config };
}

function tryParseCurrentPluginConfig(environment: Environment): PluginEnvironmentConfig | null {
  if (environment.driver !== "plugin") {
    return null;
  }
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    return parsed.driver === "plugin" ? parsed.config : null;
  } catch {
    return null;
  }
}

function createPluginEnvironmentDriver(
  db: Db,
  workerManager: PluginWorkerManager,
): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);
  const pluginRegistry = pluginRegistryService(db);

  async function resolvePluginDriver(config: PluginEnvironmentConfig) {
    const plugin = await pluginRegistry.getByKey(config.pluginKey);
    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" is not ready.`);
    }
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === config.driverKey,
    );
    if (!driver) {
      throw new Error(`Plugin "${config.pluginKey}" does not declare environment driver "${config.driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" has no running worker.`);
    }
    return { plugin };
  }

  async function resolvePluginDriverForRelease(input: EnvironmentDriverReleaseInput) {
    const metadata = input.lease.metadata ?? {};
    const metadataPluginId = readString(metadata.pluginId);
    const metadataPluginKey = readString(metadata.pluginKey);
    const metadataDriverKey = readString(metadata.driverKey);
    const currentConfig = tryParseCurrentPluginConfig(input.environment);

    if (!metadataPluginId && !metadataPluginKey && !metadataDriverKey) {
      if (!currentConfig) {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(currentConfig);
      return {
        plugin,
        pluginKey: currentConfig.pluginKey,
        driverKey: currentConfig.driverKey,
        driverConfig: currentConfig.driverConfig,
      };
    }

    const plugin = metadataPluginId
      ? await pluginRegistry.getById(metadataPluginId)
      : metadataPluginKey
        ? await pluginRegistry.getByKey(metadataPluginKey)
        : currentConfig
          ? await pluginRegistry.getByKey(currentConfig.pluginKey)
          : null;
    const driverKey = metadataDriverKey ?? currentConfig?.driverKey;
    const pluginKey = metadataPluginKey ?? plugin?.pluginKey ?? currentConfig?.pluginKey ?? "unknown";

    if (!driverKey) {
      throw new Error(`Plugin environment driver "${pluginKey}:unknown" is missing a driver key.`);
    }

    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginKey}:${driverKey}" is not ready.`);
    }
    const declaredDriver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === driverKey,
    );
    if (!declaredDriver) {
      throw new Error(`Plugin "${plugin.pluginKey}" does not declare environment driver "${driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${plugin.pluginKey}:${driverKey}" has no running worker.`);
    }

    const currentConfigStillMatches =
      currentConfig?.pluginKey === plugin.pluginKey && currentConfig.driverKey === driverKey;

    return {
      plugin,
      pluginKey: plugin.pluginKey,
      driverKey,
      driverConfig: currentConfigStillMatches ? currentConfig.driverConfig : {},
    };
  }

  return {
    driver: "plugin",

    async acquireRunLease(input) {
      const parsed = parseEnvironmentDriverConfig(input.environment);
      if (parsed.driver !== "plugin") {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(parsed.config);
      const providerLease = await workerManager.call(plugin.id, "environmentAcquireLease", {
        driverKey: parsed.config.driverKey,
        companyId: input.companyId,
        environmentId: input.environment.id,
        issueId: input.issueId,
        config: parsed.config.driverConfig,
        runId: input.heartbeatRunId ?? randomUUID(),
        workspaceMode: input.executionWorkspaceMode ?? undefined,
      });

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: `plugin:${parsed.config.pluginKey}:${parsed.config.driverKey}`,
        providerLeaseId: providerLease.providerLeaseId,
        expiresAt: parseExpiresAt(providerLease.expiresAt),
        metadata: {
          providerMetadata: providerLease.metadata ?? {},
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: plugin.id,
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      });
    },

    async releaseRunLease(input) {
      const { plugin, driverKey, driverConfig } = await resolvePluginDriverForRelease(input);
      await workerManager.call(plugin.id, "environmentReleaseLease", {
        driverKey,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: driverConfig,
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async resumeRunLease(input) {
      if (!input.lease.providerLeaseId) {
        throw new Error(`Plugin environment lease "${input.lease.id}" does not have a provider lease id to resume.`);
      }
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "released",
      });
      return await resumePluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
    },

    async destroyRunLease(input) {
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "failed",
      });
      await destroyPluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, "failed");
    },

    async realizeWorkspace(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await realizePluginEnvironmentWorkspace({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          workspace: input.workspace,
        },
      });
    },

    async execute(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await executePluginEnvironmentCommand({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          stdin: input.stdin,
          timeoutMs: input.timeoutMs,
        },
      });
    },
  };
}

export function environmentRuntimeService(
  db: Db,
  options: {
    drivers?: EnvironmentRuntimeDriver[];
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const drivers = new Map<string, EnvironmentRuntimeDriver>();

  const defaultDrivers = [
    createLocalEnvironmentDriver(db),
    createSshEnvironmentDriver(db),
    createSandboxEnvironmentDriver(db, {
      pluginWorkerManager: options.pluginWorkerManager,
      pluginWorkerReadyTimeoutMs: options.pluginWorkerReadyTimeoutMs,
      pluginWorkerReadyPollMs: options.pluginWorkerReadyPollMs,
    }),
    ...(options.pluginWorkerManager
      ? [createPluginEnvironmentDriver(db, options.pluginWorkerManager)]
      : []),
  ];

  for (const driver of options.drivers ?? defaultDrivers) {
    drivers.set(driver.driver, driver);
  }

  function getDriver(driverKey: string): EnvironmentRuntimeDriver | null {
    return drivers.get(driverKey) ?? null;
  }

  function requireDriver(environment: Pick<Environment, "driver">): EnvironmentRuntimeDriver {
    const driver = getDriver(environment.driver);
    if (!driver) {
      throw new Error(
        `Environment driver "${environment.driver}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  function requireDriverKey(driverKey: string): EnvironmentRuntimeDriver {
    const driver = getDriver(driverKey);
    if (!driver) {
      throw new Error(
        `Environment driver "${driverKey}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  return {
    getDriver,

    async acquireRunLease(input: {
      companyId: string;
      environment: Environment;
      issueId: string | null;
      /** Null for ad-hoc invocations (e.g. operator-initiated `Test` probes). */
      heartbeatRunId: string | null;
      persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
    }): Promise<EnvironmentRuntimeLeaseRecord> {
      if (input.environment.status !== "active") {
        throw new Error(`Environment "${input.environment.name}" is not active.`);
      }

      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const driver = requireDriver(input.environment);
      const lease = await driver.acquireRunLease({
        companyId: input.companyId,
        environment: input.environment,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        executionWorkspaceMode: leaseContext.executionWorkspaceMode,
      });

      return {
        environment: input.environment,
        lease,
        leaseContext,
      };
    },

    async releaseRunLeases(
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            inArray(environmentLeases.status, ["active"]),
          ),
        );
      if (leaseRows.length === 0) {
        return [];
      }

      const released: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of leaseRows) {
        const environment = await environmentsSvc.getById(leaseRow.environmentId);
        if (!environment) continue;

        const leaseSnapshot: EnvironmentLease = {
          id: leaseRow.id,
          companyId: leaseRow.companyId,
          environmentId: leaseRow.environmentId,
          executionWorkspaceId: leaseRow.executionWorkspaceId ?? null,
          issueId: leaseRow.issueId ?? null,
          heartbeatRunId: leaseRow.heartbeatRunId ?? null,
          status: leaseRow.status as EnvironmentLease["status"],
          leasePolicy: leaseRow.leasePolicy as EnvironmentLease["leasePolicy"],
          provider: leaseRow.provider ?? null,
          providerLeaseId: leaseRow.providerLeaseId ?? null,
          acquiredAt: leaseRow.acquiredAt,
          lastUsedAt: leaseRow.lastUsedAt,
          expiresAt: leaseRow.expiresAt ?? null,
          releasedAt: leaseRow.releasedAt ?? null,
          failureReason: leaseRow.failureReason ?? null,
          cleanupStatus: leaseRow.cleanupStatus as EnvironmentLease["cleanupStatus"],
          metadata: (leaseRow.metadata as Record<string, unknown> | null) ?? null,
          createdAt: leaseRow.createdAt,
          updatedAt: leaseRow.updatedAt,
        };
        const driver = getDriver(getLeaseDriverKey(leaseSnapshot, environment));
        const lease = driver
          ? await driver.releaseRunLease({
              environment,
              lease: leaseSnapshot,
              status,
            })
          : await environmentsSvc.releaseLease(leaseRow.id, status);
        if (!lease) continue;

        released.push({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: lease.executionWorkspaceId,
            executionWorkspaceMode:
              (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
          },
        });
      }

      return released;
    },

    async resumeRunLease(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.resumeRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease resume.`);
      }
      return await driver.resumeRunLease(input);
    },

    async destroyRunLease(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.destroyRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease destroy.`);
      }
      return await driver.destroyRunLease(input);
    },

    async realizeWorkspace(
      input: EnvironmentDriverRealizeWorkspaceInput,
    ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.realizeWorkspace) {
        throw new Error(`Environment driver "${driver.driver}" does not support workspace realization.`);
      }
      return await driver.realizeWorkspace(input);
    },

    async execute(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.execute) {
        throw new Error(`Environment driver "${driver.driver}" does not support command execution.`);
      }
      return await driver.execute(input);
    },
  };
}

export type EnvironmentRuntimeService = ReturnType<typeof environmentRuntimeService>;
