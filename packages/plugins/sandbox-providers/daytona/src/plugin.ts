import path from "node:path";
import { randomUUID } from "node:crypto";
import { Daytona, DaytonaNotFoundError, DaytonaTimeoutError } from "@daytonaio/sdk";
import type {
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  DaytonaConfig,
  Resources,
  Sandbox,
} from "@daytonaio/sdk";
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

interface DaytonaDriverConfig {
  apiKey: string | null;
  apiUrl: string | null;
  target: string | null;
  snapshot: string | null;
  image: string | null;
  language: string | null;
  timeoutMs: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu: number | null;
  autoStopInterval: number | null;
  autoArchiveInterval: number | null;
  autoDeleteInterval: number | null;
  reuseLease: boolean;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDriverConfig(raw: Record<string, unknown>): DaytonaDriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? 300_000);
  return {
    apiKey: parseOptionalString(raw.apiKey),
    apiUrl: parseOptionalString(raw.apiUrl),
    target: parseOptionalString(raw.target),
    snapshot: parseOptionalString(raw.snapshot),
    image: parseOptionalString(raw.image),
    language: parseOptionalString(raw.language),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 300_000,
    cpu: parseOptionalNumber(raw.cpu),
    memory: parseOptionalNumber(raw.memory),
    disk: parseOptionalNumber(raw.disk),
    gpu: parseOptionalNumber(raw.gpu),
    autoStopInterval: parseOptionalInteger(raw.autoStopInterval),
    autoArchiveInterval: parseOptionalInteger(raw.autoArchiveInterval),
    autoDeleteInterval: parseOptionalInteger(raw.autoDeleteInterval),
    reuseLease: raw.reuseLease === true,
  };
}

function resolveApiKey(config: DaytonaDriverConfig): string {
  if (config.apiKey) {
    return config.apiKey;
  }
  const envApiKey = process.env.DAYTONA_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("Daytona sandbox environments require an API key in config or DAYTONA_API_KEY.");
  }
  return envApiKey;
}

function createDaytonaClient(config: DaytonaDriverConfig): Daytona {
  const clientConfig: DaytonaConfig = {
    apiKey: resolveApiKey(config),
  };
  if (config.apiUrl) clientConfig.apiUrl = config.apiUrl;
  if (config.target) clientConfig.target = config.target;
  return new Daytona(clientConfig);
}

function buildResources(config: DaytonaDriverConfig): Resources | undefined {
  if (config.cpu == null && config.memory == null && config.disk == null && config.gpu == null) {
    return undefined;
  }
  return {
    cpu: config.cpu ?? undefined,
    memory: config.memory ?? undefined,
    disk: config.disk ?? undefined,
    gpu: config.gpu ?? undefined,
  };
}

function buildCreateParams(
  config: DaytonaDriverConfig,
  labels: Record<string, string>,
): CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams {
  const base: CreateSandboxBaseParams = {
    labels,
    language: config.language ?? undefined,
    autoStopInterval: config.autoStopInterval ?? undefined,
    autoArchiveInterval: config.autoArchiveInterval ?? undefined,
    autoDeleteInterval: config.autoDeleteInterval ?? undefined,
  };
  if (config.image) {
    return {
      ...base,
      image: config.image,
      resources: buildResources(config),
    };
  }
  return {
    ...base,
    snapshot: config.snapshot ?? undefined,
  };
}

function buildSandboxLabels(input: {
  companyId: string;
  environmentId: string;
  runId?: string;
  reuseLease: boolean;
}): Record<string, string> {
  return {
    "paperclip-provider": "daytona",
    "paperclip-company-id": input.companyId,
    "paperclip-environment-id": input.environmentId,
    "paperclip-reuse-lease": input.reuseLease ? "true" : "false",
    ...(input.runId ? { "paperclip-run-id": input.runId } : {}),
  };
}

function toTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function resolveTimeoutMs(paramsTimeoutMs: number | undefined, config: DaytonaDriverConfig): number {
  return paramsTimeoutMs != null && Number.isFinite(paramsTimeoutMs) && paramsTimeoutMs > 0
    ? Math.trunc(paramsTimeoutMs)
    : config.timeoutMs;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

async function ensureSandboxStarted(sandbox: Sandbox, timeoutSeconds: number): Promise<void> {
  if (sandbox.state === "started") return;
  if (sandbox.state === "error") {
    if (sandbox.recoverable) {
      await sandbox.recover(timeoutSeconds);
      return;
    }
    throw new Error(`Daytona sandbox ${sandbox.id} is in an unrecoverable error state: ${sandbox.errorReason ?? "unknown error"}`);
  }
  await sandbox.start(timeoutSeconds);
}

async function resolveSandboxWorkingDirectory(sandbox: Sandbox): Promise<string> {
  const root = (await sandbox.getWorkDir())?.trim()
    || (await sandbox.getUserHomeDir())?.trim()
    || "/home/daytona";
  const remoteCwd = path.posix.join(root, "paperclip-workspace");
  await sandbox.fs.createFolder(remoteCwd, "755");
  return remoteCwd;
}

async function detectSandboxShellCommand(sandbox: Sandbox, timeoutSeconds: number): Promise<"bash" | "sh"> {
  try {
    const result = await sandbox.process.executeCommand(
      "if command -v bash >/dev/null 2>&1; then printf bash; else printf sh; fi",
      undefined,
      undefined,
      timeoutSeconds,
    );
    return result.result?.trim() === "bash" ? "bash" : "sh";
  } catch {
    return "sh";
  }
}

function leaseMetadata(input: {
  config: DaytonaDriverConfig;
  sandbox: Sandbox;
  shellCommand: "bash" | "sh";
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "daytona",
    shellCommand: input.shellCommand,
    sandboxId: input.sandbox.id,
    sandboxName: input.sandbox.name,
    sandboxState: input.sandbox.state ?? null,
    image: input.config.image,
    snapshot: input.config.snapshot,
    target: input.sandbox.target,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Mirror the E2B sandbox executor: source common login profiles (and nvm)
// before running the command so Daytona one-shot calls see the same PATH an
// interactive shell would. Without this, adapter probes can fail to resolve
// CLIs that are installed via profile-driven PATH mutations inside the
// sandbox image.
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinPath?: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const redirectedCommand = input.stdinPath
    ? `${commandParts} < ${shellQuote(input.stdinPath)}`
    : commandParts;
  // Each `executeCommand` call runs in its own shell, so we don't `exec`-
  // replace it; running the command as the last `&&`-chained line is enough to
  // surface the right exit code. Env is interpolated after profile sourcing so
  // the caller's env wins over any defaults the profile exports.
  const finalLine = envArgs.length > 0
    ? `env ${envArgs.join(" ")} ${redirectedCommand}`
    : redirectedCommand;
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists to avoid double-running setup.
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(finalLine);
  return lines.join(" && ");
}

async function createSandbox(
  params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentProbeParams,
  config: DaytonaDriverConfig,
): Promise<Sandbox> {
  const client = createDaytonaClient(config);
  const createParams = buildCreateParams(config, buildSandboxLabels({
    companyId: params.companyId,
    environmentId: params.environmentId,
    runId: "runId" in params ? params.runId : undefined,
    reuseLease: config.reuseLease,
  }));
  return await client.create(createParams, {
    timeout: toTimeoutSeconds(config.timeoutMs),
  });
}

async function getSandbox(config: DaytonaDriverConfig, sandboxId: string): Promise<Sandbox> {
  const client = createDaytonaClient(config);
  return await client.get(sandboxId);
}

async function getSandboxOrNull(config: DaytonaDriverConfig, sandboxId: string): Promise<Sandbox | null> {
  try {
    return await getSandbox(config, sandboxId);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      return null;
    }
    throw error;
  }
}

// One-shot command execution via Daytona's `process.executeCommand`. The
// session-based API (`createSession` + `executeSessionCommand` with
// `runAsync: false`) hangs indefinitely when the supplied command ends with
// `exec <something>`, which `buildLoginShellScript` always produces. Reproduced
// directly against the Daytona SDK: identical login-shell wrapper returns in
// ~600 ms via `executeCommand` but times out via `executeSessionCommand`. So we
// use the one-shot path, mirroring e2b's `sandbox.commands.run` model.
//
// `executeCommand` returns combined stdout+stderr in `result`. We surface that
// as `stdout` and leave `stderr` empty; callers that grep for error messages
// still see them in `stdout`.
async function executeOneShot(
  sandbox: Sandbox,
  params: PluginEnvironmentExecuteParams,
  config: DaytonaDriverConfig,
): Promise<PluginEnvironmentExecuteResult> {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs, config);
  const timeoutSeconds = toTimeoutSeconds(timeoutMs);
  const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;

  try {
    if (stdinPath) {
      await sandbox.fs.uploadFile(Buffer.from(params.stdin ?? "", "utf8"), stdinPath, timeoutSeconds);
    }

    const command = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinPath: stdinPath ?? undefined,
    });

    // Pass cwd undefined: `buildLoginShellScript` already injects `cd` after
    // profile sourcing when params.cwd is set, and the Daytona executor's own
    // cwd argument runs before our login-shell init, which is the wrong order
    // (env from .bashrc would override caller env).
    const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);

    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      timedOut: false,
      stdout: result.result ?? result.artifacts?.stdout ?? "",
      stderr: "",
    };
  } catch (error) {
    if (error instanceof DaytonaTimeoutError) {
      return {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: `${error.message.trim()}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinPath) {
      await sandbox.fs.deleteFile(stdinPath).catch(() => undefined);
    }
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Daytona sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Daytona sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (typeof params.config.image === "string" && params.config.image.trim().length === 0) {
      errors.push("Daytona image cannot be empty.");
    }
    if (typeof params.config.snapshot === "string" && params.config.snapshot.trim().length === 0) {
      errors.push("Daytona snapshot cannot be empty.");
    }
    if (config.image && config.snapshot) {
      errors.push("Daytona sandbox environments must set either image or snapshot, not both.");
    }
    if (config.apiUrl && !isValidUrl(config.apiUrl)) {
      errors.push("apiUrl must be a valid URL.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }
    if (config.autoStopInterval != null && config.autoStopInterval < 0) {
      errors.push("autoStopInterval must be greater than or equal to 0.");
    }
    if (config.autoArchiveInterval != null && config.autoArchiveInterval < 0) {
      errors.push("autoArchiveInterval must be greater than or equal to 0.");
    }
    if (config.autoDeleteInterval != null && config.autoDeleteInterval < -1) {
      errors.push("autoDeleteInterval must be greater than or equal to -1.");
    }
    if (!config.apiKey && !(process.env.DAYTONA_API_KEY?.trim())) {
      errors.push("Daytona sandbox environments require an API key in config or DAYTONA_API_KEY.");
    }
    for (const [key, value] of Object.entries({
      cpu: config.cpu,
      memory: config.memory,
      disk: config.disk,
      gpu: config.gpu,
    })) {
      if (value != null && value <= 0) {
        errors.push(`${key} must be greater than 0 when provided.`);
      }
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
      const sandbox = await createSandbox(params, config);
      try {
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
        const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
        return {
          ok: true,
          summary: `Connected to Daytona sandbox ${sandbox.name}.`,
          metadata: {
            provider: "daytona",
            shellCommand,
            sandboxId: sandbox.id,
            sandboxName: sandbox.name,
            target: sandbox.target,
            image: config.image,
            snapshot: config.snapshot,
            timeoutMs: config.timeoutMs,
            reuseLease: config.reuseLease,
            remoteCwd,
          },
        };
      } finally {
        await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        summary: "Daytona sandbox probe failed.",
        metadata: {
          provider: "daytona",
          image: config.image,
          snapshot: config.snapshot,
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await createSandbox(params, config);
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }

    await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: true }),
      };
    } catch (error) {
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) return;

    if (config.reuseLease) {
      if (sandbox.state !== "stopped") {
        try {
          await sandbox.stop(toTimeoutSeconds(config.timeoutMs));
        } catch (error) {
          console.warn(
            `Failed to stop Daytona sandbox during lease release: ${formatErrorMessage(error)}. Attempting delete instead.`,
          );
          await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch((deleteError) => {
            console.warn(
              `Failed to delete Daytona sandbox after stop failure: ${formatErrorMessage(deleteError)}`,
            );
          });
        }
      }
      return;
    }

    await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) return;
    await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" &&
      params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ?? params.workspace.localPath ?? "/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const sandbox = await getSandbox(config, params.lease.providerLeaseId);
      await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
      await sandbox.fs.createFolder(remoteCwd, "755");
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "daytona",
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
    const sandbox = await getSandbox(config, params.lease.providerLeaseId);
    await ensureSandboxStarted(sandbox, toTimeoutSeconds(resolveTimeoutMs(params.timeoutMs, config)));
    return await executeOneShot(sandbox, params, config);
  },
});

export default plugin;
