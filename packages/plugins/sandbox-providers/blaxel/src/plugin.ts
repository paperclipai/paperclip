import { initialize, SandboxInstance } from "@blaxel/core";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

interface BlaxelDriverConfig {
  apiKey: string | null;
  workspace: string | null;
  image: string;
  memory: number;
  region: string | null;
  timeoutMs: number;
  idleTtl: string;
}

function parseDriverConfig(raw: Record<string, unknown>): BlaxelDriverConfig {
  const image =
    typeof raw.image === "string" && raw.image.trim().length > 0
      ? raw.image.trim()
      : "blaxel/base-image:latest";
  const memory = Number(raw.memory ?? 4096);
  const timeoutMs = Number(raw.timeoutMs ?? 300_000);
  return {
    apiKey:
      typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0
        ? raw.apiKey.trim()
        : null,
    workspace:
      typeof raw.workspace === "string" && raw.workspace.trim().length > 0
        ? raw.workspace.trim()
        : null,
    image,
    memory: Number.isFinite(memory) ? Math.trunc(memory) : 4096,
    region:
      typeof raw.region === "string" && raw.region.trim().length > 0
        ? raw.region.trim()
        : null,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 300_000,
    idleTtl:
      typeof raw.idleTtl === "string" && raw.idleTtl.trim().length > 0
        ? raw.idleTtl.trim()
        : "30m",
  };
}

function resolveApiKey(config: BlaxelDriverConfig): string {
  if (config.apiKey) return config.apiKey;
  const envKey = process.env.BL_API_KEY?.trim() ?? "";
  if (!envKey) {
    throw new Error(
      "Blaxel sandbox environments require an API key in config or the BL_API_KEY environment variable.",
    );
  }
  return envKey;
}

function resolveWorkspace(config: BlaxelDriverConfig): string {
  if (config.workspace) return config.workspace;
  const envWorkspace = process.env.BL_WORKSPACE?.trim() ?? "";
  if (!envWorkspace) {
    throw new Error(
      "Blaxel sandbox environments require a workspace in config or the BL_WORKSPACE environment variable.",
    );
  }
  return envWorkspace;
}

function resolveRegion(config: BlaxelDriverConfig): string | null {
  if (config.region) return config.region;
  const envRegion = process.env.BL_REGION?.trim() ?? "";
  return envRegion.length > 0 ? envRegion : null;
}

