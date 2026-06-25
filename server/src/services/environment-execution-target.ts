import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
  type K8sRemoteSpec,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { secretService } from "./secrets.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";
export const DEFAULT_K8S_REMOTE_CWD = "/workspace";

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
    if (
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "codex_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
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
            supportsSingleStreamStdinProgress: false,
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

  if (input.environment.driver === "k8s") {
    if (input.adapterType !== "claude_k8s" && input.adapterType !== "opencode_k8s") {
      return null;
    }

    const config = parseObject(input.environment.config);

    const kubeconfigSecretRef =
      typeof config.kubeconfigSecretRef === "string" && config.kubeconfigSecretRef.trim().length > 0
        ? config.kubeconfigSecretRef.trim()
        : null;
    const kubeconfig: string | null = kubeconfigSecretRef
      ? await secretService(input.db).resolveSecretValue(input.companyId, kubeconfigSecretRef, "latest")
      : null;

    const imagePullPolicy: K8sRemoteSpec["imagePullPolicy"] =
      config.imagePullPolicy === "Always" ||
      config.imagePullPolicy === "IfNotPresent" ||
      config.imagePullPolicy === "Never"
        ? config.imagePullPolicy
        : null;

    const k8sConfig: K8sRemoteSpec = {
      kubeconfig,
      namespace: typeof config.namespace === "string" ? config.namespace : null,
      workspaceVolumeClaim:
        typeof config.workspaceVolumeClaim === "string" ? config.workspaceVolumeClaim : null,
      workspaceMountPath:
        typeof config.workspaceMountPath === "string" ? config.workspaceMountPath : null,
      secretsNamespace: typeof config.secretsNamespace === "string" ? config.secretsNamespace : null,
      nodeSelector: isStringRecord(config.nodeSelector) ? config.nodeSelector : {},
      tolerations: Array.isArray(config.tolerations)
        ? (config.tolerations as K8sRemoteSpec["tolerations"])
        : [],
      labels: isStringRecord(config.labels) ? config.labels : {},
      serviceAccountName:
        typeof config.serviceAccountName === "string" ? config.serviceAccountName : null,
      imagePullPolicy,
      resources: isPlainObject(config.resources)
        ? (config.resources as K8sRemoteSpec["resources"])
        : null,
      providers: isPlainObject(config.providers)
        ? (config.providers as K8sRemoteSpec["providers"])
        : undefined,
    };

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : k8sConfig.workspaceMountPath ?? DEFAULT_K8S_REMOTE_CWD;

    return {
      kind: "remote",
      transport: "k8s",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      remoteCwd,
      paperclipApiUrl:
        typeof input.leaseMetadata?.paperclipApiUrl === "string" && input.leaseMetadata.paperclipApiUrl.trim().length > 0
          ? input.leaseMetadata.paperclipApiUrl.trim()
          : null,
      config: k8sConfig,
    };
  }

  if (
    (
      input.adapterType !== "codex_local" &&
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    id: input.environment.id,
    driver: input.environment.driver as "ssh",
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

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
