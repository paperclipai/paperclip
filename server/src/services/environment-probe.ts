import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { environmentRuntimeService } from "./environment-runtime.js";

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: {
    companyId?: string | null;
    pluginWorkerManager?: PluginWorkerManager;
    resolvedConfig?: ParsedEnvironmentConfig;
    applyCustomImageTemplate?: boolean;
    acquireSandboxRuntimeLease?: boolean;
  } = {},
): Promise<EnvironmentProbeResult> {
  const resolvedCompanyId = options.companyId ?? null;
  const parsed = options.resolvedConfig ?? (
    options.acquireSandboxRuntimeLease === true
      ? parseEnvironmentDriverConfig(environment)
      : resolvedCompanyId || options.applyCustomImageTemplate === true
      ? await resolveEnvironmentDriverConfigForRuntime(db, resolvedCompanyId, environment, {
          applyCustomImageTemplate: options.applyCustomImageTemplate === true,
        })
      : parseEnvironmentDriverConfig(environment)
  );

  if (parsed.driver === "local") {
    return {
      ok: true,
      driver: "local",
      summary: "Local environment is available on this Paperclip host.",
      details: {
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
    };
  }

  if (parsed.driver === "sandbox") {
    if (options.acquireSandboxRuntimeLease) {
      if (!resolvedCompanyId) {
        return {
          ok: false,
          driver: "sandbox",
          summary: "Sandbox environment probe requires a companyId context.",
          details: {
            provider: parsed.config.provider,
          },
        };
      }

      const runtime = environmentRuntimeService(db, {
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const probeEnvironmentConfig = {
        ...environment,
        config: {
          ...(environment.config ?? {}),
          // Test probes should prove a fresh provider boot, not resume a retained
          // agent lease and report success without provider-side activity.
          reuseLease: false,
          // Keep the probe sandbox inspectable in the provider dashboard
          // (archived, provider-side expiry) instead of deleting it the moment
          // the probe finishes.
          archiveOnRelease: true,
        },
      };
      let leaseRecord: Awaited<ReturnType<typeof runtime.acquireRunLease>> | null = null;
      let releaseStatus: "released" | "failed" = "released";
      try {
        leaseRecord = await runtime.acquireRunLease({
          companyId: resolvedCompanyId,
          environment: probeEnvironmentConfig,
          issueId: null,
          agentId: null,
          heartbeatRunId: null,
          persistedExecutionWorkspace: null,
          adapterType: null,
          applyCustomImageTemplate: options.applyCustomImageTemplate === true,
        });
        const metadata = leaseRecord.lease.metadata ?? {};
        const provider = leaseRecord.lease.provider ?? parsed.config.provider;
        const sandboxName = typeof metadata.sandboxName === "string" && metadata.sandboxName.trim().length > 0
          ? metadata.sandboxName.trim()
          : null;
        return {
          ok: true,
          driver: "sandbox",
          summary: sandboxName
            ? `Connected to ${provider} sandbox ${sandboxName}.`
            : `Connected to ${provider} sandbox environment.`,
          details: {
            provider,
            providerLeaseId: leaseRecord.lease.providerLeaseId,
            leaseId: leaseRecord.lease.id,
            leasePolicy: leaseRecord.lease.leasePolicy,
            metadata,
          },
        };
      } catch (error) {
        releaseStatus = "failed";
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox environment probe failed for provider "${parsed.config.provider}".`,
          details: {
            provider: parsed.config.provider,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        if (leaseRecord) {
          const driver = runtime.getDriver(environment.driver);
          try {
            await driver?.releaseRunLease({
              environment: probeEnvironmentConfig,
              lease: leaseRecord.lease,
              status: releaseStatus,
            });
          } catch (releaseError) {
            // Cleanup failures must not mask the connection result shown to
            // the operator, but a leaked sandbox should still be traceable.
            // eslint-disable-next-line no-console
            console.warn(
              `[environment-probe] Failed to release lease ${leaseRecord.lease.id} for provider "${parsed.config.provider}": ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
            );
          }
        }
      }
    }

    if (!isBuiltinSandboxProvider(parsed.config.provider)) {
      if (!options.pluginWorkerManager) {
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox provider "${parsed.config.provider}" requires a running provider plugin.`,
          details: {
            provider: parsed.config.provider,
          },
        };
      }
      return await probePluginSandboxProviderDriver({
        db,
        workerManager: options.pluginWorkerManager,
        companyId: resolvedCompanyId ?? "instance",
        environmentId: environment.id,
        provider: parsed.config.provider,
        config: parsed.config as unknown as Record<string, unknown>,
      });
    }
    return await probeSandboxProvider(parsed.config);
  }

  if (parsed.driver === "plugin") {
    if (!options.pluginWorkerManager) {
      return {
        ok: false,
        driver: "plugin",
        summary: `Plugin environment probes require a plugin worker manager for "${parsed.config.pluginKey}:${parsed.config.driverKey}".`,
        details: {
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      };
    }
    return await probePluginEnvironmentDriver({
      db,
      workerManager: options.pluginWorkerManager,
      companyId: resolvedCompanyId ?? "instance",
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  try {
    const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);

    return {
      ok: true,
      driver: "ssh",
      summary: `Connected to ${parsed.config.username}@${parsed.config.host} and verified the remote workspace path.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        remoteCwd,
      },
    };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    const message =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : String(error)) ||
      "SSH probe failed.";

    return {
      ok: false,
      driver: "ssh",
      summary: `SSH probe failed for ${parsed.config.username}@${parsed.config.host}.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        error: message,
        code,
      },
    };
  }
}