function initializeSdk(config: BlaxelDriverConfig): void {
  initialize({
    workspace: resolveWorkspace(config),
    apiKey: resolveApiKey(config),
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  if (error != null && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (rec.status === 404 || rec.statusCode === 404 || rec.code === 404) {
      return true;
    }
    if (typeof rec.name === "string" && rec.name.toLowerCase().includes("notfound")) {
      return true;
    }
  }
  const msg = formatErrorMessage(error).toLowerCase();
  return msg.includes("not found") || msg.includes("not_found") || /\b404\b/.test(msg);
}

function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(31, h) + input.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function sandboxName(environmentId: string): string {
  const slug = environmentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `pclip-${slug}-${shortHash(environmentId)}`;
}

async function getOrCreateBlaxelSandbox(
  config: BlaxelDriverConfig,
  environmentId: string,
): Promise<{ sandbox: SandboxInstance; created: boolean }> {
  initializeSdk(config);
  const name = sandboxName(environmentId);

  try {
    const existing = await SandboxInstance.get(name);
    if (existing.status !== "TERMINATED") {
      return { sandbox: existing, created: false };
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const region = resolveRegion(config);
  const sandbox = await SandboxInstance.create(
    {
      name,
      image: config.image,
      memory: config.memory,
      ...(region != null ? { region } : {}),
      lifecycle: {
        expirationPolicies: [
          { type: "ttl-idle", action: "delete", value: config.idleTtl },
        ],
      },
      labels: { "paperclip-provider": "blaxel" },
    },
    { safe: true },
  );
  return { sandbox, created: true };
}

async function connectBlaxelSandbox(
  config: BlaxelDriverConfig,
  providerLeaseId: string,
): Promise<SandboxInstance> {
  initializeSdk(config);
  return await SandboxInstance.get(providerLeaseId);
}

function leaseMetadata(input: {
  config: BlaxelDriverConfig;
  sandbox: SandboxInstance;
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "blaxel",
    shellCommand: "bash",
    image: input.config.image,
    memory: input.config.memory,
    region: input.sandbox.spec?.region ?? resolveRegion(input.config),
    timeoutMs: input.config.timeoutMs,
    idleTtl: input.config.idleTtl,
    sandboxName: input.sandbox.metadata.name,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildCommandLine(command: string, args: string[] = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

async function ensureWorkspaceDir(
  sandbox: SandboxInstance,
  remoteCwd: string,
): Promise<void> {
  const result = await sandbox.process.exec({
    command: `mkdir -p ${shellQuote(remoteCwd)}`,
    waitForCompletion: true,
    timeout: 30,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create workspace directory ${remoteCwd}: ${result.stderr || result.stdout}`,
    );
  }
}

async function resolveWorkingDirectory(
  sandbox: SandboxInstance,
): Promise<string> {
  const result = await sandbox.process.exec({
    command: "pwd",
    waitForCompletion: true,
    timeout: 30,
  });
  const cwd = result.stdout.trim();
  const remoteCwd = `${cwd.length > 0 ? cwd : "/home"}/paperclip-workspace`;
  await ensureWorkspaceDir(sandbox, remoteCwd);
  return remoteCwd;
}

async function deleteBlaxelSandbox(
  sandbox: SandboxInstance,
  reason: string,
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    console.warn(
      `Failed to delete Blaxel sandbox during ${reason}: ${formatErrorMessage(error)}`,
    );
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Blaxel sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Blaxel sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (config.memory < 128 || config.memory > 65_536) {
      errors.push("memory must be between 128 and 65536 MB.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }

    if (!/^\d+[smhd]$/.test(config.idleTtl)) {
      errors.push("idleTtl must be a positive integer followed by a unit (s, m, h, or d), e.g. '30m', '2h', '24h'.");
    }

    try {
      resolveApiKey(config);
    } catch {
      errors.push(
        "Blaxel API key is required. Provide apiKey in config or set BL_API_KEY.",
      );
    }

    try {
      resolveWorkspace(config);
    } catch {
      errors.push(
        "Blaxel workspace is required. Provide workspace in config or set BL_WORKSPACE.",
      );
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      initializeSdk(config);
      const name = sandboxName(params.environmentId);
      let sandbox: SandboxInstance | null = null;
      let freshlyCreated = false;

      try {
        const existing = await SandboxInstance.get(name);
        if (existing.status !== "TERMINATED") {
          sandbox = existing;
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
      if (!sandbox) {
        const region = resolveRegion(config);
        sandbox = await SandboxInstance.create(
          {
            name: `pclip-probe-${Date.now()}`,
            image: config.image,
            memory: config.memory,
            ...(region != null ? { region } : {}),
            lifecycle: {
              expirationPolicies: [
                { type: "ttl-idle", action: "delete", value: "5m" },
              ],
            },
            labels: { "paperclip-provider": "blaxel", "paperclip-probe": "true" },
          },
          { safe: true },
        );
        freshlyCreated = true;
      }

      try {
        const remoteCwd = await resolveWorkingDirectory(sandbox);
        return {
          ok: true,
          summary: `Connected to Blaxel sandbox with image ${config.image}. Snapshot-based scale-to-zero enabled.`,
          metadata: {
            provider: "blaxel",
            image: config.image,
            memory: config.memory,
            region: sandbox.spec?.region,
            timeoutMs: config.timeoutMs,
            idleTtl: config.idleTtl,
            sandboxName: sandbox.metadata.name,
            remoteCwd,
          },
        };
      } finally {
        if (freshlyCreated) {
          await deleteBlaxelSandbox(sandbox, "probe cleanup");
        }
      }
    } catch (error) {
      return {
        ok: false,
        summary: `Blaxel sandbox probe failed for image ${config.image}.`,
        metadata: {
          provider: "blaxel",
          image: config.image,
          memory: config.memory,
          timeoutMs: config.timeoutMs,
          idleTtl: config.idleTtl,
          error: formatErrorMessage(error),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const { sandbox, created } = await getOrCreateBlaxelSandbox(config, params.environmentId);
    try {
      const remoteCwd = await resolveWorkingDirectory(sandbox);
      const sandboxId = sandbox.metadata.name;
      if (!sandboxId) {
        throw new Error("Blaxel sandbox was created without a name — cannot track lease.");
      }
      return {
        providerLeaseId: sandboxId,
        metadata: leaseMetadata({
          config,
          sandbox,
          remoteCwd,
          resumedLease: false,
        }),
      };
    } catch (error) {
      if (created) {
        await deleteBlaxelSandbox(sandbox, "lease acquire cleanup");
      }
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await connectBlaxelSandbox(
        config,
        params.providerLeaseId,
      );

      if (sandbox.status === "TERMINATED") {
        return { providerLeaseId: null, metadata: { expired: true } };
      }

      // Blaxel sandboxes resume from snapshot automatically on reconnect.
      // No explicit "unpause" needed — the platform wakes the microVM in ~25ms.
      const remoteCwd = await resolveWorkingDirectory(sandbox);
      const sandboxId = sandbox.metadata.name;
      if (!sandboxId) {
        throw new Error("Blaxel sandbox has no name — cannot track lease.");
      }
      return {
        providerLeaseId: sandboxId,
        metadata: leaseMetadata({
          config,
          sandbox,
          remoteCwd,
          resumedLease: true,
        }),
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    // Blaxel sandboxes use snapshot-based scale-to-zero: when idle they
    // automatically hibernate and snapshot their memory + filesystem state.
    // On next use they resume from snapshot in ~25ms — no explicit pause needed.
    // The idle TTL configured at creation handles automatic cleanup.
    // We intentionally do NOT delete the sandbox here so it can be resumed.
    if (!params.providerLeaseId) return;
    // No-op: sandbox stays alive; Blaxel's scale-to-zero handles hibernation.
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    try {
      initializeSdk(config);
      await SandboxInstance.delete(params.providerLeaseId);
    } catch (error) {
      console.warn(
        `Failed to delete Blaxel sandbox during lease destroy: ${formatErrorMessage(error)}`,
      );
    }
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" &&
      params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ??
          params.workspace.localPath ??
          "/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const sandbox = await connectBlaxelSandbox(
        config,
        params.lease.providerLeaseId,
      );
      await ensureWorkspaceDir(sandbox, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "blaxel",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const sandbox = await connectBlaxelSandbox(
      config,
      params.lease.providerLeaseId,
    );

    const command = buildCommandLine(params.command, params.args);
    const timeoutSec = Math.max(
      1,
      Math.ceil((params.timeoutMs ?? config.timeoutMs) / 1000),
    );

    try {
      const result = await sandbox.process.exec({
        command,
        workingDir: params.cwd,
        env: params.env,
        waitForCompletion: true,
        timeout: timeoutSec,
      });

      return {
        exitCode: result.exitCode ?? 0,
        timedOut: false,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      const message = formatErrorMessage(error);
      const lower = message.toLowerCase();
      if (
        lower.includes("timeout") ||
        lower.includes("timed out") ||
        lower.includes("etimedout") ||
        lower.includes("deadline exceeded")
      ) {
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: message,
        };
      }
      throw error;
    }
  },
});

export default plugin;
