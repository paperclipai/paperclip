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
import { definePlugin, NOOP_PLUGIN_TRACER } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginTracer,
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
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";
import { performSyncIn, performSyncOut, withProviderSpan } from "./file-sync.js";

// Injectable monotonic clock for provider-boundary timing (Open Q1). Defaults
// to the real wall clock; `plugin.test.ts` overrides it via
// `setDaytonaTimingClockForTest` so the measured `durationMs`/`getDurationMs`
// are deterministic. The timing path never calls `Date.now()` directly.
let timingNow: () => number = () => Date.now();

// The plugin context, hoisted to a module variable in `setup(ctx)`. The
// lifecycle hooks and the file-sync helpers have no closure over `ctx`, so they
// read the tracer through `getPluginTracer()`. Before `setup` runs (or in a
// test) the tracer is a no-op, so a span never throws.
let pluginContext: PluginContext | null = null;

/**
 * Return the plugin tracer. It is the injected `ctx.tracer` after `setup`, or a
 * no-op before it. A provider span opened through it records only when tracing
 * is on and an active host trace context is present.
 */
export function getPluginTracer(): PluginTracer {
  return pluginContext?.tracer ?? NOOP_PLUGIN_TRACER;
}

/**
 * Test seam: set the module-level plugin context, and return a restore function.
 * `plugin.test.ts` uses it to inject a recording tracer without running `setup`.
 */
export function __setDaytonaPluginContextForTest(ctx: PluginContext | null): () => void {
  const previous = pluginContext;
  pluginContext = ctx;
  return () => {
    pluginContext = previous;
  };
}

/**
 * Test seam: override the provider-timing clock and return a restore function.
 * Not used in production, where the default wall clock always applies.
 */
export function setDaytonaTimingClockForTest(now: () => number): () => void {
  const previous = timingNow;
  timingNow = now;
  return () => {
    timingNow = previous;
  };
}

// Injectable clock for the handle cache's freshness bookkeeping, deliberately
// kept separate from the provider-timing clock so tests can advance virtual time
// past a lease's auto-stop interval without perturbing the `getDurationMs` /
// `durationMs` measurements that ride on `timingNow`.
let handleFreshnessNow: () => number = () => Date.now();

/**
 * Test seam: override the handle-cache freshness clock and return a restore
 * function. Not used in production, where the default wall clock always applies.
 */
export function setDaytonaHandleFreshnessClockForTest(now: () => number): () => void {
  const previous = handleFreshnessNow;
  handleFreshnessNow = now;
  return () => {
    handleFreshnessNow = previous;
  };
}

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
  archiveOnRelease: boolean;
  useSessions: boolean;
  useLogStream: boolean;
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

// Sandboxes released with `archiveOnRelease` (test/probe runs) are archived so
// operators can inspect them from the Daytona dashboard, then expired by
// Daytona itself after this interval (counted from the stop that precedes the
// archive) so debugging copies don't accumulate.
const ARCHIVE_ON_RELEASE_AUTO_DELETE_MINUTES = 60;

// Fail-fast cap for git network operations (push, fetch, pull, ls-remote, etc.)
// so a stalled remote or missing credential never consumes the full 900 s adapter
// RPC ceiling; callers always see an actionable error within this window.
const GIT_NETWORK_TIMEOUT_MS = 120_000;

// Noninteractive git credential defaults injected into every Daytona one-shot
// command so that git operations never stall waiting for a terminal prompt.
// Callers can override any of these via the env parameter.
const NONINTERACTIVE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "echo",
  SSH_ASKPASS: "echo",
  SSH_ASKPASS_REQUIRE: "force",
};
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
    archiveOnRelease: raw.archiveOnRelease === true,
    // Session model opt-in. Default OFF. When off, the provider keeps the
    // one-shot command path. When on, the exec hook opens one persistent
    // Daytona session per lease and dispatches every command into it. The flag
    // stays default off until a live leak soak passes.
    useSessions: raw.useSessions === true,
    // Log-stream opt-in. Default OFF. When off, the session dispatch polls the
    // exit code every 50 ms and then reads the logs one time. When on, the
    // dispatch streams stdout and stderr from the callback log form and reads
    // the exit code one time after the stream ends. The flag stays default off
    // until a live soak passes.
    useLogStream: raw.useLogStream === true,
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

function parseProbeInteger(value: string | undefined | null): number | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) ? parsed : null;
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
    // Persisted so the release path (which rebuilds config from lease
    // metadata) still knows to archive instead of delete.
    ...(input.config.archiveOnRelease ? { archiveOnRelease: true } : {}),
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

const GIT_NETWORK_SUBCOMMANDS = new Set(["push", "fetch", "pull", "ls-remote", "clone"]);

function isGitNetworkCommand(command: string, args: string[]): boolean {
  if (path.basename(command) !== "git") return false;
  // Find the first positional arg (the git subcommand), skipping flags and their values.
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i++;
      continue;
    }
    if (GIT_NETWORK_SUBCOMMANDS.has(arg)) return true;
    if (arg === "remote") {
      const next = args.slice(i + 1).find(a => !a.startsWith("-"));
      return next === "update";
    }
    if (arg === "submodule") {
      const next = args.slice(i + 1).find(a => !a.startsWith("-"));
      return next === "update";
    }
    return false;
  }
  return false;
}

