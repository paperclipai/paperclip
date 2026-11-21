import { createHash, randomUUID } from "node:crypto";
import {
  definePlugin,
  PluginEnvironmentCreationCleanupError,
  readEnvironmentCreationCleanupError,
} from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentCreationCleanup,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentInspectLeaseParams,
  PluginEnvironmentLease,
  PluginEnvironmentLeaseObservation,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  buildLoginShellScript,
  COLLECT_SCRIPT,
  KILL_SCRIPT,
  READ_SCRIPT,
  RUN_SCRIPT,
  STAGE_SCRIPT,
} from "./scripts.js";

interface Kosa8DriverConfig {
  apiKey: string | null;
  apiUrl: string | null;
  size: string | null;
  image: string | null;
  template: string | null;
  snapshot: string | null;
  region: string | null;
  egressAllow: string[];
  namePrefix: string;
  timeoutMs: number;
  reuseLease: boolean;
}

export interface Kosa8Sandbox {
  id: string;
  state: string;
  name?: string | null;
  labels?: Record<string, string>;
  last_error?: string | null;
}

interface Kosa8BackgroundExec {
  id: string;
  state: string;
  exit: number | null;
  timed_out?: boolean;
}

interface Kosa8ExecAnswer {
  exit: number | null;
  stdout: string;
  stderr: string;
}

export const DEFAULT_API_URL = "https://api.kosa8.com";
export const DEFAULT_IMAGE = "kosa8-template/universal-24.04-20261115.2";
const DEFAULT_SIZE = "2x4";
const SIZES = new Set(["2x4", "4x8", "8x16", "16x32"]);
const DEFAULT_TIMEOUT_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 300_000;
const STATE_CONFIRM_TIMEOUT_MS = 60_000;
const STATE_POLL_INTERVAL_MS = 500;
const EXEC_POLL_MIN_MS = 100;
const EXEC_POLL_MAX_MS = 1_000;
const EXEC_GRACE_MS = 15_000;
const BUFFERED_LIMIT_S = 85;
const MIN_EXPIRY_SECONDS = 60;
const EXPIRY_MARGIN_SECONDS = 5;
const PROBE_TTL_SECONDS = 900;
const RATE_LIMIT_RETRIES = 3;
const INLINE_BODY_LIMIT = 56 * 1024;
const STAGE_CHUNK_CHARS = 45_000;
const COLLECT_LIMIT_BYTES = 600 * 1024;
const READ_CHUNK_BYTES = 700 * 1024;
const MAX_ARG_CHARS = 8_192;
const RUN_ROOT = "/tmp/paperclip-kosa8";
const WORKSPACE_ROOT = "/workspace/paperclip-workspace";
const CREATION_CLEANUP_SCHEMA = "paperclip/environment-creation-cleanup/v1";
const CLEANUP_IDENTIFIER = /^[a-zA-Z0-9_-]{1,200}$/;
const ACTIVE_STATES = new Set(["creating", "running"]);
const STOPPED_STATES = new Set(["sleeping", "paused", "stopped"]);
const GONE_STATES = new Set(["deleted", "host_removed"]);
const EXPIRED_STATES = new Set(["deleted", "error", "host_removed"]);

interface SandboxActivity {
  commands: Map<string, string | null>;
  pending: Set<Promise<unknown>>;
  closing: number;
}

const activity = new Map<string, SandboxActivity>();

function activityFor(id: string): SandboxActivity {
  let state = activity.get(id);
  if (!state) {
    state = { commands: new Map(), pending: new Set(), closing: 0 };
    activity.set(id, state);
  }
  return state;
}

export class Kosa8ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "Kosa8ApiError";
  }
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? "paperclip")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 24).replace(/-+$/, "") : "paperclip";
}

function parseList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseDriverConfig(raw: Record<string, unknown>): Kosa8DriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    apiKey: parseOptionalString(raw.apiKey),
    apiUrl: parseOptionalString(raw.apiUrl),
    size: parseOptionalString(raw.size),
    image: parseOptionalString(raw.image),
    template: parseOptionalString(raw.template),
    snapshot: parseOptionalString(raw.snapshot),
    region: parseOptionalString(raw.region),
    egressAllow: parseList(raw.egressAllow),
    namePrefix: normalizeNamePrefix(parseOptionalString(raw.namePrefix)),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    reuseLease: raw.reuseLease === true,
  };
}

function resolveApiKey(config: Kosa8DriverConfig): string {
  if (config.apiKey) return config.apiKey;
  const envApiKey = process.env.KOSA8_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("kosa8 environments require an API key in config or KOSA8_API_KEY.");
  }
  return envApiKey;
}

