import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentStartInteractiveSetupParams,
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

type WorkspaceSentinelResult = {
  path: string;
  token: string | null;
  result: "written" | "matched" | "missing" | "mismatch" | "skipped";
};

type DaytonaSshAccess = {
  token?: string | null;
  command?: string | null;
  sshCommand?: string | null;
  expiresAt?: string | null;
};

type DaytonaInteractiveSandbox = Sandbox & {
  createSshAccess?: (expiresInMinutes?: number) => Promise<DaytonaSshAccess>;
  _experimental_createSnapshot?: (name: string, timeout?: number) => Promise<void>;
};

type DaytonaSnapshotService = {
  get?: (name: string) => Promise<unknown>;
  delete?: (snapshot: unknown) => Promise<void>;
};

const WORKSPACE_SENTINEL_RELATIVE_PATH = ".paperclip-runtime/reusable-sandbox-lease.json";

// Quota-safety defaults (minutes). Daytona counts *stopped* sandboxes against
// the storage quota; only *archived* sandboxes move to cold object storage and
// stop counting. Without these, stopped/leaked sandboxes accumulate until the
// org quota fills. We apply sane defaults so every sandbox eventually leaves the
// quota on its own even when our own cleanup fails or never runs (crashed runs,
// failed lease destroys, orphaned probes). All three stay overridable per
// environment; an explicit 0/-1 in config is preserved.
//
// - autoStop: stop idle *running* sandboxes (frees CPU/RAM, starts the archive clock).
// - autoArchive: archive *stopped* sandboxes so they leave the disk quota.
// - autoDelete: backstop reaper for sandboxes nobody resumes.
const DEFAULT_AUTO_STOP_INTERVAL_MINUTES = 15;
const DEFAULT_AUTO_ARCHIVE_INTERVAL_MINUTES = 60;
const DEFAULT_AUTO_DELETE_INTERVAL_MINUTES = 7 * 24 * 60; // 7 days
const DEFAULT_SSH_ACCESS_MINUTES = 60;
const DAYTONA_SSH_GATEWAY_HOST = "ssh.app.daytona.io";

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
    autoStopInterval: parseOptionalInteger(raw.autoStopInterval) ?? DEFAULT_AUTO_STOP_INTERVAL_MINUTES,
    autoArchiveInterval: parseOptionalInteger(raw.autoArchiveInterval) ?? DEFAULT_AUTO_ARCHIVE_INTERVAL_MINUTES,
    autoDeleteInterval: parseOptionalInteger(raw.autoDeleteInterval) ?? DEFAULT_AUTO_DELETE_INTERVAL_MINUTES,
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

function hasResourceRequest(config: DaytonaDriverConfig): boolean {
  return config.cpu != null || config.memory != null || config.disk != null || config.gpu != null;
}

function validateResourceRequest(config: DaytonaDriverConfig): string | null {
  if (!hasResourceRequest(config) || config.image) return null;
  return "Daytona resource settings require image-backed sandbox creation; snapshot/default sandbox creation cannot override CPU, memory, disk, or GPU.";
}

function validateRuntimeResourceRequest(config: DaytonaDriverConfig): string | null {
  // A snapshot bakes in its own resource allocation, so resources are dropped at
  // create time (see buildCreateParams) rather than failing the run when a custom
  // image snapshot is layered over a base config that carries CPU/memory/disk/GPU.
  if (!hasResourceRequest(config) || config.image || config.snapshot) return null;
  return "Daytona resource settings require image-backed sandbox creation; default sandbox creation cannot override CPU, memory, disk, or GPU.";
}

