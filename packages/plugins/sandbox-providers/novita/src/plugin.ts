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
import { Sandbox } from "novita-sandbox";

export interface NovitaDriverConfig {
  apiKey: string | null;
  domain: string | null;
  template: string | null;
  requestedCwd: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  secure: boolean | null;
  autoPause: boolean;
  reuseLease: boolean;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function parseNovitaDriverConfig(raw: Record<string, unknown>): NovitaDriverConfig {
  return {
    apiKey: parseOptionalString(raw.apiKey),
    domain: parseOptionalString(raw.domain),
    template: parseOptionalString(raw.template),
    requestedCwd: parseOptionalString(raw.requestedCwd) ?? "/home/user/paperclip-workspace",
    timeoutMs: parsePositiveInteger(raw.timeoutMs, 300_000),
    requestTimeoutMs: parsePositiveInteger(raw.requestTimeoutMs, 30_000),
    secure: typeof raw.secure === "boolean" ? raw.secure : null,
    autoPause: raw.autoPause === true,
    reuseLease: raw.reuseLease === true,
  };
}

function validateNovitaDriverConfig(config: NovitaDriverConfig): string[] {
  const errors: string[] = [];
  if (!config.apiKey && !process.env.NOVITA_API_KEY?.trim()) {
    errors.push("Novita sandbox environments require an API key in config or NOVITA_API_KEY.");
  }
  if (!config.requestedCwd.startsWith("/")) {
    errors.push("requestedCwd must be an absolute path.");
  }
  if (config.timeoutMs < 10_000) {
    errors.push("timeoutMs must be at least 10000.");
  }
  if (config.requestTimeoutMs < 1_000) {
    errors.push("requestTimeoutMs must be at least 1000.");
  }
  return errors;
}

function resolveApiKey(config: NovitaDriverConfig): string {
  const apiKey = config.apiKey ?? process.env.NOVITA_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("Novita sandbox environments require an API key in config or NOVITA_API_KEY.");
  }
  return apiKey;
}

function sandboxOpts(config: NovitaDriverConfig) {
  return {
    apiKey: resolveApiKey(config),
    ...(config.domain ? { domain: config.domain } : {}),
    ...(config.secure == null ? {} : { secure: config.secure }),
    timeoutMs: config.timeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function buildStdinToken(stdin: string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = `PAPERCLIP_STDIN_${Math.random().toString(36).slice(2, 14).toUpperCase()}`;
    if (!stdin.split(/\r?\n/).includes(token)) {
      return token;
    }
  }
  throw new Error("Could not create a safe stdin heredoc delimiter.");
}

export function buildShellCommand(input: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}): string {
  const envEntries = Object.entries(input.env ?? {});
  for (const [key] of envEntries) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }

  const exports = envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)};`);
  const argv = [input.command, ...(input.args ?? [])].map(shellQuote).join(" ");
  const stdinToken = typeof input.stdin === "string" ? buildStdinToken(input.stdin) : null;
  const stdin =
    stdinToken
      ? `cat > /tmp/.paperclip-stdin <<'${stdinToken}'\n${input.stdin}\n${stdinToken}\n`
      : "";
  const stdinRedirect = typeof input.stdin === "string" ? " < /tmp/.paperclip-stdin" : "";
  const cwd = input.cwd?.trim() || "/";
  return [
    "set -e",
    stdin,
    `cd ${shellQuote(cwd)}`,
    ...exports,
    `exec ${argv}${stdinRedirect}`,
  ].filter(Boolean).join("\n");
}

async function createSandbox(params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentProbeParams, config: NovitaDriverConfig) {
  const metadata = {
    "paperclip-provider": "novita",
    "paperclip-company-id": params.companyId,
    "paperclip-environment-id": params.environmentId,
    ...(params.issueId ? { "paperclip-issue-id": params.issueId } : {}),
    ...("runId" in params ? { "paperclip-run-id": params.runId } : {}),
  };
  const opts = {
    ...sandboxOpts(config),
    metadata,
    autoPause: config.autoPause,
  };
  return config.template
    ? await Sandbox.create(config.template, opts)
    : await Sandbox.create(opts);
}

async function connectSandbox(config: NovitaDriverConfig, sandboxId: string) {
  return await Sandbox.connect(sandboxId, sandboxOpts(config));
}

async function getSandboxOrNull(config: NovitaDriverConfig, sandboxId: string) {
  try {
    return await connectSandbox(config, sandboxId);
  } catch {
    return null;
  }
}

async function detectShellCommand(sandbox: Sandbox, config: NovitaDriverConfig): Promise<"bash" | "sh"> {
  try {
    const result = await sandbox.commands.run(
      "if command -v bash >/dev/null 2>&1; then printf bash; else printf sh; fi",
      { cwd: "/", timeoutMs: config.requestTimeoutMs },
    );
    return result.stdout.trim() === "bash" ? "bash" : "sh";
  } catch {
    return "sh";
  }
}

async function ensureWorkspace(sandbox: Sandbox, remoteCwd: string, config: NovitaDriverConfig) {
  await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`, {
    cwd: "/",
    timeoutMs: config.requestTimeoutMs,
  });
}

