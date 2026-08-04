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
import { performSyncIn, performSyncOut } from "./file-sync.js";

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

// Fail-fast cap for the advisory bwrap capability probe. The probe is
// best-effort, so it must return fallback metadata inside the lease hook. It
// must never consume the full hook deadline. A stalled probe command would
// otherwise expire the outer lease RPC before the probe records its unavailable
// result. This short cap keeps the probe well under the hook deadline, so the
// probe fails fast, records `bwrapAvailable: false`, and the hook still returns.
const BWRAP_PROBE_TIMEOUT_MS = 10_000;

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

// Bounded timeout for the advisory bwrap capability probe. The probe never uses
// the full hook deadline. It uses the smaller of the short probe cap and the
// hook timeout, so a stalled probe command returns fallback metadata inside the
// hook instead of expiring the outer lease RPC.
function toBwrapProbeTimeoutSeconds(config: DaytonaDriverConfig): number {
  return toTimeoutSeconds(Math.min(BWRAP_PROBE_TIMEOUT_MS, config.timeoutMs));
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

// Best-effort probe for the sandbox user's username. It runs `id -un` as the
// normal sandbox user (no `sudo`). The username is an image fact, not a code
// fact, so the probe is the only source of truth; the wrapper never assumes a
// hardcoded username. A non-zero exit code, an empty output, or a thrown error
// records no username. The probe never throws.
async function detectSandboxUsername(
  sandbox: Sandbox,
  timeoutSeconds: number,
): Promise<string | null> {
  try {
    const result = await sandbox.process.executeCommand("id -un", undefined, undefined, timeoutSeconds);
    if (result.exitCode !== 0) return null;
    const username = result.result?.trim() ?? "";
    return username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

// Best-effort probe for the advisory bwrap capability. The probe tests the real
// end-to-end capability using the su-based approach, not the old user-namespace
// approach. One command exercises the binary, the passwordless `sudo -n` rule,
// and the su user-switch together. The probe optionally binds the workspace
// directory (`--bind-try` suppresses ENOENT but not EACCES; on some Daytona
// images the home dir is `drwx------`, so including the workspace bind here
// catches that). A zero exit code means the capability is present. A non-zero
// exit code or a thrown error means the capability is absent. The probe never
// throws. It records the result, and the caller runs the command unwrapped when
// the capability is absent.
async function detectBwrapAvailable(
  sandbox: Sandbox,
  timeoutSeconds: number,
  username: string,
  remoteCwd?: string,
): Promise<boolean> {
  try {
    const workspaceBind = remoteCwd
      ? ` --bind-try ${shellQuote(remoteCwd)} ${shellQuote(remoteCwd)}`
      : "";
    const result = await sandbox.process.executeCommand(
      `sudo -n bwrap --ro-bind / /${workspaceBind} -- su -s /bin/sh ${shellQuote(username)} -c true`,
      undefined,
      undefined,
      timeoutSeconds,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// Run advisory bwrap probes sequentially (username first, then the bwrap probe
// which needs the username to construct the su command). The username is the
// ground-truth read; the wrapper relies on the probed name and never a
// hardcoded default. A missing username short-circuits and returns unavailable,
// so the caller runs the command unwrapped. Neither probe fails the lease.
async function detectBwrapCapability(
  sandbox: Sandbox,
  timeoutSeconds: number,
  remoteCwd?: string,
): Promise<{ bwrapAvailable: boolean; sandboxUsername: string | null }> {
  const username = await detectSandboxUsername(sandbox, timeoutSeconds);
  if (username === null) {
    return { bwrapAvailable: false, sandboxUsername: null };
  }
  const bwrapAvailable = await detectBwrapAvailable(sandbox, timeoutSeconds, username, remoteCwd);
  return { bwrapAvailable, sandboxUsername: username };
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
  bwrapAvailable: boolean;
  sandboxUsername: string | null;
  remoteCwd: string;
  resumedLease: boolean;
  workspaceSentinel?: WorkspaceSentinelResult;
}) {
  return {
    provider: "daytona",
    shellCommand: input.shellCommand,
    // Advisory bwrap capability probed at lease time. `bwrapAvailable` false
    // runs the command unwrapped; it never fails the lease.
    bwrapAvailable: input.bwrapAvailable,
    sandboxUsername: input.sandboxUsername,
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

// Advisory bubblewrap (`bwrap`) wrapper.
//
// The wrapper gives an agent real-time feedback when the agent tries to change a
// file that the ephemeral sandbox will not keep. It adds NO security. The
// ephemeral sandbox stays the only security posture. The read-only root
// (`--ro-bind / /`) is a feedback signal, not a control: a write to a path
// outside the writable set fails at once, so the agent learns the change is not
// durable.
//
// `buildBwrapCommand` is pure. It builds one command string and runs no process.
// It needs no live sandbox. The flag order is load-bearing, because a later
// filesystem operation over the same path wins. So the writable `--bind` flags
// and the stdin re-bind must come after the read-only root and the fresh
// pseudo-filesystems. The function emits the flags in this fixed order:
//   1. `--ro-bind / /` (read-only root — the static system allowance base).
//   2. `--dev /dev --proc /proc --tmpfs /tmp` (fresh pseudo-filesystems).
//   3. one `--bind-try <dir> <dir>` per writable directory, in the caller's order.
//   4. `--ro-bind <stdinPath> <stdinPath>` when a stdin path is supplied.
//   5. `--new-session`.
//   6. `-- su -s /bin/sh '<username>' -c '<escaped inner script>'` when a
//      username is supplied, or `-- sh -c '<escaped inner script>'` otherwise.
//
// `sudo -n bwrap` runs as real root (for bind-mount capability). `su` then
// drops into the sandbox user, so inside uid=<user> maps to outside uid=<user>
// and workspace files owned by that uid are writable. The old `--unshare-user
// --uid`/`--gid` approach created a uid_map that made workspace files appear as
// overflow uid 65534 (nobody) from inside the namespace, causing EACCES.
//
// The writable binds use `--bind-try`, not `--bind`. The writable set is an
// advisory in-memory collection of sandbox paths. The host cannot check whether
// a sandbox path still exists. A path can be deleted or replaced after the store
// records it. `--bind` aborts bwrap when the source is absent, so one stale path
// would fail every later command for the scope. `--bind-try` skips a missing
// source and runs the command, which keeps the wrapper advisory and best-effort.
export function buildBwrapCommand(
  innerScript: string,
  writableDirs: string[],
  stdinPath: string | null,
  username: string | null,
): string {
  const rootBinds = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  const writableBinds = writableDirs.flatMap((dir) => ["--bind-try", shellQuote(dir), shellQuote(dir)]);
  // Re-bind the stdin file after `--tmpfs /tmp`, so the tmpfs does not hide it.
  const stdinReBind = stdinPath ? ["--ro-bind", shellQuote(stdinPath), shellQuote(stdinPath)] : [];
  const tail = username
    ? ["--new-session", "--", "su", "-s", "/bin/sh", shellQuote(username), "-c", shellQuote(innerScript)]
    : ["--new-session", "--", "sh", "-c", shellQuote(innerScript)];
  return [
    "sudo",
    "-n",
    "bwrap",
    ...rootBinds,
    ...writableBinds,
    ...stdinReBind,
    ...tail,
  ].join(" ");
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
// directories that a sync operation declared read-write (`access: "rw"`). An
// optional sandbox feedback wrapper reads this set later to bind those
// directories read-write, so an agent gets real-time feedback when a write to a
// non-persistent path fails. The store is advisory and best-effort in-memory
// state: it adds no security (the ephemeral sandbox stays the only boundary),
// and a cold store (for example after a worker restart) degrades to the
// workspace baseline, never to a crash. The store is keyed the same way as
// `sandboxHandleCache`, by `sandboxHandleCacheKey(scope)`.
//
// The store keeps a path after a sync records it, so a path that a later
// operation deletes or replaces can stay in the set. The wrapper binds each
// path with `bwrap --bind-try`, which skips a missing source, so a stale path
// never fails a later command. See `buildBwrapCommand`.
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

// Advisory bwrap execution plan. When present, `executeOneShot` wraps the
// login-shell string with `buildBwrapCommand`. When null, it runs the plain
// string, which keeps today's behavior. `writableDirs` holds the workspace
// directory (baseline, always read-write) plus the collected read-write sync
// destinations. `username` is the sandbox user to su into inside bwrap.
type BwrapExecPlan = {
  writableDirs: string[];
  username: string;
};

// Decide whether the advisory bwrap wrapper runs for one exec. The wrapper runs
// only when the lease reports bwrap available, a username is known, and the
// workspace directory is known. A wrap without a username would run as root
// inside bwrap and give the agent's files root ownership, so this returns null
// (run the plain command) in that case. The writable set is the workspace
// directory (baseline, always read-write) plus the per-scope read-write sync
// destinations. The baseline guarantees a safe result even when the collected
// store is cold.
function resolveBwrapExecPlan(
  metadata: Record<string, unknown> | null | undefined,
  scope: SandboxScope,
): BwrapExecPlan | null {
  if (metadata?.bwrapAvailable !== true) return null;
  const username = typeof metadata.sandboxUsername === "string" ? metadata.sandboxUsername.trim() : "";
  if (username.length === 0) return null;
  const remoteCwd = typeof metadata.remoteCwd === "string" ? metadata.remoteCwd.trim() : "";
  if (remoteCwd.length === 0) return null;
  const writableDirs = new Set<string>([remoteCwd]);
  for (const dir of sandboxHandleWritableDirs.get(scope)) {
    writableDirs.add(dir);
  }
  return { writableDirs: [...writableDirs], username };
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
  bwrap: BwrapExecPlan | null,
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

    const loginScript = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinPath: stdinPath ?? undefined,
    });

    // Advisory bwrap wrapper (best-effort, automatic, no security boundary). When
    // the lease reports bwrap available and a username is known, wrap the
    // login-shell string so a write to a non-persistent path fails and the agent
    // gets real-time feedback. The writable set binds the workspace and the
    // read-write sync destinations; the stdin re-bind survives the `--tmpfs /tmp`.
    // When the plan is null, run the plain string, which keeps today's behavior.
    const command = bwrap
      ? buildBwrapCommand(loginScript, bwrap.writableDirs, stdinPath, bwrap.username)
      : loginScript;

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
        const bwrapCapability = await detectBwrapCapability(sandbox, toBwrapProbeTimeoutSeconds(config), remoteCwd);
        return {
          ok: true,
          summary: `Connected to Daytona sandbox ${sandbox.name}.`,
          metadata: {
            provider: "daytona",
            shellCommand,
            bwrapAvailable: bwrapCapability.bwrapAvailable,
            sandboxUsername: bwrapCapability.sandboxUsername,
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
      const bwrapCapability = await detectBwrapCapability(sandbox, toBwrapProbeTimeoutSeconds(config), remoteCwd);
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
          bwrapAvailable: bwrapCapability.bwrapAvailable,
          sandboxUsername: bwrapCapability.sandboxUsername,
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
      const bwrapCapability = await detectBwrapCapability(sandbox, toBwrapProbeTimeoutSeconds(config), remoteCwd);
      sandboxHandleCache.markFresh(scope);
      sandboxHandleLeaseAdmissionStates.open(scope);
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({
          config,
          sandbox,
          shellCommand,
          bwrapAvailable: bwrapCapability.bwrapAvailable,
          sandboxUsername: bwrapCapability.sandboxUsername,
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
      // Read the advisory bwrap flags from the lease metadata and read the
      // collected writable directories from the same scope the sync-in hook uses.
      const bwrapPlan = resolveBwrapExecPlan(params.lease.metadata, {
        driverKey: params.driverKey,
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId,
        config,
      });
      const result = await executeOneShot(sandbox, params, config, bwrapPlan);
      if (!result.timedOut) {
        sandboxHandleCache.markFresh({
          driverKey: params.driverKey,
          companyId: params.companyId,
          environmentId: params.environmentId,
          providerLeaseId,
          config,
        });
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
