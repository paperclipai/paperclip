import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  assertSsmCliAvailable,
  buildSsmProxyCommand,
  resolveSsmInstanceByTag,
} from "./aws-ssm.js";

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: { pluginWorkerManager?: PluginWorkerManager; resolvedConfig?: ParsedEnvironmentConfig } = {},
): Promise<EnvironmentProbeResult> {
  const parsed = options.resolvedConfig ?? await resolveEnvironmentDriverConfigForRuntime(db, environment.companyId, environment);

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
        companyId: environment.companyId,
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
      companyId: environment.companyId,
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  if (parsed.driver === "ssm") {
    try {
      await assertSsmCliAvailable();

      const resolved = await resolveSsmInstanceByTag({
        region: parsed.config.region,
        awsProfile: parsed.config.awsProfile,
        tagKey: parsed.config.tagKey,
        tagValue: parsed.config.tagValue,
      });
      const proxyCommand = buildSsmProxyCommand({
        region: parsed.config.region,
        awsProfile: parsed.config.awsProfile,
        instanceId: resolved.instanceId,
      });
      const { remoteCwd } = await ensureSshWorkspaceReady({
        host: resolved.instanceId,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        privateKey: parsed.config.privateKey,
        knownHosts: parsed.config.knownHosts,
        strictHostKeyChecking: parsed.config.strictHostKeyChecking,
        proxyCommand,
      });

      return {
        ok: true,
        driver: "ssm",
        summary: `Connected via SSM to ${resolved.instanceId} (tag ${parsed.config.tagKey}=${parsed.config.tagValue}) and verified the remote workspace path.`,
        details: {
          region: parsed.config.region,
          instanceId: resolved.instanceId,
          tagKey: parsed.config.tagKey,
          tagValue: parsed.config.tagValue,
          username: parsed.config.username,
          port: parsed.config.port,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
          platformType: resolved.platformType,
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
      const message =
        stderr ||
        stdout ||
        (error instanceof Error ? error.message : String(error)) ||
        "SSM probe failed.";
      return {
        ok: false,
        driver: "ssm",
        summary: `SSM probe failed for tag ${parsed.config.tagKey}=${parsed.config.tagValue} in ${parsed.config.region}.`,
        details: {
          region: parsed.config.region,
          tagKey: parsed.config.tagKey,
          tagValue: parsed.config.tagValue,
          username: parsed.config.username,
          port: parsed.config.port,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          error: message,
        },
      };
    }
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
