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
import { ensureSshWorkspaceReady, findReachablePaperclipApiUrlOverSsh } from "@paperclipai/adapter-utils/ssh";
import { environmentService } from "./environments.js";
import { parseEnvironmentDriverConfig, resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
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
  resumePluginEnvironmentLease,
} from "./plugin-environment-driver.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  heartbeatRunId: string;
  executionWorkspaceId: string | null;
  executionWorkspaceMode: ExecutionWorkspace["mode"] | null;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
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
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment);
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      const candidateUrls = (() => {
        const raw = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [];
        } catch {
          return [];
        }
      })();
      const paperclipApiUrl = await findReachablePaperclipApiUrlOverSsh({
        config: parsed.config,
        candidates: candidateUrls,
      });
      if (!paperclipApiUrl) {
        throw new Error(
          `SSH environment ${parsed.config.username}@${parsed.config.host} could not reach any Paperclip API candidates.`,
        );
      }
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
          paperclipApiUrl,
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
  pluginWorkerManager?: PluginWorkerManager,
): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);
  const pluginRegistry = pluginRegistryService(db);

  /**
   * Resolve a sandbox provider plugin by looking up a plugin whose manifest
   * declares an environment driver with a matching driverKey. Returns null
   * if no matching plugin is found or the worker isn't running.
   */
  async function resolvePluginForProvider(
    provider: string,
  ): Promise<{ pluginId: string; pluginKey: string } | null> {
    if (!pluginWorkerManager) return null;
    const plugins = await pluginRegistry.list();
    for (const plugin of plugins) {
      if (plugin.status !== "ready") continue;
      const drivers = plugin.manifestJson.environmentDrivers ?? [];
      for (const driver of drivers) {
        if (
          driver.driverKey === provider &&
          driver.kind === "sandbox_provider" &&
          pluginWorkerManager.isRunning(plugin.id)
        ) {
          return { pluginId: plugin.id, pluginKey: plugin.pluginKey };
        }
      }
    }
    return null;
  }

  async function resolvePluginSandboxRuntimeConfig(input: {
    environment: Environment;
    lease: EnvironmentLease;
    provider: string;
  }): Promise<Record<string, unknown>> {
    const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
    if (metadataConfig && metadataConfig.provider === input.provider) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
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
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment);
      if (parsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for driver "${input.environment.driver}".`);
      }

      // Check if this provider should be handled by a plugin.
      if (!isBuiltinSandboxProvider(parsed.config.provider)) {
        const pluginProvider = await resolvePluginForProvider(parsed.config.provider);
        if (!pluginProvider || !pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is not registered as a built-in provider and no matching plugin is available.`,
          );
        }

        // Delegate to the plugin worker for lease acquisition.
        const providerLease = await pluginWorkerManager.call(
          pluginProvider.pluginId,
          "environmentAcquireLease",
          {
            driverKey: parsed.config.provider,
            companyId: input.companyId,
            environmentId: input.environment.id,
            config: parsed.config as unknown as Record<string, unknown>,
            runId: input.heartbeatRunId,
            workspaceMode: input.executionWorkspaceMode ?? undefined,
          },
        );

        const resolvedLeasePolicy = parsed.config.reuseLease
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
          expiresAt: providerLease.expiresAt ? new Date(providerLease.expiresAt) : undefined,
          metadata: {
            driver: input.environment.driver,
            executionWorkspaceMode: input.executionWorkspaceMode,
            pluginId: pluginProvider.pluginId,
            pluginKey: pluginProvider.pluginKey,
            sandboxProviderPlugin: true,
            ...sandboxConfigForLeaseMetadata(parsed.config),
            ...(providerLease.metadata ?? {}),
          },
        });
      }

      // Built-in sandbox provider path.
      const reusableProviderLeaseId = parsed.config.reuseLease
        ? (await environmentsSvc
            .listLeases(input.environment.id)
            .then((leases) => findReusableSandboxLeaseId({ config: parsed.config, leases })))
        : null;

      const providerLease = await acquireSandboxProviderLease({
        config: parsed.config,
        environmentId: input.environment.id,
        heartbeatRunId: input.heartbeatRunId,
        issueId: input.issueId,
        reusableProviderLeaseId,
      });

      const resolvedLeasePolicy = parsed.config.reuseLease
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
            config,
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            workspace: input.workspace,
          });
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
          return await pluginWorkerManager.call(pluginId, "environmentExecute", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            config,
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
          });
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
          config,
          providerLeaseId: input.lease.providerLeaseId,
          leaseMetadata: metadata,
        });
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
        config: parsed.config.driverConfig,
        runId: input.heartbeatRunId,
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
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const drivers = new Map<string, EnvironmentRuntimeDriver>();

  const defaultDrivers = [
    createLocalEnvironmentDriver(db),
    createSshEnvironmentDriver(db),
    createSandboxEnvironmentDriver(db, options.pluginWorkerManager),
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
      heartbeatRunId: string;
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