function leaseMetadata(input: {
  config: NovitaDriverConfig;
  sandbox: Sandbox;
  shellCommand: "bash" | "sh";
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "novita",
    shellCommand: input.shellCommand,
    sandboxId: input.sandbox.sandboxId,
    template: input.config.template,
    timeoutMs: input.config.timeoutMs,
    requestTimeoutMs: input.config.requestTimeoutMs,
    autoPause: input.config.autoPause,
    reuseLease: input.config.reuseLease,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

async function releaseSandbox(config: NovitaDriverConfig, sandboxId: string) {
  const sandbox = await getSandboxOrNull(config, sandboxId);
  if (!sandbox) return;
  if (config.reuseLease) {
    await sandbox.betaPause({ requestTimeoutMs: config.requestTimeoutMs }).catch(async () => {
      await sandbox.kill({ requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
    });
    return;
  }
  await sandbox.kill({ requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
}

async function executeInSandbox(
  sandbox: Sandbox,
  params: PluginEnvironmentExecuteParams,
  config: NovitaDriverConfig,
): Promise<PluginEnvironmentExecuteResult> {
  const command = buildShellCommand({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    stdin: params.stdin,
  });
  try {
    const result = await sandbox.commands.run(command, {
      cwd: "/",
      timeoutMs: params.timeoutMs ?? config.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
      metadata: {
        provider: "novita",
        sandboxId: sandbox.sandboxId,
      },
    };
  } catch (error) {
    const commandError = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      error?: string;
      timedOut?: boolean;
    };
    if (typeof commandError.exitCode === "number" || commandError.timedOut === true) {
      return {
        exitCode: commandError.exitCode ?? 124,
        signal: null,
        timedOut: commandError.timedOut === true,
        stdout: commandError.stdout ?? "",
        stderr: commandError.stderr ?? commandError.error ?? "",
        metadata: {
          provider: "novita",
          sandboxId: sandbox.sandboxId,
        },
      };
    }
    throw error;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Novita sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Novita sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseNovitaDriverConfig(params.config);
    const errors = validateNovitaDriverConfig(config);
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
    const config = parseNovitaDriverConfig(params.config);
    try {
      const sandbox = await createSandbox(params, config);
      try {
        await ensureWorkspace(sandbox, config.requestedCwd, config);
        const shellCommand = await detectShellCommand(sandbox, config);
        return {
          ok: true,
          summary: `Connected to Novita sandbox ${sandbox.sandboxId}.`,
          metadata: leaseMetadata({
            config,
            sandbox,
            shellCommand,
            remoteCwd: config.requestedCwd,
            resumedLease: false,
          }),
        };
      } finally {
        await sandbox.kill({ requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        summary: "Novita sandbox probe failed.",
        metadata: {
          provider: "novita",
          template: config.template,
          timeoutMs: config.timeoutMs,
          requestTimeoutMs: config.requestTimeoutMs,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseNovitaDriverConfig(params.config);
    const sandbox = await createSandbox(params, config);
    try {
      const remoteCwd = params.requestedCwd?.trim() || config.requestedCwd;
      await ensureWorkspace(sandbox, remoteCwd, config);
      const shellCommand = await detectShellCommand(sandbox, config);
      return {
        providerLeaseId: sandbox.sandboxId,
        metadata: leaseMetadata({
          config,
          sandbox,
          shellCommand,
          remoteCwd,
          resumedLease: false,
        }),
      };
    } catch (error) {
      await sandbox.kill({ requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseNovitaDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) {
      return {
        providerLeaseId: null,
        metadata: {
          provider: "novita",
          expired: true,
        },
      };
    }
    await sandbox.setTimeout(config.timeoutMs, { requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
    const remoteCwd =
      typeof params.leaseMetadata?.remoteCwd === "string" && params.leaseMetadata.remoteCwd.trim().length > 0
        ? params.leaseMetadata.remoteCwd.trim()
        : config.requestedCwd;
    await ensureWorkspace(sandbox, remoteCwd, config);
    const shellCommand = await detectShellCommand(sandbox, config);
    return {
      providerLeaseId: sandbox.sandboxId,
      metadata: leaseMetadata({
        config,
        sandbox,
        shellCommand,
        remoteCwd,
        resumedLease: true,
      }),
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseNovitaDriverConfig(params.config);
    await releaseSandbox(config, params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseNovitaDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    await sandbox?.kill({ requestTimeoutMs: config.requestTimeoutMs }).catch(() => undefined);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseNovitaDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" && params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ?? params.workspace.localPath ?? config.requestedCwd;

    if (params.lease.providerLeaseId) {
      const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
      await ensureWorkspace(sandbox, remoteCwd, config);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "novita",
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
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.\n",
      };
    }
    const config = parseNovitaDriverConfig(params.config);
    const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
    return await executeInSandbox(sandbox, params, config);
  },
});

export default plugin;