function resolveApiUrl(config: Kosa8DriverConfig): string {
  const raw = config.apiUrl ?? parseOptionalString(process.env.KOSA8_API_URL) ?? DEFAULT_API_URL;
  return raw.replace(/\/+$/, "");
}

function apiUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "apiUrl must be an absolute URL.";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return "apiUrl must use https, except for localhost.";
  }
  return null;
}

function accountFingerprint(config: Kosa8DriverConfig): string {
  return createHash("sha256").update(`${resolveApiUrl(config)}\n${resolveApiKey(config)}`).digest("hex");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function fromBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

async function api<T>(
  config: Kosa8DriverConfig,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const url = `${resolveApiUrl(config)}${route}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${resolveApiKey(config)}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (response.ok) return parsed as T;
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000 * (attempt + 1));
      continue;
    }
    const code = typeof parsed.error === "string" ? parsed.error : null;
    const message = typeof parsed.message === "string" ? parsed.message : text.slice(0, 300) || response.statusText;
    throw new Kosa8ApiError(`kosa8 ${method} ${route} failed (${response.status}${code ? ` ${code}` : ""}): ${message}`, response.status, code);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Kosa8ApiError && error.status === 404;
}

function isNotAvailable(error: unknown): boolean {
  return error instanceof Kosa8ApiError && error.status === 501;
}

function isExecTimeout(error: unknown): boolean {
  return error instanceof Kosa8ApiError && error.status === 504 && error.code === "exec_timeout";
}

function sandboxPath(id: string): string {
  return `/v1/sandboxes/${encodeURIComponent(id)}`;
}

async function getSandbox(config: Kosa8DriverConfig, id: string): Promise<Kosa8Sandbox | null> {
  try {
    const answer = await api<{ sandbox: Kosa8Sandbox }>(config, "GET", sandboxPath(id));
    return answer.sandbox;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function namePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase();
}

function buildSandboxName(config: Kosa8DriverConfig, environmentId: string, runId: string): string {
  const envPart = namePart(environmentId) || "env";
  const runPart = namePart(runId) || randomUUID().slice(0, 8);
  return `${config.namePrefix}-${envPart}-${runPart}-${randomUUID().slice(0, 4)}`.slice(0, 64);
}

function sandboxLabels(environmentId: string, runId: string): Record<string, string> {
  const labels: Record<string, string> = { "paperclip-provider": "kosa8" };
  const environment = environmentId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 200);
  const run = runId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 200);
  if (environment) labels["paperclip-environment"] = environment;
  if (run) labels["paperclip-run"] = run;
  return labels;
}

function expiryDeadline(requestedExpiresAt: string, now: number): number {
  const deadline = Date.parse(requestedExpiresAt);
  if (!Number.isFinite(deadline)) {
    throw new Error(`requestedExpiresAt is not a valid timestamp: ${requestedExpiresAt}`);
  }
  const deleteAt = deadline - EXPIRY_MARGIN_SECONDS * 1000;
  if (deleteAt - now < MIN_EXPIRY_SECONDS * 1000) {
    throw new Error("kosa8 cannot bound a lease whose requested expiry is less than 65 seconds away.");
  }
  return deleteAt;
}

function createBody(
  config: Kosa8DriverConfig,
  input: { name: string; labels: Record<string, string>; deleteAfter?: number; ttlS?: number },
): Record<string, unknown> {
  const shape = config.snapshot
    ? { snapshot: config.snapshot }
    : config.template
      ? { template: config.template, persistent: true }
      : { size: config.size ?? DEFAULT_SIZE, image: config.image ?? DEFAULT_IMAGE, persistent: true };
  return {
    ...shape,
    name: input.name,
    labels: input.labels,
    ...(config.region ? { region: config.region } : {}),
    ...(config.egressAllow.length > 0 ? { egress: { internet: false, allow: config.egressAllow } } : {}),
    ...(input.deleteAfter !== undefined ? { delete_after: input.deleteAfter } : {}),
    ...(input.ttlS !== undefined ? { ttl_s: input.ttlS } : {}),
  };
}

async function waitUntilRunning(config: Kosa8DriverConfig, sandbox: Kosa8Sandbox): Promise<Kosa8Sandbox> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let current: Kosa8Sandbox | null = sandbox;
  for (;;) {
    if (!current) throw new Error(`kosa8 sandbox ${sandbox.id} is gone.`);
    if (current.state === "running") return current;
    if (current.state !== "creating") {
      throw new Error(`kosa8 sandbox ${sandbox.id} is ${current.state}${current.last_error ? `: ${current.last_error}` : ""}.`);
    }
    if (Date.now() >= deadline) throw new Error(`kosa8 sandbox ${sandbox.id} did not start in time.`);
    await sleep(STATE_POLL_INTERVAL_MS);
    current = await getSandbox(config, sandbox.id);
  }
}

async function createSandbox(
  config: Kosa8DriverConfig,
  input: { name: string; labels: Record<string, string>; deleteAfter?: number; ttlS?: number },
): Promise<Kosa8Sandbox> {
  const answer = await api<{ sandbox: Kosa8Sandbox }>(config, "POST", "/v1/sandboxes", createBody(config, input));
  if (!answer.sandbox?.id) throw new Error("kosa8 did not return a sandbox ID.");
  return answer.sandbox;
}

async function confirmState(
  config: Kosa8DriverConfig,
  id: string,
  accept: (sandbox: Kosa8Sandbox | null) => boolean,
  description: string,
): Promise<Kosa8Sandbox | null> {
  const deadline = Date.now() + STATE_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const sandbox = await getSandbox(config, id);
    if (accept(sandbox)) return sandbox;
    if (Date.now() >= deadline) {
      throw new Error(`kosa8 did not confirm that sandbox ${id} is ${description} (last state: ${sandbox?.state ?? "missing"}).`);
    }
    await sleep(STATE_POLL_INTERVAL_MS);
  }
}

async function destroySandbox(config: Kosa8DriverConfig, id: string): Promise<PluginEnvironmentTerminationReceipt> {
  try {
    await api(config, "DELETE", sandboxPath(id));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  activity.delete(id);
  await confirmState(config, id, (sandbox) => sandbox === null || GONE_STATES.has(sandbox.state), "deleted");
  return { providerLeaseId: id, state: "destroyed" };
}

async function sleepSandbox(config: Kosa8DriverConfig, id: string): Promise<PluginEnvironmentTerminationReceipt> {
  const sandbox = await getSandbox(config, id);
  if (!sandbox || GONE_STATES.has(sandbox.state)) return { providerLeaseId: id, state: "destroyed" };
  if (sandbox.state === "creating") await waitUntilRunning(config, sandbox);
  if (sandbox.state !== "sleeping") await api(config, "POST", `${sandboxPath(id)}/sleep`);
  const confirmed = await confirmState(
    config,
    id,
    (current) => current === null || GONE_STATES.has(current.state) || current.state === "sleeping",
    "asleep",
  );
  return { providerLeaseId: id, state: confirmed && confirmed.state === "sleeping" ? "stopped" : "destroyed" };
}

async function killRun(config: Kosa8DriverConfig, id: string, dir: string): Promise<void> {
  const killed = await shellExec(config, id, KILL_SCRIPT, dir);
  if (killed.exit !== 0) throw new Error(`Failed to stop a command on kosa8 sandbox ${id}: ${killed.stderr.trim()}`);
}

async function waitForExit(config: Kosa8DriverConfig, id: string, execId: string): Promise<void> {
  const deadline = Date.now() + STATE_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const status = await backgroundStatus(config, id, execId);
    if (!status || status.state === "exited") return;
    if (Date.now() >= deadline) throw new Error(`kosa8 did not confirm that command ${execId} ended on sandbox ${id}.`);
    await sleep(STATE_POLL_INTERVAL_MS);
  }
}

async function stopCommand(config: Kosa8DriverConfig, id: string, dir: string, execId: string | null): Promise<void> {
  if (!execId) return await killRun(config, id, dir);
  try {
    await api(config, "POST", `${sandboxPath(id)}/exec/${execId}/stop`);
    await waitForExit(config, id, execId);
  } catch (error) {
    if (!isNotFound(error)) {
      if (!(error instanceof Kosa8ApiError && (error.status === 501 || error.code === "no_pid"))) throw error;
      await killRun(config, id, dir);
      await waitForExit(config, id, execId);
    }
  }
  activity.get(id)?.commands.delete(dir);
}

async function quiesce(config: Kosa8DriverConfig, id: string): Promise<void> {
  const state = activity.get(id);
  if (!state) return;
  await Promise.all([...state.commands].map(([dir, execId]) => stopCommand(config, id, dir, execId)));
  if (state.pending.size === 0) return;
  const settled = Promise.allSettled([...state.pending]).then(() => true);
  const finished = await Promise.race([settled, sleep(STATE_CONFIRM_TIMEOUT_MS).then(() => false)]);
  if (!finished) throw new Error(`Commands on kosa8 sandbox ${id} did not finish after they were stopped.`);
}

async function quiesceAndSleep(config: Kosa8DriverConfig, id: string): Promise<PluginEnvironmentTerminationReceipt> {
  const state = activityFor(id);
  state.closing += 1;
  try {
    await quiesce(config, id);
    return await sleepSandbox(config, id);
  } finally {
    state.closing -= 1;
  }
}

async function sleepOrDestroy(config: Kosa8DriverConfig, id: string): Promise<PluginEnvironmentTerminationReceipt | void> {
  try {
    const receipt = await quiesceAndSleep(config, id);
    if (receipt.state === "destroyed") return;
  } catch (error) {
    console.warn(`Failed to put kosa8 sandbox ${id} to sleep for reuse: ${formatErrorMessage(error)}. Deleting it instead.`);
    return await destroySandbox(config, id);
  }
}

async function wakeSandbox(config: Kosa8DriverConfig, sandbox: Kosa8Sandbox): Promise<Kosa8Sandbox> {
  if (sandbox.state === "sleeping" || sandbox.state === "paused") {
    try {
      await api(config, "POST", `${sandboxPath(sandbox.id)}/wake`);
    } catch (error) {
      if (!(error instanceof Kosa8ApiError && error.code === "not_sleeping")) throw error;
    }
    const woken = await getSandbox(config, sandbox.id);
    if (!woken) throw new Error(`kosa8 sandbox ${sandbox.id} is gone.`);
    return await waitUntilRunning(config, woken);
  }
  return await waitUntilRunning(config, sandbox);
}

function creationCleanup(
  config: Kosa8DriverConfig,
  id: string,
  owner: { companyId: string; environmentId: string; runId: string },
  labels: Record<string, string>,
): PluginEnvironmentCreationCleanup {
  return {
    providerLeaseId: id,
    companyId: owner.companyId,
    environmentId: owner.environmentId,
    runId: owner.runId,
    attemptId: randomUUID(),
    accountFingerprint: accountFingerprint(config),
    labels: Object.fromEntries(Object.entries(labels).filter(([, value]) => CLEANUP_IDENTIFIER.test(value))),
  };
}

async function checkFailedCreation(config: Kosa8DriverConfig, params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
  const cleanup = readEnvironmentCreationCleanupError({
    data: { schema: CREATION_CLEANUP_SCHEMA, cleanup: params.leaseMetadata?.failedCreateCleanup },
  });
  const matches = cleanup !== null
    && cleanup.companyId === params.companyId
    && cleanup.environmentId === params.environmentId
    && cleanup.providerLeaseId === params.providerLeaseId
    && cleanup.accountFingerprint === accountFingerprint(config);
  const sandbox = matches ? await getSandbox(config, cleanup.providerLeaseId) : null;
  const labels = sandbox?.labels ?? {};
  if (!matches || (sandbox && Object.entries(cleanup.labels).some(([key, value]) => labels[key] !== value))) {
    throw new Error("The failed-creation cleanup does not match a kosa8 sandbox that this environment created.");
  }
}

async function bufferedExec(
  config: Kosa8DriverConfig,
  id: string,
  cmd: string[],
  options: { env?: string[]; timeoutS?: number } = {},
): Promise<Kosa8ExecAnswer> {
  const timeoutS = Math.min(options.timeoutS ?? BUFFERED_LIMIT_S, BUFFERED_LIMIT_S);
  return await api<Kosa8ExecAnswer>(
    config,
    "POST",
    `${sandboxPath(id)}/exec`,
    { cmd, ...(options.env && options.env.length > 0 ? { env: options.env } : {}), timeout_s: timeoutS },
    (timeoutS + 30) * 1000,
  );
}

async function shellExec(config: Kosa8DriverConfig, id: string, script: string, ...args: string[]): Promise<Kosa8ExecAnswer> {
  return await bufferedExec(config, id, ["sh", "-c", script, "k8", ...args]);
}

async function ensureWorkspace(config: Kosa8DriverConfig, id: string, remoteCwd: string): Promise<void> {
  const result = await shellExec(config, id, 'mkdir -p "$1"', remoteCwd);
  if (result.exit !== 0) {
    throw new Error(`Failed to create ${remoteCwd} on kosa8 sandbox ${id}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function stageFile(config: Kosa8DriverConfig, id: string, dir: string, name: string, content: string): Promise<void> {
  const encoded = toBase64(content);
  const chunks = encoded.length === 0 ? [""] : encoded.match(new RegExp(`.{1,${STAGE_CHUNK_CHARS}}`, "g")) ?? [""];
  for (const chunk of chunks) {
    const result = await bufferedExec(config, id, ["sh", "-c", STAGE_SCRIPT, "k8", dir, name], {
      env: [`PAPERCLIP_K8_CHUNK=${chunk}`],
    });
    if (result.exit !== 0) {
      throw new Error(`Failed to stage ${name} on kosa8 sandbox ${id}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
}

async function readRemoteFile(config: Kosa8DriverConfig, id: string, file: string, size: number): Promise<string> {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += READ_CHUNK_BYTES) {
    const length = Math.min(READ_CHUNK_BYTES, size - offset);
    const result = await shellExec(config, id, READ_SCRIPT, file, String(offset), String(length));
    if (result.exit !== 0) throw new Error(`Failed to read ${file} on kosa8 sandbox ${id}: ${result.stderr.trim()}`);
    const chunk = Buffer.from(result.stdout.trim(), "base64");
    if (chunk.length !== length) throw new Error(`Short read of ${file} on kosa8 sandbox ${id}.`);
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function cleanupRun(config: Kosa8DriverConfig, id: string, dir: string): Promise<void> {
  await shellExec(config, id, 'rm -rf "$1"', dir).catch(() => undefined);
}

async function parseCollected(
  config: Kosa8DriverConfig,
  id: string,
  dir: string,
  output: string,
  fallbackExit: number | null,
): Promise<PluginEnvironmentExecuteResult> {
  const lines = output.split("\n");
  const header = /^K8 (done|big) (\S+) (\d+) (\d+)$/.exec(lines[0]?.trim() ?? "");
  if (!header) throw new Error(`kosa8 sandbox ${id} returned an unexpected command result.`);
  const [, kind, code, outSize, errSize] = header;
  const parsedCode = Number(code);
  if (code === "x" && fallbackExit === 125) {
    await cleanupRun(config, id, dir);
    throw new Error(`kosa8 sandbox ${id} could not prepare the command.`);
  }
  const exitCode = code !== "x" && Number.isInteger(parsedCode) ? parsedCode : fallbackExit;
  if (kind === "done") {
    return { exitCode, timedOut: false, stdout: fromBase64(lines[1] ?? ""), stderr: fromBase64(lines[2] ?? "") };
  }
  try {
    const stdout = await readRemoteFile(config, id, `${dir}/out`, Number(outSize));
    const stderr = await readRemoteFile(config, id, `${dir}/err`, Number(errSize));
    return { exitCode, timedOut: false, stdout, stderr };
  } finally {
    await cleanupRun(config, id, dir);
  }
}

async function backgroundStatus(config: Kosa8DriverConfig, id: string, execId: string): Promise<Kosa8BackgroundExec | null> {
  try {
    const answer = await api<{ exec: Kosa8BackgroundExec }>(config, "GET", `${sandboxPath(id)}/exec/${execId}`);
    return answer.exec;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function startBackground(
  config: Kosa8DriverConfig,
  id: string,
  cmd: string[],
  env: string[],
  timeoutS: number,
): Promise<{ exec: Kosa8BackgroundExec; hostTimeout: boolean }> {
  const body = { cmd, ...(env.length > 0 ? { env } : {}), background: true };
  try {
    const answer = await api<{ exec: Kosa8BackgroundExec }>(config, "POST", `${sandboxPath(id)}/exec`, { ...body, timeout_s: timeoutS });
    return { exec: answer.exec, hostTimeout: true };
  } catch (error) {
    if (!(isNotAvailable(error) && /timeout_s/.test(formatErrorMessage(error)))) throw error;
    const answer = await api<{ exec: Kosa8BackgroundExec }>(config, "POST", `${sandboxPath(id)}/exec`, body);
    return { exec: answer.exec, hostTimeout: false };
  }
}

function timedOutResult(error?: unknown): PluginEnvironmentExecuteResult {
  return { exitCode: null, timedOut: true, stdout: "", stderr: error ? `${formatErrorMessage(error)}\n` : "Command timed out.\n" };
}

async function runInBackground(
  config: Kosa8DriverConfig,
  id: string,
  dir: string,
  cmd: string[],
  env: string[],
  timeoutMs: number,
): Promise<PluginEnvironmentExecuteResult> {
  const timeoutS = Math.max(1, Math.ceil(timeoutMs / 1000));
  const startedAt = Date.now();
  const { exec: started, hostTimeout } = await startBackground(config, id, cmd, env, timeoutS);
  const tracked = activityFor(id).commands;
  tracked.set(dir, started.id);
  const deadline = Date.now() + timeoutMs + (hostTimeout ? EXEC_GRACE_MS : 0);
  let interval = EXEC_POLL_MIN_MS;
  let status: Kosa8BackgroundExec | null = started;
  while (status && status.state !== "exited") {
    if (Date.now() >= deadline) {
      try {
        await stopCommand(config, id, dir, started.id);
      } catch (error) {
        throw new Error(`kosa8 command ${started.id} timed out and could not be stopped: ${formatErrorMessage(error)}`);
      }
      await cleanupRun(config, id, dir);
      return timedOutResult();
    }
    await sleep(interval);
    interval = Math.min(interval * 2, EXEC_POLL_MAX_MS);
    status = await backgroundStatus(config, id, started.id);
  }
  if (!status) {
    tracked.delete(dir);
    throw new Error(`kosa8 lost the command ${started.id} on sandbox ${id}.`);
  }
  const ranOut = hostTimeout && Date.now() >= startedAt + timeoutS * 1000 && (status.exit === 143 || status.exit === 137);
  tracked.delete(dir);
  if (status.timed_out || ranOut) {
    await cleanupRun(config, id, dir);
    return timedOutResult();
  }
  const collected = await shellExec(config, id, COLLECT_SCRIPT, dir, String(COLLECT_LIMIT_BYTES));
  return await parseCollected(config, id, dir, collected.stdout, status.exit);
}

async function runBuffered(
  config: Kosa8DriverConfig,
  id: string,
  dir: string,
  cmd: string[],
  env: string[],
  timeoutMs: number,
): Promise<PluginEnvironmentExecuteResult> {
  const tracked = activityFor(id).commands;
  tracked.set(dir, null);
  let answer: Kosa8ExecAnswer;
  try {
    answer = await bufferedExec(config, id, cmd, { env, timeoutS: Math.max(1, Math.ceil(timeoutMs / 1000)) });
  } catch (error) {
    if (!isExecTimeout(error)) throw error;
    await cleanupRun(config, id, dir);
    return timedOutResult(error);
  } finally {
    tracked.delete(dir);
  }
  if (answer.exit === 125) {
    await cleanupRun(config, id, dir);
    throw new Error(`kosa8 sandbox ${id} could not prepare the command: ${answer.stderr.trim()}`);
  }
  if (!answer.stdout.startsWith("K8 ") && (answer.exit === 143 || answer.exit === 137)) {
    await cleanupRun(config, id, dir);
    return { exitCode: answer.exit, timedOut: false, stdout: "", stderr: "The command was stopped.\n" };
  }
  return await parseCollected(config, id, dir, answer.stdout, answer.exit);
}

async function executeCommand(
  config: Kosa8DriverConfig,
  id: string,
  input: { script: string; stdin: string | null; cwd: string | null; timeoutMs: number },
): Promise<PluginEnvironmentExecuteResult> {
  const dir = `${RUN_ROOT}/${randomUUID()}`;
  const cwd = input.cwd ?? "";
  if (cwd.length > MAX_ARG_CHARS) throw new Error("The working directory path is too long for kosa8.");
  const inlineEnv = [`PAPERCLIP_K8_SCRIPT=${toBase64(input.script)}`];
  if (input.stdin != null) inlineEnv.push(`PAPERCLIP_K8_STDIN=${toBase64(input.stdin)}`);
  let env = inlineEnv;
  if (JSON.stringify(inlineEnv).length > INLINE_BODY_LIMIT) {
    try {
      await stageFile(config, id, dir, "script", input.script);
      if (input.stdin != null) await stageFile(config, id, dir, "stdin", input.stdin);
    } catch (error) {
      await cleanupRun(config, id, dir);
      throw error;
    }
    env = [];
  }
  const buffered = input.timeoutMs <= BUFFERED_LIMIT_S * 1000;
  const cmd = ["sh", "-c", RUN_SCRIPT, "k8run", dir, cwd, buffered ? "1" : "0", String(COLLECT_LIMIT_BYTES), COLLECT_SCRIPT];
  if (!buffered) {
    try {
      return await runInBackground(config, id, dir, cmd, env, input.timeoutMs);
    } catch (error) {
      if (!(isNotAvailable(error) && /background/i.test(formatErrorMessage(error)))) {
        if (!activity.get(id)?.commands.has(dir)) await cleanupRun(config, id, dir);
        throw error;
      }
      cmd[6] = "1";
    }
  }
  return await runBuffered(config, id, dir, cmd, env, input.timeoutMs);
}

function leaseMetadata(input: {
  config: Kosa8DriverConfig;
  sandbox: Pick<Kosa8Sandbox, "id" | "name">;
  remoteCwd: string;
  resumedLease: boolean;
}): Record<string, unknown> {
  return {
    provider: "kosa8",
    sandboxId: input.sandbox.id,
    sandboxName: input.sandbox.name ?? input.sandbox.id,
    apiUrl: resolveApiUrl(input.config),
    snapshot: input.config.snapshot,
    template: input.config.template,
    shellCommand: "sh",
    remoteCwd: input.remoteCwd,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    resumedLease: input.resumedLease,
  };
}

async function acquireSandbox(
  config: Kosa8DriverConfig,
  input: { companyId: string; environmentId: string; runId: string; requestedCwd?: string; requestedExpiresAt?: string | null },
): Promise<PluginEnvironmentLease> {
  const deleteAfter = input.requestedExpiresAt ? expiryDeadline(input.requestedExpiresAt, Date.now()) : undefined;
  const labels = sandboxLabels(input.environmentId, input.runId);
  const created = await createSandbox(config, {
    name: buildSandboxName(config, input.environmentId, input.runId),
    labels,
    ...(deleteAfter !== undefined ? { deleteAfter } : {}),
  });
  try {
    const sandbox = await waitUntilRunning(config, created);
    const remoteCwd = input.requestedCwd?.trim() || WORKSPACE_ROOT;
    await ensureWorkspace(config, sandbox.id, remoteCwd);
    return {
      providerLeaseId: sandbox.id,
      metadata: leaseMetadata({ config, sandbox: { id: sandbox.id, name: sandbox.name ?? created.name }, remoteCwd, resumedLease: false }),
      ...(deleteAfter !== undefined ? { expiresAt: new Date(deleteAfter).toISOString() } : {}),
    };
  } catch (error) {
    try {
      await destroySandbox(config, created.id);
    } catch (cleanupError) {
      throw new PluginEnvironmentCreationCleanupError(
        [error, cleanupError],
        `kosa8 sandbox ${created.id} could not be deleted after its acquisition failed.`,
        creationCleanup(config, created.id, input, labels),
      );
    }
    throw error;
  }
}

function validateConfig(config: Kosa8DriverConfig): string[] {
  const errors: string[] = [];
  if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
    errors.push("timeoutMs must be between 1 and 86400000.");
  }
  if (config.size && !SIZES.has(config.size)) {
    errors.push("size must be 2x4, 4x8, 8x16 or 16x32 (vCPU x GiB).");
  }
  if (config.snapshot && (config.template || config.size || config.image)) {
    errors.push("snapshot keeps the snapshot's own template, size and image; clear template, size and image, or clear snapshot.");
  }
  if (config.template && (config.size || config.image)) {
    errors.push("template keeps the template's own size and image; clear size and image, or clear template.");
  }
  if (config.namePrefix.length === 0) errors.push("namePrefix must contain a letter or a digit.");
  const urlProblem = apiUrlProblem(resolveApiUrl(config));
  if (urlProblem) errors.push(urlProblem);
  if (!config.apiKey && !(process.env.KOSA8_API_KEY?.trim())) {
    errors.push("kosa8 environments require an API key in config or KOSA8_API_KEY.");
  }
  return errors;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("kosa8 sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "kosa8 sandbox provider plugin healthy" };
  },

  async onShutdown() {
    activity.clear();
  },

  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors = validateConfig(config);
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, normalizedConfig: { ...config, egressAllow: config.egressAllow.join(",") } };
  },

  async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const configMetadata = {
      provider: "kosa8",
      snapshot: config.snapshot,
      template: config.template,
      timeoutMs: config.timeoutMs,
      reuseLease: config.reuseLease,
    };
    let sandboxId: string | null = null;
    let result: PluginEnvironmentProbeResult;
    try {
      const created = await createSandbox(config, {
        name: `${config.namePrefix}-probe-${randomUUID().slice(0, 8)}`,
        labels: sandboxLabels(params.environmentId, "probe"),
        ttlS: PROBE_TTL_SECONDS,
      });
      sandboxId = created.id;
      await waitUntilRunning(config, created);
      await ensureWorkspace(config, created.id, WORKSPACE_ROOT);
      const tools = await shellExec(
        config,
        created.id,
        'for t in sh tar node; do command -v "$t" >/dev/null 2>&1 || printf "%s " "$t"; done',
      );
      const missing = tools.stdout.trim();
      result = missing
        ? {
          ok: false,
          summary: `kosa8 sandbox ${created.id} has no ${missing} on the PATH.`,
          metadata: { ...configMetadata, sandboxId: created.id, missingTools: missing.split(/\s+/) },
        }
        : {
          ok: true,
          summary: `Connected to kosa8 sandbox ${created.id}.`,
          metadata: { ...configMetadata, sandboxId: created.id, remoteCwd: WORKSPACE_ROOT },
        };
    } catch (error) {
      result = {
        ok: false,
        summary: "kosa8 environment probe failed.",
        metadata: { ...configMetadata, error: formatErrorMessage(error) },
      };
    }
    if (!sandboxId) return result;
    try {
      await destroySandbox(config, sandboxId);
      return result;
    } catch (error) {
      return {
        ok: false,
        summary: `kosa8 environment probe could not delete its sandbox ${sandboxId}.`,
        metadata: { ...result.metadata, sandboxId, cleanupError: formatErrorMessage(error) },
      };
    }
  },

  async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    return await acquireSandbox(parseDriverConfig(params.config), {
      companyId: params.companyId,
      environmentId: params.environmentId,
      runId: params.runId,
      requestedCwd: params.requestedCwd,
      requestedExpiresAt: params.requestedExpiresAt,
    });
  },

  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandbox(config, params.providerLeaseId);
    if (!sandbox || EXPIRED_STATES.has(sandbox.state)) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    const awake = await wakeSandbox(config, sandbox);
    const remoteCwd = params.requestedCwd?.trim() || parseOptionalString(params.leaseMetadata?.remoteCwd) || WORKSPACE_ROOT;
    await ensureWorkspace(config, awake.id, remoteCwd);
    return {
      providerLeaseId: awake.id,
      metadata: leaseMetadata({ config, sandbox: awake, remoteCwd, resumedLease: true }),
    };
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (params.resourceDisposition === "stop_and_retain") {
      return await quiesceAndSleep(config, params.providerLeaseId);
    }
    if (config.reuseLease) {
      if (params.cancelActiveWork) return await quiesceAndSleep(config, params.providerLeaseId);
      return await sleepOrDestroy(config, params.providerLeaseId);
    }
    return await destroySandbox(config, params.providerLeaseId);
  },

  async onEnvironmentStopLease(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt> {
    if (!params.providerLeaseId) {
      throw new Error("No provider lease ID available to stop.");
    }
    return await quiesceAndSleep(parseDriverConfig(params.config), params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (params.leaseMetadata?.failedCreateCleanup !== undefined) await checkFailedCreation(config, params);
    return await destroySandbox(config, params.providerLeaseId);
  },

  async onEnvironmentInspectLease(params: PluginEnvironmentInspectLeaseParams): Promise<PluginEnvironmentLeaseObservation> {
    const sandbox = await getSandbox(parseDriverConfig(params.config), params.providerLeaseId);
    if (!sandbox || GONE_STATES.has(sandbox.state)) return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
    if (ACTIVE_STATES.has(sandbox.state)) return { providerLeaseId: params.providerLeaseId, state: "active" };
    if (STOPPED_STATES.has(sandbox.state)) return { providerLeaseId: params.providerLeaseId, state: "stopped" };
    return { providerLeaseId: params.providerLeaseId, state: "unknown" };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd = parseOptionalString(params.lease.metadata?.remoteCwd)
      ?? params.workspace.remotePath
      ?? WORKSPACE_ROOT;
    if (params.lease.providerLeaseId) {
      await ensureWorkspace(config, params.lease.providerLeaseId, remoteCwd);
    }
    return { cwd: remoteCwd, metadata: { provider: "kosa8", remoteCwd } };
  },

  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
    const sandboxId = params.lease.providerLeaseId;
    if (!sandboxId) {
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "No provider lease ID available for execution." };
    }
    const config = parseDriverConfig(params.config);
    const script = buildLoginShellScript({ command: params.command, args: params.args ?? [], env: params.env });
    const timeoutMs = params.timeoutMs != null && params.timeoutMs > 0 ? params.timeoutMs : config.timeoutMs;
    const cwd = params.cwd ?? parseOptionalString(params.lease.metadata?.remoteCwd);
    const state = activityFor(sandboxId);
    if (state.closing > 0) {
      throw new Error(`kosa8 sandbox ${sandboxId} is stopping, so the command did not start.`);
    }
    const work = executeCommand(config, sandboxId, { script, stdin: params.stdin ?? null, cwd: cwd ?? null, timeoutMs });
    state.pending.add(work);
    try {
      return await work;
    } finally {
      state.pending.delete(work);
    }
  },
});

export default plugin;