// Build the one-shot exec command. Daytona's `executeCommand` runs the script
// in a non-login shell, so it does not source `/etc/profile` on its own. The
// Daytona reference image puts `node`, `claude`, and the other CLIs on the PATH
// through `/etc/profile.d/00-restore-env.sh`, which only `/etc/profile` sources.
// So the wrapper sources the login profiles itself; a non-login shell is then
// enough to resolve the CLIs. The wrapper no longer sources `nvm.sh`; the
// sandbox image supplies `node` on the PATH. See the sandbox runtime
// requirements document.
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinPath?: string;
}): string {
  const callerEnv = input.env ?? {};
  for (const key of Object.keys(callerEnv)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  // Caller env takes priority over noninteractive git credential defaults
  const env = { ...NONINTERACTIVE_GIT_ENV, ...callerEnv };
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const redirectedCommand = input.stdinPath
    ? `${commandParts} < ${shellQuote(input.stdinPath)}`
    : commandParts;
  // Each `executeCommand` call runs in its own shell, so we don't `exec`-
  // replace it; running the command as the last `&&`-chained line is enough to
  // surface the right exit code.
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
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(finalLine);
  return lines.join(" && ");
}

// The workspace remote dir is the confinement root for native file sync. It is
// recorded on the lease metadata at acquire/resume time; require it so a sync can
// never run without a concrete root to confine every sandbox path against.
function resolveSyncRemoteDir(lease: { metadata?: Record<string, unknown> | null }): string {
  const remoteCwd = lease.metadata?.remoteCwd;
  if (typeof remoteCwd === "string" && remoteCwd.trim().length > 0) {
    return remoteCwd.trim();
  }
  throw new Error("Daytona file sync requires a workspace remote dir on the lease metadata.");
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

// ─── Per-lease started-sandbox handle cache ──────────────────────────────────
// Memoize the started Daytona `Sandbox` handle so repeated exec/sync/resume/
// teardown calls on one lease skip the per-call `client.get(sandboxId)` REST
// re-fetch (measured ~4,938 ms on `stage.sync`) and the client construction it
// implies. The cache is process-memory only — no handle, API key, or credential
// is ever persisted or logged (Stage-1 security review C6).
//
// Isolation is the whole game here: the cached object is an authenticated
// compute handle, so a mis-keyed or un-evicted entry could run one lease/tenant's
// commands inside another's sandbox. The guarantees below map 1:1 to the Stage-1
// required-fix conditions:
//   C1  Key by a NON-SECRET composite scope, never the bare providerLeaseId:
//       {driverKey, companyId, environmentId, providerLeaseId, account}. The
//       account discriminator is a hash of the resolved endpoint + credentials
//       so two environments pointing at different Daytona accounts (or a rotated
//       key) never collide — without storing the secret in the key.
//   C2  Every read (cache hit AND resolved single-flight populate) asserts the
//       handle's `sandbox.id === providerLeaseId`; a mismatch evicts and throws
//       (fail closed) rather than serving the wrong sandbox.
//   C4  Callers evict at every teardown hook. Populate rejections (NotFound,
//       network, id mismatch) are never cached — they drop from the map so the
//       next call re-fetches.
//   C5  In-flight populate promises live under the composite key only; there is
//       no fallback lookup by bare providerLeaseId, so lease A's in-flight
//       promise can never be awaited for lease B.
type SandboxScope = {
  driverKey: string;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  config: DaytonaDriverConfig;
};

// Non-secret provider/account fingerprint. Uses the *resolved* key (config or
// DAYTONA_API_KEY env fallback) so an env-provided credential is still scoped,
// but only its sha256 digest — never the key itself — enters the cache key (C1/C6).
function sandboxAccountDiscriminator(config: DaytonaDriverConfig): string {
  const resolvedApiKey = config.apiKey ?? process.env.DAYTONA_API_KEY?.trim() ?? null;
  return createHash("sha256")
    .update(stableStringify({
      apiUrl: config.apiUrl,
      target: config.target,
      apiKey: resolvedApiKey,
    }))
    .digest("hex");
}

function sandboxHandleCacheKey(scope: SandboxScope): string {
  return stableStringify({
    driverKey: scope.driverKey,
    companyId: scope.companyId,
    environmentId: scope.environmentId,
    providerLeaseId: scope.providerLeaseId,
    account: sandboxAccountDiscriminator(scope.config),
  });
}

function assertHandleMatchesLease(sandbox: Sandbox, providerLeaseId: string): void {
  // C2: a handle must never stand in for a different sandbox than the lease
  // asked for. Belt-and-suspenders against a provider that returns a renamed or
  // substituted sandbox, and against any future key collision.
  if (sandbox.id !== providerLeaseId) {
    throw new Error(
      `Daytona sandbox handle mismatch: handle ${sandbox.id} does not belong to lease ${providerLeaseId}.`,
    );
  }
}

// A cached `Sandbox` carries the provider state captured when it was last
// fetched/refreshed. Daytona auto-stops an idle sandbox after `autoStopInterval`
// minutes, at which point that snapshot ("started") no longer matches reality
// and `ensureSandboxStarted` would wrongly skip the restart, sending every
// subsequent exec/sync at a stopped sandbox. Before reusing a handle that has
// gone untouched for this fraction of the auto-stop interval we re-read the live
// state so the restart decision is made against the truth. Reusing a handle for
// an operation resets Daytona's idle clock, so an actively-used lease stays well
// inside the window and never pays the refresh — only a lease resumed after an
// idle gap does.
const STALE_HANDLE_REFRESH_SAFETY_FRACTION = 0.5;

function staleHandleRefreshThresholdMs(autoStopIntervalMinutes: number | null): number | null {
  // Auto-stop disabled (0 / null): the provider never stops the sandbox out from
  // under a live handle, so the started snapshot stays valid until we evict it
  // and no refresh is warranted.
  if (autoStopIntervalMinutes == null || autoStopIntervalMinutes <= 0) return null;
  return Math.floor(autoStopIntervalMinutes * 60_000 * STALE_HANDLE_REFRESH_SAFETY_FRACTION);
}

type SandboxHandleCacheEntry = {
  sandbox: Promise<Sandbox>;
  // Last time we know the live state was accurate: set when the handle is
  // fetched/refreshed and on every reuse (an operation follows, resetting the
  // provider idle clock).
  verifiedAtMs: number;
};

type SandboxLookupOptions = {
  bypassTeardownGate?: boolean;
  // Report the cache decision at the handle lookup. `true` means the warm
  // handle cache served the handle; `false` means the lookup called
  // `client.get`. The caller uses this to set the explicit exec `cache_hit`
  // flag, instead of the old `providerGetMs == 0` proxy.
  onCacheDecision?: (cacheHit: boolean) => void;
};

type SandboxHandleTeardownGate = {
  promise: Promise<void>;
  release: () => void;
  refCount: number;
};

const sandboxHandleTeardownGates = (() => {
  const gates = new Map<string, SandboxHandleTeardownGate>();

  function begin(scope: SandboxScope): SandboxHandleTeardownGate {
    const key = sandboxHandleCacheKey(scope);
    const existing = gates.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    let release!: () => void;
    const gate: SandboxHandleTeardownGate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
      refCount: 1,
    };
    gates.set(key, gate);
    return gate;
  }

  function current(scope: SandboxScope): SandboxHandleTeardownGate | null {
    return gates.get(sandboxHandleCacheKey(scope)) ?? null;
  }

  function end(scope: SandboxScope, gate: SandboxHandleTeardownGate): void {
    const key = sandboxHandleCacheKey(scope);
    gate.refCount -= 1;
    if (gate.refCount > 0) return;
    if (gates.get(key) === gate) {
      gates.delete(key);
    }
    gate.release();
  }

  function reset(): void {
    gates.clear();
  }

  return { begin, current, end, reset };
})();

type SandboxHandleActivityGate = {
  promise: Promise<void>;
  release: () => void;
  refCount: number;
};

const sandboxHandleActivityGates = (() => {
  const gates = new Map<string, SandboxHandleActivityGate>();

  async function begin(scope: SandboxScope): Promise<SandboxHandleActivityGate> {
    const key = sandboxHandleCacheKey(scope);
    const existing = gates.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    let release!: () => void;
    const gate: SandboxHandleActivityGate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
      refCount: 1,
    };
    gates.set(key, gate);
    return gate;
  }

  async function waitForIdle(scope: SandboxScope): Promise<void> {
    const gate = gates.get(sandboxHandleCacheKey(scope));
    if (!gate) return;
    await gate.promise;
  }

  function end(scope: SandboxScope, gate: SandboxHandleActivityGate): void {
    const key = sandboxHandleCacheKey(scope);
    gate.refCount -= 1;
    if (gate.refCount > 0) return;
    if (gates.get(key) === gate) {
      gates.delete(key);
    }
    gate.release();
  }

  function reset(): void {
    gates.clear();
  }

  return { begin, waitForIdle, end, reset };
})();