function buildSandboxLabels(input: {
  companyId: string;
  environmentId: string;
  runId?: string;
  setupSessionId?: string;
  purpose?: string;
  reuseLease: boolean;
}): Record<string, string> {
  return {
    "paperclip-provider": "daytona",
    "paperclip-company-id": input.companyId,
    "paperclip-environment-id": input.environmentId,
    "paperclip-reuse-lease": input.reuseLease ? "true" : "false",
    ...(input.runId ? { "paperclip-run-id": input.runId } : {}),
    ...(input.setupSessionId ? { "paperclip-setup-session-id": input.setupSessionId } : {}),
    ...(input.purpose ? { "paperclip-purpose": input.purpose } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

function workspaceSentinelToken(input: {
  params: Pick<PluginEnvironmentAcquireLeaseParams, "companyId" | "environmentId" | "agentId" | "executionWorkspaceId" | "adapterType">;
  config: DaytonaDriverConfig;
}): string | null {
  if (!input.config.reuseLease || !input.params.agentId || !input.params.executionWorkspaceId) {
    return null;
  }
  return createHash("sha256")
    .update(stableStringify({
      provider: "daytona",
      companyId: input.params.companyId,
      environmentId: input.params.environmentId,
      agentId: input.params.agentId,
      executionWorkspaceId: input.params.executionWorkspaceId,
      adapterType: input.params.adapterType ?? null,
      image: input.config.image,
      snapshot: input.config.snapshot,
      target: input.config.target,
      // Include resource-shaping inputs so changing the requested allocation
      // expires old reusable leases and forces a fresh sandbox instead of
      // reusing a previously provisioned (e.g. one-CPU) sandbox.
      cpu: input.config.cpu,
      memory: input.config.memory,
      disk: input.config.disk,
      gpu: input.config.gpu,
    }))
    .digest("hex");
}

function workspaceSentinelPath(remoteCwd: string): string {
  return path.posix.join(remoteCwd, WORKSPACE_SENTINEL_RELATIVE_PATH);
}

async function writeWorkspaceSentinel(input: {
  sandbox: Sandbox;
  remoteCwd: string;
  params: PluginEnvironmentAcquireLeaseParams;
  config: DaytonaDriverConfig;
  timeoutSeconds: number;
}): Promise<WorkspaceSentinelResult> {
  const sentinelPath = workspaceSentinelPath(input.remoteCwd);
  const token = workspaceSentinelToken({ params: input.params, config: input.config });
  if (!token) {
    return { path: sentinelPath, token: null, result: "skipped" };
  }
  await input.sandbox.fs.createFolder(path.posix.dirname(sentinelPath), "755");
  await input.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify({
      version: 1,
      token,
      companyId: input.params.companyId,
      environmentId: input.params.environmentId,
      agentId: input.params.agentId,
      executionWorkspaceId: input.params.executionWorkspaceId,
      adapterType: input.params.adapterType ?? null,
      provider: "daytona",
      writtenAt: new Date().toISOString(),
    }, null, 2), "utf8"),
    sentinelPath,
    input.timeoutSeconds,
  );
  return { path: sentinelPath, token, result: "written" };
}

async function verifyWorkspaceSentinel(input: {
  sandbox: Sandbox;
  remoteCwd: string;
  leaseMetadata?: Record<string, unknown>;
  timeoutSeconds: number;
}): Promise<WorkspaceSentinelResult> {
  const metadataSentinel = isRecord(input.leaseMetadata?.workspaceSentinel)
    ? input.leaseMetadata.workspaceSentinel
    : null;
  const sentinelPath = typeof metadataSentinel?.path === "string"
    ? metadataSentinel.path
    : workspaceSentinelPath(input.remoteCwd);
  const expectedToken = typeof metadataSentinel?.token === "string" ? metadataSentinel.token : null;
  if (!expectedToken) {
    return { path: sentinelPath, token: null, result: "missing" };
  }

  const result = await input.sandbox.process.executeCommand(
    `cat ${shellQuote(sentinelPath)}`,
    undefined,
    undefined,
    input.timeoutSeconds,
  );
  if (result.exitCode !== 0) {
    return { path: sentinelPath, token: expectedToken, result: "missing" };
  }
  try {
    const parsed = JSON.parse(result.result ?? result.artifacts?.stdout ?? "") as unknown;
    const actualToken = isRecord(parsed) && typeof parsed.token === "string" ? parsed.token : null;
    return {
      path: sentinelPath,
      token: expectedToken,
      result: actualToken === expectedToken ? "matched" : "mismatch",
    };
  } catch {
    return { path: sentinelPath, token: expectedToken, result: "mismatch" };
  }
}

function leaseMetadata(input: {
  config: DaytonaDriverConfig;
  sandbox: Sandbox;
  shellCommand: "bash" | "sh";
  remoteCwd: string;
  resumedLease: boolean;
  workspaceSentinel?: WorkspaceSentinelResult;
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
    // Record the resources Paperclip attempted to request so future diagnosis
    // can compare requested allocation against what Daytona provisioned.
    ...(input.config.cpu != null ? { cpu: input.config.cpu } : {}),
    ...(input.config.memory != null ? { memory: input.config.memory } : {}),
    ...(input.config.disk != null ? { disk: input.config.disk } : {}),
    ...(input.config.gpu != null ? { gpu: input.config.gpu } : {}),
    ...(input.workspaceSentinel ? { workspaceSentinel: input.workspaceSentinel } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveConnectionExpiresInMinutes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SSH_ACCESS_MINUTES;
  return Math.min(24 * 60, Math.max(1, Math.trunc(value)));
}

function expiresAtForMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function sanitizeSnapshotName(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function withSetupSourceTemplate(
  config: DaytonaDriverConfig,
  params: Pick<PluginEnvironmentStartInteractiveSetupParams, "sourceTemplateRef" | "sourceTemplateKind">,
): DaytonaDriverConfig {
  if (!params.sourceTemplateRef) return config;
  const sourceKind = params.sourceTemplateKind ?? "snapshot";
  if (sourceKind === "image") {
    return {
      ...config,
      image: params.sourceTemplateRef,
      snapshot: null,
    };
  }
  if (sourceKind !== "snapshot") {
    throw new Error(`Daytona interactive setup can start from image or snapshot templates only, not ${sourceKind}.`);
  }
  return {
    ...config,
    snapshot: params.sourceTemplateRef,
    image: null,
  };
}

async function createSshConnection(
  sandbox: Sandbox,
  expiresInMinutes: number,
): Promise<Pick<PluginEnvironmentInteractiveSetupSession, "connectionSummary" | "connectionPayload">> {
  const createSshAccess = (sandbox as DaytonaInteractiveSandbox).createSshAccess;
  if (typeof createSshAccess !== "function") {
    throw new Error(
      "Daytona interactive setup requires @daytonaio/sdk Sandbox.createSshAccess support.",
    );
  }

  const fallbackExpiresAt = expiresAtForMinutes(expiresInMinutes);
  const access = await createSshAccess.call(sandbox, expiresInMinutes);
  const token = typeof access.token === "string" && access.token.trim().length > 0
    ? access.token.trim()
    : null;
  const commandFromAccess =
    typeof access.command === "string" && access.command.trim().length > 0
      ? access.command.trim()
      : typeof access.sshCommand === "string" && access.sshCommand.trim().length > 0
        ? access.sshCommand.trim()
        : null;
  const command = commandFromAccess ?? (token ? `ssh ${token}@${DAYTONA_SSH_GATEWAY_HOST}` : null);
  if (!command) {
    throw new Error("Daytona SSH access did not return a token or SSH command.");
  }
  const expiresAt = typeof access.expiresAt === "string" && access.expiresAt.trim().length > 0
    ? access.expiresAt.trim()
    : fallbackExpiresAt;

  return {
    connectionSummary: {
      type: "ssh",
      username: "token",
      hostRedacted: true,
      portRedacted: true,
      commandRedacted: true,
      expiresAt,
      metadata: {
        provider: "daytona",
        expiresInMinutes,
      },
    },
    connectionPayload: {
      type: "ssh",
      command,
      token,
      expiresAt,
      metadata: {
        provider: "daytona",
        sensitive: true,
      },
    },
  };
}

function interactiveSetupMetadata(input: {
  config: DaytonaDriverConfig;
  sandbox: Sandbox;
  shellCommand: "bash" | "sh";
  remoteCwd: string;
  sourceTemplateRef?: string | null;
}) {
  return {
    provider: "daytona",
    sandboxId: input.sandbox.id,
    sandboxState: input.sandbox.state ?? null,
    shellCommand: input.shellCommand,
    imageConfigured: Boolean(input.config.image),
    snapshotConfigured: Boolean(input.config.snapshot),
    sourceTemplateRefRedacted: Boolean(input.sourceTemplateRef),
    target: input.sandbox.target,
    timeoutMs: input.config.timeoutMs,
    remoteCwd: input.remoteCwd,
    connectionRedacted: true,
  };
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
  params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentProbeParams | PluginEnvironmentStartInteractiveSetupParams,
  config: DaytonaDriverConfig,
  options: { purpose?: string } = {},
): Promise<Sandbox> {
  const resourceRequestError = validateRuntimeResourceRequest(config);
  if (resourceRequestError) {
    throw new Error(resourceRequestError);
  }
  const client = createDaytonaClient(config);
  const createParams = buildCreateParams(config, buildSandboxLabels({
    companyId: params.companyId,
    environmentId: params.environmentId,
    runId: "runId" in params ? params.runId : undefined,
    setupSessionId: "sessionId" in params ? params.sessionId : undefined,
    purpose: options.purpose,
    reuseLease: config.reuseLease,
  }));
  const sandbox = await client.create(createParams, {
    timeout: toTimeoutSeconds(config.timeoutMs),
  });
  return sandbox;
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
    const resourceRequestError = validateResourceRequest(config);
    if (resourceRequestError) {
      errors.push(resourceRequestError);
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
      const workspaceSentinel = await writeWorkspaceSentinel({
        sandbox,
        remoteCwd,
        params,
        config,
        timeoutSeconds: toTimeoutSeconds(config.timeoutMs),
      });
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: false, workspaceSentinel }),
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
      const workspaceSentinel = await verifyWorkspaceSentinel({
        sandbox,
        remoteCwd,
        leaseMetadata: params.leaseMetadata,
        timeoutSeconds: toTimeoutSeconds(config.timeoutMs),
      });
      if (workspaceSentinel.result !== "matched") {
        return { providerLeaseId: null, metadata: { expired: true, workspaceSentinel } };
      }
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: true, workspaceSentinel }),
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

  async onEnvironmentStartInteractiveSetup(
    params: PluginEnvironmentStartInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession> {
    const baseConfig = parseDriverConfig(params.config);
    const config = withSetupSourceTemplate(baseConfig, params);
    const sandbox = await createSandbox(params, config, { purpose: "interactive_setup" });
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      const connection = await createSshConnection(
        sandbox,
        resolveConnectionExpiresInMinutes(params.connectionExpiresInMinutes),
      );
      return {
        providerLeaseId: sandbox.id,
        status: "waiting_for_user",
        expiresAt: params.expiresAt ?? connection.connectionPayload?.expiresAt ?? null,
        ...connection,
        metadata: interactiveSetupMetadata({
          config,
          sandbox,
          shellCommand,
          remoteCwd,
          sourceTemplateRef: params.sourceTemplateRef,
        }),
      };
    } catch (error) {
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentGetInteractiveSetup(
    params: PluginEnvironmentGetInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession> {
    const config = parseDriverConfig(params.config);
    if (!params.providerLeaseId) {
      return {
        providerLeaseId: null,
        status: "missing",
        connectionSummary: null,
        connectionPayload: null,
        metadata: {
          provider: "daytona",
          missing: true,
        },
      };
    }
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) {
      return {
        providerLeaseId: null,
        status: "missing",
        connectionSummary: null,
        connectionPayload: null,
        metadata: {
          provider: "daytona",
          missing: true,
        },
      };
    }

    await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
    const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
    const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
    const connection = params.includeConnectionPayload === true
      ? await createSshConnection(sandbox, resolveConnectionExpiresInMinutes(params.connectionExpiresInMinutes))
      : {
          connectionSummary: {
            type: "ssh" as const,
            username: "token",
            hostRedacted: true,
            portRedacted: true,
            commandRedacted: true,
            metadata: {
              provider: "daytona",
            },
          },
          connectionPayload: null,
        };

    return {
      providerLeaseId: sandbox.id,
      status: "waiting_for_user",
      ...connection,
      metadata: interactiveSetupMetadata({
        config,
        sandbox,
        shellCommand,
        remoteCwd,
      }),
    };
  },

  async onEnvironmentCaptureTemplate(
    params: PluginEnvironmentCaptureTemplateParams,
  ): Promise<PluginEnvironmentCaptureTemplateResult> {
    const config = parseDriverConfig(params.config);
    if (!params.providerLeaseId) {
      throw new Error("Cannot capture a Daytona template without a setup sandbox lease.");
    }
    const sandbox = await getSandbox(config, params.providerLeaseId);
    const createSnapshot = (sandbox as DaytonaInteractiveSandbox)._experimental_createSnapshot;
    if (typeof createSnapshot !== "function") {
      throw new Error(
        "Daytona template capture requires @daytonaio/sdk Sandbox._experimental_createSnapshot support.",
      );
    }
    const templateRef = sanitizeSnapshotName(
      params.templateLabel,
      `paperclip-${params.environmentId}-${randomUUID().slice(0, 8)}`,
    );
    const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? Math.trunc(params.timeoutMs)
      : config.timeoutMs;

    await createSnapshot.call(sandbox, templateRef, toTimeoutSeconds(timeoutMs));

    return {
      templateKind: "snapshot",
      templateRef,
      metadata: {
        provider: "daytona",
        sandboxId: sandbox.id,
        capturedAt: new Date().toISOString(),
        sourceTemplateRefRedacted: Boolean(params.sourceTemplateRef),
        previousTemplateRefRedacted: Boolean(params.previousTemplateRef),
        timeoutMs,
      },
    };
  },

  async onEnvironmentCancelInteractiveSetup(
    params: PluginEnvironmentCancelInteractiveSetupParams,
  ): Promise<PluginEnvironmentCancelInteractiveSetupResult> {
    const config = parseDriverConfig(params.config);
    if (!params.providerLeaseId) {
      return {
        status: "missing",
        metadata: {
          provider: "daytona",
          missing: true,
          reason: params.reason ?? null,
        },
      };
    }
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) {
      return {
        status: "missing",
        metadata: {
          provider: "daytona",
          missing: true,
          reason: params.reason ?? null,
        },
      };
    }
    await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
    return {
      status: params.reason === "timed_out" ? "timed_out" : "cancelled",
      metadata: {
        provider: "daytona",
        sandboxId: sandbox.id,
        reason: params.reason ?? null,
      },
    };
  },

  async onEnvironmentDeleteTemplate(
    params: PluginEnvironmentDeleteTemplateParams,
  ): Promise<PluginEnvironmentDeleteTemplateResult> {
    const templateKind = params.templateKind ?? "snapshot";
    if (templateKind !== "snapshot") {
      throw new Error(`Daytona can delete snapshot templates only, not ${templateKind}.`);
    }
    const config = parseDriverConfig(params.config);
    const client = createDaytonaClient(config) as Daytona & { snapshot?: DaytonaSnapshotService };
    const snapshotService = client.snapshot;
    if (typeof snapshotService?.get !== "function" || typeof snapshotService.delete !== "function") {
      throw new Error("Daytona template deletion requires @daytonaio/sdk snapshot.get/delete support.");
    }
    const snapshot = await snapshotService.get(params.templateRef);
    await snapshotService.delete(snapshot);
    return {
      deleted: true,
      metadata: {
        provider: "daytona",
        templateKind: "snapshot",
        templateRefRedacted: true,
        reason: params.reason ?? null,
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
