import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { buildSsmProxyCommand, resolveSsmInstanceByTag } from "./aws-ssm.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

// Adapter types that know how to dispatch through AdapterExecutionTarget for
// remote drivers (ssh, ssm, sandbox). Kept as a single source of truth so the
// list does not drift between branches.
const REMOTE_CAPABLE_ADAPTER_TYPES = new Set([
  "acpx_local",
  "codex_local",
  "claude_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    if (!REMOTE_CAPABLE_ADAPTER_TYPES.has(input.adapterType)) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      runner: input.environmentRuntime && input.lease
        ? {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          }
        : undefined,
    };
  }

  if (!REMOTE_CAPABLE_ADAPTER_TYPES.has(input.adapterType)) {
    return null;
  }

  if (input.environment.driver === "ssh") {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: "ssh",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "ssh") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : parsed.config.remoteWorkspacePath;

    return {
      kind: "remote",
      transport: "ssh",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      remoteCwd,
      spec: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        privateKey: parsed.config.privateKey,
        knownHosts: parsed.config.knownHosts,
        strictHostKeyChecking: parsed.config.strictHostKeyChecking,
        remoteCwd,
      },
    };
  }

  if (input.environment.driver === "ssm") {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: "ssm",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "ssm") {
      return null;
    }

    // The lease metadata may already carry a resolved instanceId from acquire
    // time. Prefer it so a single agent run pins to the same host even if the
    // tag fleet changes mid-run; otherwise re-resolve now.
    const cachedInstanceId =
      typeof input.leaseMetadata?.instanceId === "string" && input.leaseMetadata.instanceId.trim().length > 0
        ? input.leaseMetadata.instanceId.trim()
        : null;
    const instanceId =
      cachedInstanceId ??
      (await resolveSsmInstanceByTag({
        region: parsed.config.region,
        awsProfile: parsed.config.awsProfile,
        tagKey: parsed.config.tagKey,
        tagValue: parsed.config.tagValue,
      })).instanceId;

    const proxyCommand = buildSsmProxyCommand({
      region: parsed.config.region,
      awsProfile: parsed.config.awsProfile,
      instanceId,
    });

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : parsed.config.remoteWorkspacePath;

    return {
      kind: "remote",
      transport: "ssh",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      remoteCwd,
      spec: {
        host: instanceId,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        privateKey: parsed.config.privateKey,
        knownHosts: parsed.config.knownHosts,
        strictHostKeyChecking: parsed.config.strictHostKeyChecking,
        remoteCwd,
        proxyCommand,
      },
    };
  }

  return null;
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