type SandboxLeaseAdmissionOptions = {
  allowClosed?: boolean;
};

const sandboxHandleLeaseAdmissionStates = (() => {
  const states = new Map<string, boolean>();

  function key(scope: SandboxScope): string {
    return sandboxHandleCacheKey(scope);
  }

  function open(scope: SandboxScope): void {
    states.set(key(scope), false);
  }

  function close(scope: SandboxScope): void {
    states.set(key(scope), true);
  }

  function isClosed(scope: SandboxScope): boolean {
    return states.get(key(scope)) === true;
  }

  function reset(): void {
    states.clear();
  }

  return { open, close, isClosed, reset };
})();

async function withSandboxActivityGate<T>(
  scope: SandboxScope,
  fn: () => Promise<T>,
  options: SandboxLeaseAdmissionOptions = {},
): Promise<T> {
  while (true) {
    if (!options.allowClosed && sandboxHandleLeaseAdmissionStates.isClosed(scope)) {
      throw new Error(`Daytona sandbox lease ${scope.providerLeaseId} is no longer active.`);
    }

    const teardownGate = sandboxHandleTeardownGates.current(scope);
    if (teardownGate) {
      await teardownGate.promise;
      if (!options.allowClosed && sandboxHandleLeaseAdmissionStates.isClosed(scope)) {
        throw new Error(`Daytona sandbox lease ${scope.providerLeaseId} is no longer active.`);
      }
      continue;
    }

    const activityGate = await sandboxHandleActivityGates.begin(scope);
    try {
      // A teardown can still begin between the initial check above and the
      // activity-gate admission. If that happens, back out and wait for the
      // teardown to finish instead of proceeding into a race with cleanup.
      if (sandboxHandleTeardownGates.current(scope)) {
        continue;
      }
      if (!options.allowClosed && sandboxHandleLeaseAdmissionStates.isClosed(scope)) {
        throw new Error(`Daytona sandbox lease ${scope.providerLeaseId} is no longer active.`);
      }
      return await fn();
    } finally {
      sandboxHandleActivityGates.end(scope, activityGate);
    }
  }
}

const sandboxHandleCache = (() => {
  const entries = new Map<string, SandboxHandleCacheEntry>();

  function markFresh(scope: SandboxScope): void {
    const entry = entries.get(sandboxHandleCacheKey(scope));
    if (entry) {
      entry.verifiedAtMs = handleFreshnessNow();
    }
  }

  async function get(scope: SandboxScope, options: SandboxLookupOptions = {}): Promise<Sandbox> {
    const key = sandboxHandleCacheKey(scope);

    const entry = entries.get(key);
    if (entry) {
      // The warm handle cache holds an entry, so this lookup serves the handle
      // without a `client.get` round trip. Report the cache decision now.
      options.onCacheDecision?.(true);
      const sandbox = await entry.sandbox;
      // Re-assert on every hit; evict + fail closed on any mismatch (C2).
      try {
        assertHandleMatchesLease(sandbox, scope.providerLeaseId);
      } catch (error) {
        entries.delete(key);
        throw error;
      }
      // Refresh the live provider state if the handle may have been auto-stopped
      // since we last confirmed it, so the cached `state` snapshot can't hide a
      // provider-initiated stop from `ensureSandboxStarted`. A failed refresh
      // means the handle is no longer trustworthy — evict and fail closed.
      const thresholdMs = staleHandleRefreshThresholdMs(scope.config.autoStopInterval);
      if (thresholdMs != null && handleFreshnessNow() - entry.verifiedAtMs >= thresholdMs) {
        try {
          await sandbox.refreshData();
        } catch (error) {
          entries.delete(key);
          throw error;
        }
      }
      return sandbox;
    }
    // The warm handle cache holds no entry, so this lookup calls `client.get`.
    // Report the cache decision now, before the single-flight populate.
    options.onCacheDecision?.(false);
    // Single-flight: the first miss stores the in-flight promise under the
    // composite key so concurrent misses on the same lease share one `client.get`
    // instead of double-fetching. The promise lives only under this key (C5).
    const populate = (async () => {
      const client = createDaytonaClient(scope.config);
      const sandbox = await client.get(scope.providerLeaseId);
      assertHandleMatchesLease(sandbox, scope.providerLeaseId);
      return sandbox;
    })();
    const populated: SandboxHandleCacheEntry = { sandbox: populate, verifiedAtMs: handleFreshnessNow() };
    entries.set(key, populated);
    try {
      const sandbox = await populate;
      return sandbox;
    } catch (error) {
      // A rejected populate (NotFound, network, id mismatch) must never remain
      // cached (C4/C5). Guard against clobbering a newer entry under the key.
      if (entries.get(key) === populated) {
        entries.delete(key);
      }
      throw error;
    }
  }

  // Seed the cache with a handle the caller already holds (e.g. the fresh handle
  // from `createSandbox` on a cold acquire), so the next `get` under the same
  // scope reuses it instead of paying a real `client.get`. The seed must land
  // under the exact composite key the reader uses, or the reader misses and the
  // saved round trip is lost. Assert the handle belongs to the lease so a caller
  // that builds a wrong scope fails loudly here instead of caching a foreign
  // handle.
  function seed(scope: SandboxScope, sandbox: Sandbox): void {
    assertHandleMatchesLease(sandbox, scope.providerLeaseId);
    entries.set(sandboxHandleCacheKey(scope), {
      sandbox: Promise.resolve(sandbox),
      verifiedAtMs: handleFreshnessNow(),
    });
  }

  function clear(scope: SandboxScope): void {
    entries.delete(sandboxHandleCacheKey(scope));
  }

  function reset(): void {
    entries.clear();
  }

  return { get, seed, clear, reset, markFresh };
})();

// Advisory writable-set store. It holds, per lease scope, the sandbox
// directories that a sync operation declared read-write (`access: "rw"`). The
// store is advisory and best-effort in-memory state: it adds no security (the
// ephemeral sandbox stays the only boundary). The store is keyed the same way
// as `sandboxHandleCache`, by `sandboxHandleCacheKey(scope)`.
//
// The command path no longer reads this set. The provider dropped the advisory
// `bwrap` wrapper that once bound these directories read-write for real-time
// feedback (see `DIRECTORY-CONSTRAINT-FINDINGS.md`). The store still records the
// read-write set, so a future isolation wrapper for the session can consume it
// without a new sync change.
const sandboxHandleWritableDirs = (() => {
  const dirsByKey = new Map<string, Set<string>>();

  // Record the read-write destination directory of every `access: "rw"`
  // mapping. Skip read-only mappings (`access` absent or `"ro"`). Read-only is
  // the safe default for an advisory signal.
  //
  // A workspace, git-history, or asset mapping uploads a tar archive, so its
  // `targetPath` is the staging archive under the runtime root, not the directory
  // that the post-upload extract command fills. For those mappings the author
  // sets `writablePath` to the final destination directory, so this records the
  // real read-write destination, not the staging parent. When `writablePath` is
  // absent the mapping writes `targetPath` in place, so the parent directory of
  // `targetPath` is the destination.
  function recordWritableTargets(scope: SandboxScope, operations: PluginSyncOperation[]): void {
    const key = sandboxHandleCacheKey(scope);
    for (const operation of operations) {
      for (const mapping of operation.files) {
        if (mapping.access !== "rw") continue;
        let dirs = dirsByKey.get(key);
        if (!dirs) {
          dirs = new Set<string>();
          dirsByKey.set(key, dirs);
        }
        dirs.add(mapping.writablePath ?? path.posix.dirname(mapping.targetPath));
      }
    }
  }

  function get(scope: SandboxScope): ReadonlySet<string> {
    return dirsByKey.get(sandboxHandleCacheKey(scope)) ?? new Set<string>();
  }

  function reset(): void {
    dirsByKey.clear();
  }

  return { recordWritableTargets, get, reset };
})();

// Per-lease Daytona session-id store. It holds, per lease scope, the id of the
// one persistent session the exec hook opened for that lease. The store is
// keyed the same way as `sandboxHandleCache`, by `sandboxHandleCacheKey(scope)`.
// The exec hook creates one session on a cache miss and records its id here. The
// teardown hooks delete the session and clear the id. A resume clears the id,
// because a restarted sandbox loses its session shell, so the next exec must
// open a fresh session. The store is process-memory only; it holds an id string,
// never a handle, a credential, or a command.
const sandboxHandleSessionStore = (() => {
  const idByKey = new Map<string, string>();
  // In-flight session creates, keyed the same way as `idByKey`. A create records
  // its promise here for the time it runs, then removes it. The map lets two
  // overlapping first commands for one lease share one create. See `runSingle`.
  const pendingByKey = new Map<string, Promise<string>>();

  function get(scope: SandboxScope): string | undefined {
    return idByKey.get(sandboxHandleCacheKey(scope));
  }

  function set(scope: SandboxScope, sessionId: string): void {
    idByKey.set(sandboxHandleCacheKey(scope), sessionId);
  }

  function clear(scope: SandboxScope): void {
    idByKey.delete(sandboxHandleCacheKey(scope));
  }

  // Single-flight guard for the first-command session create. Two overlapping
  // first commands for one lease must open at most one live session. The first
  // caller runs `create` and records its in-flight promise; every concurrent
  // caller awaits the same promise instead of a second `create`. The store keeps
  // the promise only while `create` runs, then removes it, so a later command
  // (for example, after a resume clears the id) can open a fresh session. A
  // failed `create` removes the promise too, so the next command retries.
  function runSingle(scope: SandboxScope, create: () => Promise<string>): Promise<string> {
    const key = sandboxHandleCacheKey(scope);
    const inFlight = pendingByKey.get(key);
    if (inFlight) return inFlight;
    const promise = create();
    pendingByKey.set(key, promise);
    const settle = (): void => {
      pendingByKey.delete(key);
    };
    promise.then(settle, settle);
    return promise;
  }

  function reset(): void {
    idByKey.clear();
    pendingByKey.clear();
  }

  return { get, set, clear, runSingle, reset };
})();

/**
 * Test seam: clear the process-scoped handle cache between tests so a handle
 * memoized under a reused composite key in one test never leaks into the next.
 * Not used in production.
 */
export function __resetDaytonaSandboxHandleCacheForTest(): void {
  sandboxHandleCache.reset();
  sandboxHandleTeardownGates.reset();
  sandboxHandleActivityGates.reset();
  sandboxHandleLeaseAdmissionStates.reset();
  sandboxHandleWritableDirs.reset();
  sandboxHandleSessionStore.reset();
}

/**
 * Test seam: read the advisory writable directories recorded for a sync scope.
 * The caller passes the same `onEnvironmentSyncIn` inputs, so this rebuilds the
 * exact scope key the hook used. Not used in production.
 */
export function __getDaytonaWritableDirsForTest(input: {
  driverKey: string;
  companyId: string;
  environmentId: string;
  lease: { providerLeaseId?: string | null };
  config: Record<string, unknown>;
}): string[] {
  const scope: SandboxScope = {
    driverKey: input.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    providerLeaseId: input.lease.providerLeaseId ?? "",
    config: parseDriverConfig(input.config),
  };
  return [...sandboxHandleWritableDirs.get(scope)];
}

async function getSandbox(scope: SandboxScope, options: SandboxLookupOptions = {}): Promise<Sandbox> {
  return await sandboxHandleCache.get(scope, options);
}

async function getSandboxOrNull(scope: SandboxScope, options: SandboxLookupOptions = {}): Promise<Sandbox | null> {
  try {
    return await getSandbox(scope, options);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      return null;
    }
    throw error;
  }
}

function evictSandboxHandle(scope: SandboxScope): void {
  sandboxHandleCache.clear(scope);
}

// Return the persistent session id for a lease, and open one session on a cache
// miss. The exec hook calls this once per command. The first call opens the
// session through `createSession` and records its id; every later call returns
// the stored id, so one lease runs every command in one persistent shell. The
// provider never falls back to a one-shot command to open a session.
//
// Leak bound: the Daytona SDK exposes NO per-session TTL. `createSession` takes
// only a session id, and there is no session update or expiry field. Two
// backstops bound the session against a leak. First, `teardownSession` runs a
// guaranteed `deleteSession` in every teardown hook's `try/finally`. Second, the
// sandbox-level `autoStopInterval` (15 minutes idle by default) stops the
// sandbox and, with it, every session; the `autoArchiveInterval` and
// `autoDeleteInterval` intervals then reap the sandbox. A session is a shell
// inside its sandbox and cannot outlive it.
async function getOrCreateSession(sandbox: Sandbox, scope: SandboxScope): Promise<string> {
  const existing = sandboxHandleSessionStore.get(scope);
  if (existing) return existing;
  // Single-flight the first-command create. Two overlapping first commands for
  // one lease share one create promise, so the lease opens at most one live
  // session. The guard checks and starts the create in one synchronous step, so
  // no second command can slip in between the store read and the create start.
  return sandboxHandleSessionStore.runSingle(scope, async () => {
    const sessionId = `paperclip-${randomUUID()}`;
    // Wrap the session create in a short `session.open` provider span. The span
    // carries no session id and no command text, only the provider family. The
    // host maps the name to `sandbox.daytona.session.open`.
    // `session.open` span: create the one persistent Daytona session for a lease,
    // on the first in-run command — `sandbox.process.createSession`.
    await withProviderSpan({
      name: "session.open",
      run: () => sandbox.process.createSession(sessionId),
    });
    sandboxHandleSessionStore.set(scope, sessionId);
    return sessionId;
  });
}

// Delete the persistent session for a lease and clear its stored id. Each
// teardown hook calls this inside its `try/finally`, so a failed delete never
// skips the rest of teardown. A failed delete logs the session id and the error
// loudly and does not throw past teardown; the sandbox stop or delete that
// follows removes the session shell anyway, and the sandbox-level
// `autoStopInterval` / `autoDeleteInterval` / `autoArchiveInterval` backstops
// bound any residual state (the session API exposes no per-session TTL). The
// store id is always cleared, so no orphan id survives.
async function teardownSession(sandbox: Sandbox, scope: SandboxScope): Promise<void> {
  const sessionId = sandboxHandleSessionStore.get(scope);
  if (!sessionId) return;
  try {
    // Wrap the session delete in a short `session.close` provider span. The
    // host maps the name to `sandbox.daytona.session.close`.
    // `session.close` span: delete that persistent session on lease release —
    // `sandbox.process.deleteSession`.
    await withProviderSpan({
      name: "session.close",
      run: () => sandbox.process.deleteSession(sessionId),
    });
  } catch (error) {
    console.error(
      `Failed to delete Daytona session ${sessionId} during teardown: ${formatErrorMessage(error)}`,
    );
  } finally {
    sandboxHandleSessionStore.clear(scope);
  }
}

// One-shot command execution via Daytona's `process.executeCommand`. This is the
// fallback path the exec hook uses when the session model is off. The command
// runs plain as the unprivileged sandbox user; the provider no longer wraps a
// user command with the advisory `bwrap` wrapper on any path.
//
// `executeCommand` returns combined stdout+stderr in `result`. We surface that
// as `stdout` and leave `stderr` empty; callers that grep for error messages
// still see them in `stdout`.
async function executeOneShot(
  sandbox: Sandbox,
  params: PluginEnvironmentExecuteParams,
  config: DaytonaDriverConfig,
): Promise<PluginEnvironmentExecuteResult> {
  const gitNet = isGitNetworkCommand(params.command, params.args ?? []);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs, config);
  const effectiveTimeoutMs = gitNet ? Math.min(timeoutMs, GIT_NETWORK_TIMEOUT_MS) : timeoutMs;
  const timeoutSeconds = toTimeoutSeconds(effectiveTimeoutMs);
  const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;

  // Marks the start of the `executeCommand` REST round-trip. Hoisted out of the
  // try so the timeout path below can still attribute the exec wall-time it spent
  // before the SDK aborted — a slow failed exec is exactly what we want to
  // measure. Stays null until we are about to call `executeCommand`, so a timeout
  // during the earlier `uploadFile` step honestly reports no `durationMs`.
  let execStart: number | null = null;

  try {
    if (stdinPath) {
      await sandbox.fs.uploadFile(Buffer.from(params.stdin ?? "", "utf8"), stdinPath, timeoutSeconds);
    }

    // Run the plain login-shell script as the unprivileged sandbox user. The
    // provider no longer wraps a user command with the advisory `bwrap` wrapper.
    const command = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinPath: stdinPath ?? undefined,
    });

    // Pass cwd undefined: `buildLoginShellScript` already injects the `cd` after
    // it sources the login profiles, when params.cwd is set. The Daytona
    // executor's own cwd argument runs before that profile sourcing, which is
    // the wrong order (a profile could reset the caller env).
    // Time only the `executeCommand` REST round-trip so the caller can
    // attribute a step's exec time to the provider boundary through the
    // free-form `metadata.durationMs`.
    execStart = timingNow();
    const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);
    const durationMs = timingNow() - execStart;

    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      timedOut: false,
      stdout: result.result ?? result.artifacts?.stdout ?? "",
      stderr: "",
      metadata: { durationMs },
    };
  } catch (error) {
    if (error instanceof DaytonaTimeoutError) {
      const timeoutMessage = gitNet
        ? `Git network operation timed out after ${Math.round(effectiveTimeoutMs / 1000)} s — the remote may be unreachable or noninteractive credentials are not configured.`
        : error.message.trim();
      // Preserve provider-boundary exec attribution on the timeout path: if the
      // SDK aborted the `executeCommand` call itself, report how long it ran
      // before timing out so slow failed startup exec is attributed to the
      // provider, not silently dropped.
      const durationMs = execStart != null ? timingNow() - execStart : undefined;
      return {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: `${timeoutMessage}\n`,
        ...(durationMs != null ? { metadata: { durationMs } } : {}),
      };
    }
    throw error;
  } finally {
    if (stdinPath) {
      await sandbox.fs.deleteFile(stdinPath).catch(() => undefined);
    }
  }
}

// Poll interval for a session command's exit code. The live spike measured a
// session command resolving in about 260-300 ms, so a short interval keeps the
// poll responsive without a busy loop.
const SESSION_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff delays for the exit-code read after the log stream ends. The live
// spike measured the exit code available within one poll (91-202 ms), so the
// first read almost always holds the code. These delays cover the rare case
// where the first read has no code yet.
const SESSION_EXIT_CODE_RETRY_DELAYS_MS = [50, 100, 200];

// A bounded reconnect for the log stream. A disconnect settles the stream
// promise as a rejection while the command still runs on the server. One
// reconnect replays the log from byte 0; the stream buffer drops the replayed
// prefix by byte offset. After this many reconnects the dispatch falls back to
// the poll path.
const MAX_SESSION_STREAM_RECONNECTS = 1;

// Buffers the stdout and stderr of one session command from the callback log
// stream, and drops a replayed prefix by byte offset.
//
// The Daytona callback stream replays the whole log from byte 0 after a
// reconnect (it does not resume from an offset and does not omit earlier
// bytes). So the buffer tracks the byte count it already holds per stream and
// drops any replayed bytes that fall before that count. The dedupe runs at the
// byte level, because Daytona replays the log byte-for-byte. The SDK keeps each
// multibyte UTF-8 character whole per chunk and per stream, so the delivered
// byte count always lands on a character boundary and the byte-offset split is
// safe.
//
// The buffer stores each new tail as a separate chunk and joins the chunks one
// time at read. It does not copy the earlier output on each append, so total
// buffering work stays linear in the output size, not quadratic.
function createSessionStreamBuffer() {
  const streams = {
    stdout: { chunks: [] as Buffer[], length: 0, connectionBytes: 0 },
    stderr: { chunks: [] as Buffer[], length: 0, connectionBytes: 0 },
  };

  function append(
    stream: { chunks: Buffer[]; length: number; connectionBytes: number },
    chunk: string,
  ): void {
    const buf = Buffer.from(chunk, "utf8");
    const start = stream.connectionBytes;
    stream.connectionBytes = start + buf.length;
    // The whole chunk falls before the delivered byte count, so it is a replay.
    if (start + buf.length <= stream.length) {
      return;
    }
    // Keep only the new tail. When the whole chunk is new, `start >=
    // stream.length` and the tail is the whole chunk. When the chunk straddles
    // the delivered byte count, the tail starts after the replayed prefix.
    const tail = start >= stream.length ? buf : buf.subarray(stream.length - start);
    stream.chunks.push(tail);
    stream.length += tail.length;
  }

  return {
    onStdout: (chunk: string) => append(streams.stdout, chunk),
    onStderr: (chunk: string) => append(streams.stderr, chunk),
    // Reset the per-connection read cursors after a reconnect, so the replayed
    // prefix drops against the already-delivered byte count.
    resetConnectionCursors(): void {
      streams.stdout.connectionBytes = 0;
      streams.stderr.connectionBytes = 0;
    },
    get stdout(): string {
      return Buffer.concat(streams.stdout.chunks).toString("utf8");
    },
    get stderr(): string {
      return Buffer.concat(streams.stderr.chunks).toString("utf8");
    },
  };
}

type SessionLogStreamResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false };

// Stream stdout and stderr of one session command from the callback log form.
// The stream buffer drops a replayed prefix by byte offset on a reconnect. A
// disconnect rejects the stream promise; the dispatch reconnects a bounded
// number of times, then reports failure so the caller falls back to the poll
// path.
async function runSessionLogStream(
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
): Promise<SessionLogStreamResult> {
  const buffer = createSessionStreamBuffer();
  let reconnects = 0;
  while (true) {
    try {
      await sandbox.process.getSessionCommandLogs(sessionId, commandId, buffer.onStdout, buffer.onStderr);
      return { ok: true, stdout: buffer.stdout, stderr: buffer.stderr };
    } catch {
      if (reconnects >= MAX_SESSION_STREAM_RECONNECTS) {
        return { ok: false };
      }
      reconnects += 1;
      buffer.resetConnectionCursors();
    }
  }
}

// Read the exit code one time after the log stream ends. The exit code is
// available within one poll, so the first read almost always holds it. Add a
// small bounded retry with backoff only for the rare case where the first read
// has no code yet. Return null when no read holds a numeric code.
async function readSessionExitCode(
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
): Promise<number | null> {
  const first = await sandbox.process.getSessionCommand(sessionId, commandId);
  if (typeof first.exitCode === "number") {
    return first.exitCode;
  }
  for (const delayMs of SESSION_EXIT_CODE_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    const status = await sandbox.process.getSessionCommand(sessionId, commandId);
    if (typeof status.exitCode === "number") {
      return status.exitCode;
    }
  }
  return null;
}

// Dispatch one user command into the persistent session and return its true
// stdout and stderr.
//
// The Daytona session is one persistent shell. A top-level `exit N` inside a
// session command ends that shell, so the next command then fails with "session
// process has exited". To stop a user `exit` from reaching the session shell,
// the dispatch wraps the whole login-shell script in a subshell `( ... )`. A
// user `exit` then ends only the subshell and reports its exit code, and the
// session shell stays alive. The provider passes the caller cwd and env inside
// the login-shell script on every command, so it never relies on implicit state
// that leaks between commands.
//
// The SDK exposes no built-in wait for a session command, so the dispatch runs
// the command with `runAsync: true` and polls `getSessionCommand` until the exit
// code is set. It then reads true `stdout` and `stderr` from
// `getSessionCommandLogs`, because the synchronous response fields are optional.
// The `runAsync: true` path also avoids the known `runAsync: false` login-shell
// hang.
async function executeInSession(
  sandbox: Sandbox,
  sessionId: string,
  params: PluginEnvironmentExecuteParams,
  config: DaytonaDriverConfig,
): Promise<PluginEnvironmentExecuteResult> {
  const gitNet = isGitNetworkCommand(params.command, params.args ?? []);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs, config);
  const effectiveTimeoutMs = gitNet ? Math.min(timeoutMs, GIT_NETWORK_TIMEOUT_MS) : timeoutMs;
  const timeoutSeconds = toTimeoutSeconds(effectiveTimeoutMs);
  const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;

  // Marks the start of the session dispatch and poll. The timeout paths report
  // the exec wall-time spent before the abort, so a slow command is still
  // attributed to the provider boundary.
  let execStart: number | null = null;

  try {
    if (stdinPath) {
      await sandbox.fs.uploadFile(Buffer.from(params.stdin ?? "", "utf8"), stdinPath, timeoutSeconds);
    }

    const loginScript = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinPath: stdinPath ?? undefined,
    });
    // Subshell wrap: a top-level `exit` in the user command exits only the
    // subshell, not the persistent session shell.
    const command = `( ${loginScript} )`;

    execStart = timingNow();
    const dispatched = await sandbox.process.executeSessionCommand(
      sessionId,
      { command, runAsync: true },
      timeoutSeconds,
    );
    const commandId = dispatched.cmdId;

    // Log-stream path (opt-in). Stream stdout and stderr from the callback log
    // form, then read the exit code one time. On a stream failure, fall through
    // to the poll path below, because the command still runs to its exit on the
    // server.
    if (config.useLogStream) {
      const streamResult = await runSessionLogStream(sandbox, sessionId, commandId);
      if (streamResult.ok) {
        const exitCode = await readSessionExitCode(sandbox, sessionId, commandId);
        const durationMs = timingNow() - execStart;
        return {
          exitCode,
          timedOut: false,
          stdout: streamResult.stdout,
          stderr: streamResult.stderr,
          metadata: { durationMs },
        };
      }
    }

    // Poll for the exit code; the SDK has no wait method. The poll deadline uses
    // the wall clock, separate from the injected timing clock that measures the
    // reported `durationMs`. The poll path is the default when the log stream is
    // off, and the fallback when the log stream fails.
    const deadlineMs = Date.now() + effectiveTimeoutMs;
    let exitCode: number | null = null;
    while (true) {
      const status = await sandbox.process.getSessionCommand(sessionId, commandId);
      if (typeof status.exitCode === "number") {
        exitCode = status.exitCode;
        break;
      }
      if (Date.now() >= deadlineMs) {
        const durationMs = timingNow() - execStart;
        const timeoutMessage = gitNet
          ? `Git network operation timed out after ${Math.round(effectiveTimeoutMs / 1000)} s — the remote may be unreachable or noninteractive credentials are not configured.`
          : `Command timed out after ${Math.round(effectiveTimeoutMs / 1000)} s.`;
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: `${timeoutMessage}\n`,
          metadata: { durationMs },
        };
      }
      await sleep(SESSION_POLL_INTERVAL_MS);
    }

    // Read true, separated stdout and stderr from the logs endpoint. The
    // synchronous dispatch response fields are optional, so the logs endpoint is
    // the source of truth.
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, commandId);
    const durationMs = timingNow() - execStart;
    return {
      exitCode,
      timedOut: false,
      stdout: logs.stdout ?? "",
      stderr: logs.stderr ?? "",
      metadata: { durationMs },
    };
  } catch (error) {
    if (error instanceof DaytonaTimeoutError) {
      const timeoutMessage = gitNet
        ? `Git network operation timed out after ${Math.round(effectiveTimeoutMs / 1000)} s — the remote may be unreachable or noninteractive credentials are not configured.`
        : error.message.trim();
      const durationMs = execStart != null ? timingNow() - execStart : undefined;
      return {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: `${timeoutMessage}\n`,
        ...(durationMs != null ? { metadata: { durationMs } } : {}),
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
    // Hoist the context to a module variable so the lifecycle hooks and the
    // file-sync helpers can read `ctx.tracer` — they have no closure over `ctx`.
    pluginContext = ctx;
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
      sandboxHandleLeaseAdmissionStates.open({
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId: sandbox.id,
        config,
      });
      // Seed the handle cache with the fresh handle under the exact scope that
      // `onEnvironmentRealizeWorkspace` reads (providerLeaseId === sandbox.id).
      // Realize then reuses this handle instead of paying a real `client.get`.
      sandboxHandleCache.seed(
        {
          driverKey: params.driverKey,
          companyId: params.companyId,
          environmentId: params.environmentId,
          providerLeaseId: sandbox.id,
          config,
        },
        sandbox,
      );
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({
          config,
          sandbox,
          shellCommand,
          remoteCwd,
          resumedLease: false,
          workspaceSentinel,
        }),
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
    const scope: SandboxScope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    return await withSandboxActivityGate(scope, async () => {
      const sandbox = await getSandboxOrNull(scope, { bypassTeardownGate: true });
      if (!sandbox) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }

      // A stopped sandbox loses its session shell, so the stored session id is
      // stale after a real restart. Clear the id only when the sandbox is not
      // already running, and clear it before the restart. A stopped sandbox has
      // no live session, so the clear drops a dead id and a later command opens
      // a fresh session. A running sandbox keeps its live session, so the resume
      // leaves the id in place; a concurrent command still finds it and teardown
      // deletes one session. An unconditional clear would drop the id of a live
      // session and leak its shell until sandbox reaping.
      if (sandbox.state !== "started") {
        sandboxHandleSessionStore.clear(scope);
      }
      await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
      try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      // C3: a resumed lease must clear the workspace sentinel before it is
      // trusted, even when the handle came from the cache. On any non-match we
      // evict the cached handle and expire the lease so a stale/foreign sandbox
      // is never reused on the subsequent (sentinel-skipping) exec path.
      const workspaceSentinel = await verifyWorkspaceSentinel({
        sandbox,
        remoteCwd,
        leaseMetadata: params.leaseMetadata,
        timeoutSeconds: toTimeoutSeconds(config.timeoutMs),
      });
      if (workspaceSentinel.result !== "matched") {
        evictSandboxHandle(scope);
        return { providerLeaseId: null, metadata: { expired: true, workspaceSentinel } };
      }
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      sandboxHandleCache.markFresh(scope);
      sandboxHandleLeaseAdmissionStates.open(scope);
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({
          config,
          sandbox,
          shellCommand,
          remoteCwd,
          resumedLease: true,
          workspaceSentinel,
        }),
      };
      } catch (error) {
        evictSandboxHandle(scope);
        await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
        throw error;
      }
    }, { allowClosed: true });
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const scope: SandboxScope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    // C4: the lease's handle must not outlive its teardown. A teardown gate
    // blocks fresh cache reads while cleanup is in flight so overlapping
    // exec/sync calls cannot reacquire the same sandbox mid-stop/delete.
    const teardownGate = sandboxHandleTeardownGates.begin(scope);
    sandboxHandleLeaseAdmissionStates.close(scope);
    try {
      const sandbox = await getSandboxOrNull(scope, { bypassTeardownGate: true });
      if (!sandbox) return;

      evictSandboxHandle(scope);
      await sandboxHandleActivityGates.waitForIdle(scope);
      await teardownSession(sandbox, scope);

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

      if (config.archiveOnRelease) {
        try {
          if (sandbox.state !== "stopped") {
            await sandbox.stop(toTimeoutSeconds(config.timeoutMs));
          }
          await sandbox.setAutoDeleteInterval(ARCHIVE_ON_RELEASE_AUTO_DELETE_MINUTES);
          await sandbox.archive();
          return;
        } catch (error) {
          console.warn(
            `Failed to archive Daytona sandbox during lease release: ${formatErrorMessage(error)}. Falling back to delete.`,
          );
        }
      }

      await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
    } finally {
      sandboxHandleTeardownGates.end(scope, teardownGate);
      evictSandboxHandle(scope);
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const scope: SandboxScope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    // C4: the teardown gate blocks fresh cache reads while delete is in flight
    // so overlapping exec/sync calls cannot reacquire the same sandbox mid-teardown.
    const teardownGate = sandboxHandleTeardownGates.begin(scope);
    sandboxHandleLeaseAdmissionStates.close(scope);
    try {
      const sandbox = await getSandboxOrNull(scope, { bypassTeardownGate: true });
      if (!sandbox) return;

      evictSandboxHandle(scope);
      await sandboxHandleActivityGates.waitForIdle(scope);
      await teardownSession(sandbox, scope);
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
    } finally {
      sandboxHandleTeardownGates.end(scope, teardownGate);
      evictSandboxHandle(scope);
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
        : params.workspace.remotePath ?? params.workspace.localPath ?? "/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const scope: SandboxScope = {
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId: params.lease.providerLeaseId,
        config,
      };
      await withSandboxActivityGate(scope, async () => {
        const sandbox = await getSandbox(scope, { bypassTeardownGate: true });
        await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
        await sandbox.fs.createFolder(remoteCwd, "755");
      });
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
      sandboxHandleLeaseAdmissionStates.open({
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId: sandbox.id,
        config,
      });
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
    const scope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    return await withSandboxActivityGate(scope, async () => {
      const sandbox = await getSandboxOrNull(scope, { bypassTeardownGate: true });
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
    });
  },

  async onEnvironmentCaptureTemplate(
    params: PluginEnvironmentCaptureTemplateParams,
  ): Promise<PluginEnvironmentCaptureTemplateResult> {
    const config = parseDriverConfig(params.config);
    if (!params.providerLeaseId) {
      throw new Error("Cannot capture a Daytona template without a setup sandbox lease.");
    }
    const scope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    return await withSandboxActivityGate(scope, async () => {
      const sandbox = await getSandbox(scope, { bypassTeardownGate: true });
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
    });
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
    const scope: SandboxScope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.providerLeaseId,
      config,
    };
    // C4: cancelling an interactive-setup lease deletes the sandbox, so the
    // teardown gate blocks fresh cache reads while delete is in flight.
    const teardownGate = sandboxHandleTeardownGates.begin(scope);
    sandboxHandleLeaseAdmissionStates.close(scope);
    try {
      const sandbox = await getSandboxOrNull(scope, { bypassTeardownGate: true });
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
      evictSandboxHandle(scope);
      await sandboxHandleActivityGates.waitForIdle(scope);
      await teardownSession(sandbox, scope);
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
      return {
        status: params.reason === "timed_out" ? "timed_out" : "cancelled",
        metadata: {
          provider: "daytona",
          sandboxId: sandbox.id,
          reason: params.reason ?? null,
        },
      };
    } finally {
      sandboxHandleTeardownGates.end(scope, teardownGate);
      evictSandboxHandle(scope);
    }
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
    const providerLeaseId = params.lease.providerLeaseId;
    return await withSandboxActivityGate({
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId,
      config,
    }, async () => {
      // Time the sandbox handle lookup (Open Q1) separately from the
      // `executeCommand` round-trip so telemetry can split the per-call get cost
      // from the exec cost. With the per-lease handle cache this collapses to ~0
      // on a hit (no `client.get` REST round-trip), but the field stays present so
      // `providerGetMs` remains observable — and still captures the occasional
      // freshness refresh the cache issues after an idle gap. `ensureSandboxStarted`
      // is a no-op for an already-started sandbox, so it is excluded from the get
      // measurement.
      const getStart = timingNow();
      // Decide the explicit `cache_hit` flag at the true cache decision: the
      // handle lookup reports whether the warm cache served the handle or the
      // lookup called `client.get`. This replaces the old `providerGetMs == 0`
      // proxy. The default `false` covers the theoretical case where the lookup
      // reports nothing.
      let cacheHit = false;
      const sandbox = await getSandbox({
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId,
        config,
      }, {
        bypassTeardownGate: true,
        onCacheDecision: (hit) => {
          cacheHit = hit;
        },
      });
      const getDurationMs = timingNow() - getStart;
      await ensureSandboxStarted(sandbox, toTimeoutSeconds(resolveTimeoutMs(params.timeoutMs, config)));
      const scope: SandboxScope = {
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId,
        config,
      };
      // Dispatch the command. When the session model is on, open the persistent
      // session on a cache miss and run the command in it. The provider never
      // falls back to a one-shot command to open a session; a cache miss creates
      // one. When the session model is off, run the command on the one-shot path.
      //
      // A `bypassSession` command runs one-shot even when the session model is
      // on, and it does NOT open the session. The host sets this flag on a
      // pre-run command (the workspace provision command) that runs before the
      // run opens its trace root. Opening the session there would emit a
      // `session.open` span with no run parent, and the span backend would drop
      // it. With the bypass the session opens on the first in-run command, whose
      // open span parents to the run trace.
      let result: PluginEnvironmentExecuteResult;
      if (config.useSessions && !params.bypassSession) {
        const sessionId = await getOrCreateSession(sandbox, scope);
        result = await executeInSession(sandbox, sessionId, params, config);
      } else {
        result = await executeOneShot(sandbox, params, config);
      }
      if (!result.timedOut) {
        sandboxHandleCache.markFresh(scope);
      }
      return {
        ...result,
        metadata: { ...(result.metadata ?? {}), getDurationMs, cacheHit },
      };
    });
  },

  // Opt-in native inbound transfer. Defining this hook (with onEnvironmentSyncOut)
  // makes the worker advertise `environmentSyncIn`/`environmentSyncOut`, so the
  // host runner routes Daytona workspace/asset transfers through the SDK's batch
  // `uploadFiles` (plus host-side tarballs for directories) instead of the
  // base64-over-exec fallback. Providers that do not define these keep the
  // byte-identical fallback.
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    if (!params.lease.providerLeaseId) {
      throw new Error("Daytona syncIn requires a provider lease ID.");
    }
    const config = parseDriverConfig(params.config);
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const timeoutSeconds = toTimeoutSeconds(config.timeoutMs);
    const scope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.lease.providerLeaseId,
      config,
    };
    // Collect the advisory read-write destinations for this scope. This records
    // intent only; it does not change the transfer below.
    sandboxHandleWritableDirs.recordWritableTargets(scope, params.operations);
    return await withSandboxActivityGate(scope, async () => {
      const sandbox = await getSandbox(scope, { bypassTeardownGate: true });
      await ensureSandboxStarted(sandbox, timeoutSeconds);
      const result = await performSyncIn({
        sandbox,
        operations: params.operations,
        remoteDir,
        timeoutSeconds,
      });
      sandboxHandleCache.markFresh(scope);
      return result;
    });
  },

  // Opt-in native outbound transfer. See onEnvironmentSyncIn.
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    if (!params.lease.providerLeaseId) {
      throw new Error("Daytona syncOut requires a provider lease ID.");
    }
    const config = parseDriverConfig(params.config);
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const timeoutSeconds = toTimeoutSeconds(config.timeoutMs);
    const scope = {
      driverKey: params.driverKey,
      companyId: params.companyId,
      environmentId: params.environmentId,
      providerLeaseId: params.lease.providerLeaseId,
      config,
    };
    return await withSandboxActivityGate(scope, async () => {
      const sandbox = await getSandbox(scope, { bypassTeardownGate: true });
      await ensureSandboxStarted(sandbox, timeoutSeconds);
      const result = await performSyncOut({
        sandbox,
        operations: params.operations,
        remoteDir,
        timeoutSeconds,
      });
      sandboxHandleCache.markFresh(scope);
      return result;
    });
  },
});

export default plugin;
