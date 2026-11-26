import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AgentOutdatedError, Boxd, BoxdError, ConflictError, FilesystemError, NotFoundError } from "@boxd-sh/sdk";
import type { Machine } from "@boxd-sh/sdk";
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

interface BoxdDriverConfig {
  apiKey: string | null;
  org: string | null;
  snapshot: string | null;
  vcpu: number | null;
  namePrefix: string;
  timeoutMs: number;
  reuseLease: boolean;
}

const DEFAULT_TIMEOUT_MS = 3_600_000;
const READY_TIMEOUT_MS = 120_000;
const STATE_CONFIRM_TIMEOUT_MS = 60_000;
const STATE_POLL_INTERVAL_MS = 250;
const EXPIRY_MARGIN_SECONDS = 5;
const PROBE_DELETE_AFTER_SECONDS = 900;
const STDIN_MODE = 0o600;
const CREATION_CLEANUP_SCHEMA = "paperclip/environment-creation-cleanup/v1";
const CLEANUP_IDENTIFIER = /^[a-zA-Z0-9_-]{1,200}$/;
const WORKSPACE_DIR = "paperclip-workspace";
const FALLBACK_HOME = "/home/boxd";
const MEMORY_BY_VCPU: Record<number, string> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };
const ACTIVE_STATES = new Set(["pending", "starting", "running", "migrating"]);
const STOPPED_STATES = new Set(["suspended", "hibernated", "stopped"]);

const clients = new Map<string, Boxd>();

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? "paperclip")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 24).replace(/-+$/, "") : "paperclip";
}

function parseDriverConfig(raw: Record<string, unknown>): BoxdDriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    apiKey: parseOptionalString(raw.apiKey),
    org: parseOptionalString(raw.org),
    snapshot: parseOptionalString(raw.snapshot),
    vcpu: parseOptionalInteger(raw.vcpu),
    namePrefix: normalizeNamePrefix(parseOptionalString(raw.namePrefix)),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    reuseLease: raw.reuseLease === true,
  };
}

function resolveApiKey(config: BoxdDriverConfig): string {
  if (config.apiKey) return config.apiKey;
  const envApiKey = process.env.BOXD_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("boxd environments require an API key in config or BOXD_API_KEY.");
  }
  return envApiKey;
}

function accountFingerprint(config: BoxdDriverConfig): string {
  return createHash("sha256").update(resolveApiKey(config)).digest("hex");
}

function clientFor(config: BoxdDriverConfig): Boxd {
  const cacheKey = accountFingerprint(config);
  let client = clients.get(cacheKey);
  if (!client) {
    client = new Boxd({ apiKey: resolveApiKey(config) });
    clients.set(cacheKey, client);
  }
  return client;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function namePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase();
}

function buildMachineName(config: BoxdDriverConfig, environmentId: string, runId: string): string {
  const envPart = namePart(environmentId) || "env";
  const runPart = namePart(runId) || randomUUID().slice(0, 8);
  return `${config.namePrefix}-${envPart}-${runPart}-${randomUUID().slice(0, 4)}`.slice(0, 63);
}

function machineLabels(environmentId: string, runId: string): Record<string, string> {
  const labels: Record<string, string> = { "paperclip-provider": "boxd" };
  const environment = environmentId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 63);
  const run = runId.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 63);
  if (environment) labels["paperclip-environment"] = environment;
  if (run) labels["paperclip-run"] = run;
  return labels;
}

function expirySeconds(requestedExpiresAt: string, now: number): number {
  const deadline = Date.parse(requestedExpiresAt);
  if (!Number.isFinite(deadline)) {
    throw new Error(`requestedExpiresAt is not a valid timestamp: ${requestedExpiresAt}`);
  }
  const seconds = Math.floor((deadline - now) / 1000) - EXPIRY_MARGIN_SECONDS;
  if (seconds < 1) {
    throw new Error("boxd cannot bound a lease whose requested expiry is less than six seconds away.");
  }
  return seconds;
}

async function createMachine(
  client: Boxd,
  config: BoxdDriverConfig,
  input: { name: string; labels: Record<string, string> },
): Promise<Machine> {
  const common = {
    name: input.name,
    ...(config.org ? { org: config.org } : {}),
    isolated: true,
    labels: input.labels,
  };
  return config.snapshot
    ? await client.machines.create({
        ...common,
        fromSnapshot: config.snapshot,
        config: { autoSuspendTimeout: 0 },
      })
    : await client.machines.create({
        ...common,
        config: {
          autoSuspendTimeout: 0,
          ...(config.vcpu ? { vcpu: config.vcpu, memory: MEMORY_BY_VCPU[config.vcpu] } : {}),
        },
      });
}

async function boundLifetime(client: Boxd, machineId: string, requestedExpiresAt: string): Promise<string> {
  const deleteAt = await client.machines.setDeleteAfter(machineId, expirySeconds(requestedExpiresAt, Date.now()));
  const requested = Date.parse(requestedExpiresAt);
  return new Date(Math.min(deleteAt?.getTime() ?? requested, requested)).toISOString();
}

function creationCleanup(
  config: BoxdDriverConfig,
  machineId: string,
  owner: { companyId: string; environmentId: string; runId: string },
  labels: Record<string, string>,
): PluginEnvironmentCreationCleanup {
  return {
    providerLeaseId: machineId,
    companyId: owner.companyId,
    environmentId: owner.environmentId,
    runId: owner.runId,
    attemptId: randomUUID(),
    accountFingerprint: accountFingerprint(config),
    labels: Object.fromEntries(Object.entries(labels).filter(([, value]) => CLEANUP_IDENTIFIER.test(value))),
  };
}

async function machineOrNull(client: Boxd, machineId: string): Promise<Machine | null> {
  try {
    return await client.machines.get(machineId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

async function checkFailedCreation(
  client: Boxd,
  config: BoxdDriverConfig,
  params: PluginEnvironmentDestroyLeaseParams,
): Promise<void> {
  const cleanup = readEnvironmentCreationCleanupError({
    data: { schema: CREATION_CLEANUP_SCHEMA, cleanup: params.leaseMetadata?.failedCreateCleanup },
  });
  const matches = cleanup !== null
    && cleanup.companyId === params.companyId
    && cleanup.environmentId === params.environmentId
    && cleanup.providerLeaseId === params.providerLeaseId
    && cleanup.accountFingerprint === accountFingerprint(config);
  const machine = matches ? await machineOrNull(client, cleanup.providerLeaseId) : null;
  if (!matches || (machine && Object.entries(cleanup.labels).some(([key, value]) => machine.labels[key] !== value))) {
    throw new Error("The failed-creation cleanup does not match a boxd machine that this environment created.");
  }
}

async function confirmState(
  client: Boxd,
  machineId: string,
  accept: (machine: Machine | null) => boolean,
  description: string,
): Promise<Machine | null> {
  const deadline = Date.now() + STATE_CONFIRM_TIMEOUT_MS;
  for (;;) {
    let machine: Machine | null;
    try {
      machine = await client.machines.get(machineId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      machine = null;
    }
    if (accept(machine)) return machine;
    if (Date.now() >= deadline) {
      throw new Error(`boxd did not confirm that machine ${machineId} is ${description} (last status: ${machine?.status ?? "missing"}).`);
    }
    await sleep(STATE_POLL_INTERVAL_MS);
  }
}

async function withAgentFallback(work: () => Promise<void>, fallback: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof AgentOutdatedError)) throw error;
    await fallback();
  }
}

async function destroyMachine(client: Boxd, machineId: string): Promise<PluginEnvironmentTerminationReceipt> {
  try {
    await client.machines.delete(machineId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  await confirmState(client, machineId, (machine) => machine === null || machine.status === "destroyed", "destroyed");
  return { providerLeaseId: machineId, state: "destroyed" };
}

async function stopMachine(client: Boxd, machineId: string): Promise<PluginEnvironmentTerminationReceipt> {
  let machine: Machine;
  try {
    machine = await client.machines.get(machineId);
  } catch (error) {
    if (error instanceof NotFoundError) return { providerLeaseId: machineId, state: "destroyed" };
    throw error;
  }
  if (machine.status === "suspended") await client.machines.resume(machineId);
  if (machine.status === "hibernated") await client.machines.wake(machineId);
  if (machine.status !== "stopped") await client.machines.stop(machineId);
  const confirmed = await confirmState(
    client,
    machineId,
    (current) => current === null || current.status === "stopped",
    "stopped",
  );
  return { providerLeaseId: machineId, state: confirmed ? "stopped" : "destroyed" };
}

async function pauseOrDestroy(client: Boxd, machineId: string): Promise<PluginEnvironmentTerminationReceipt | void> {
  try {
    const machine = await client.machines.get(machineId);
    if (machine.status === "running") await client.machines.pause(machineId);
  } catch (error) {
    if (error instanceof NotFoundError) return;
    console.warn(`Failed to suspend boxd machine ${machineId} for reuse: ${formatErrorMessage(error)}. Deleting it instead.`);
    return await destroyMachine(client, machineId);
  }
}

async function wakeMachine(client: Boxd, machine: Machine): Promise<void> {
  if (machine.status === "suspended") await client.machines.resume(machine.id);
  if (machine.status === "hibernated") await client.machines.wake(machine.id);
  if (machine.status === "stopped") await client.machines.start(machine.id);
  await client.machines.waitUntilReady(machine.id, { timeout: READY_TIMEOUT_MS });
}

function isStoppedConflict(error: unknown): boolean {
  return error instanceof ConflictError && /\bstopped\b/i.test(error.message);
}

async function withStartedMachine<T>(client: Boxd, machineId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isStoppedConflict(error)) throw error;
    await client.machines.start(machineId);
    await client.machines.waitUntilReady(machineId, { timeout: READY_TIMEOUT_MS });
    return await work();
  }
}

function isExecTimeout(error: unknown): boolean {
  return error instanceof BoxdError && (error.grpcCode === 4 || /timed out/i.test(error.message));
}

async function detectHome(client: Boxd, machineId: string): Promise<string> {
  const result = await client.machines.exec(machineId, {
    command: 'printf "%s\\n" "${HOME:-$(pwd)}"',
  });
  const home = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : "";
  return home && home.startsWith("/") ? home : FALLBACK_HOME;
}

async function makeWorkspaceWithShell(client: Boxd, machineId: string, remoteCwd: string): Promise<void> {
  const result = await client.machines.exec(machineId, { command: `mkdir -p ${shellQuote(remoteCwd)}` });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${remoteCwd} on boxd machine ${machineId}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function ensureWorkspace(client: Boxd, machineId: string, remoteCwd: string): Promise<void> {
  try {
    await withStartedMachine(client, machineId, () => withAgentFallback(
      () => client.machines.fs.mkdir(machineId, remoteCwd),
      () => makeWorkspaceWithShell(client, machineId, remoteCwd),
    ));
  } catch (error) {
    if (!(error instanceof FilesystemError)) throw error;
    throw new Error(`Failed to create ${remoteCwd} on boxd machine ${machineId}: ${error.message}`);
  }
}

function leaseMetadata(input: {
  config: BoxdDriverConfig;
  machine: Pick<Machine, "id" | "name">;
  remoteCwd: string;
  resumedLease: boolean;
}): Record<string, unknown> {
  return {
    provider: "boxd",
    machineId: input.machine.id,
    machineName: input.machine.name,
    sandboxName: input.machine.name,
    url: `https://${input.machine.name}.boxd.sh`,
    org: input.config.org,
    snapshot: input.config.snapshot,
    shellCommand: "bash",
    remoteCwd: input.remoteCwd,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    resumedLease: input.resumedLease,
  };
}

function buildLoginShellScript(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  return [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    execLine,
  ].join(" && ");
}

async function acquireMachine(
  config: BoxdDriverConfig,
  input: {
    companyId: string;
    environmentId: string;
    runId: string;
    requestedCwd?: string;
    requestedExpiresAt?: string | null;
  },
): Promise<PluginEnvironmentLease> {
  const client = clientFor(config);
  if (input.requestedExpiresAt) expirySeconds(input.requestedExpiresAt, Date.now());
  const labels = machineLabels(input.environmentId, input.runId);
  const machine = await createMachine(client, config, {
    name: buildMachineName(config, input.environmentId, input.runId),
    labels,
  });
  try {
    const expiresAt = input.requestedExpiresAt
      ? await boundLifetime(client, machine.id, input.requestedExpiresAt)
      : undefined;
    await client.machines.waitUntilReady(machine.id, { timeout: READY_TIMEOUT_MS });
    const remoteCwd = input.requestedCwd?.trim() || path.posix.join(await detectHome(client, machine.id), WORKSPACE_DIR);
    await ensureWorkspace(client, machine.id, remoteCwd);
    return {
      providerLeaseId: machine.id,
      metadata: leaseMetadata({ config, machine, remoteCwd, resumedLease: false }),
      ...(expiresAt ? { expiresAt } : {}),
    };
  } catch (error) {
    try {
      await destroyMachine(client, machine.id);
    } catch (cleanupError) {
      throw new PluginEnvironmentCreationCleanupError(
        [error, cleanupError],
        `boxd machine ${machine.id} could not be deleted after its acquisition failed.`,
        creationCleanup(config, machine.id, input, labels),
      );
    }
    throw error;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("boxd sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "boxd sandbox provider plugin healthy" };
  },

  async onShutdown() {
    const open = [...clients.values()];
    clients.clear();
    await Promise.all(open.map((client) => client.close().catch(() => undefined)));
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }
    if (config.vcpu != null && !(config.vcpu in MEMORY_BY_VCPU)) {
      errors.push("vcpu must be 1, 2, 4 or 8. boxd sizes are 1 vCPU/4 GB, 2/8 GB, 4/16 GB and 8/32 GB.");
    }
    if (config.vcpu != null && config.snapshot) {
      errors.push("vcpu applies to fresh machines only. A machine restored from a snapshot keeps the snapshot's size; clear vcpu or snapshot.");
    }
    if (!config.apiKey && !(process.env.BOXD_API_KEY?.trim())) {
      errors.push("boxd environments require an API key in config or BOXD_API_KEY.");
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
    const configMetadata = {
      provider: "boxd",
      org: config.org,
      snapshot: config.snapshot,
      timeoutMs: config.timeoutMs,
      reuseLease: config.reuseLease,
    };
    let machine: Machine | null = null;
    let result: PluginEnvironmentProbeResult;
    try {
      const client = clientFor(config);
      machine = await createMachine(client, config, {
        name: `${config.namePrefix}-probe-${randomUUID().slice(0, 8)}`,
        labels: machineLabels(params.environmentId, "probe"),
      });
      await client.machines.setDeleteAfter(machine.id, PROBE_DELETE_AFTER_SECONDS);
      await client.machines.waitUntilReady(machine.id, { timeout: READY_TIMEOUT_MS });
      const remoteCwd = path.posix.join(await detectHome(client, machine.id), WORKSPACE_DIR);
      await ensureWorkspace(client, machine.id, remoteCwd);
      result = {
        ok: true,
        summary: `Connected to boxd machine ${machine.name}.`,
        metadata: { ...configMetadata, machineName: machine.name, remoteCwd },
      };
    } catch (error) {
      result = {
        ok: false,
        summary: "boxd environment probe failed.",
        metadata: { ...configMetadata, error: formatErrorMessage(error) },
      };
    }
    if (!machine) return result;
    try {
      await destroyMachine(clientFor(config), machine.id);
      return result;
    } catch (error) {
      return {
        ok: false,
        summary: `boxd environment probe could not delete its machine ${machine.name}.`,
        metadata: {
          ...result.metadata,
          machineId: machine.id,
          machineName: machine.name,
          cleanupError: formatErrorMessage(error),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    return await acquireMachine(parseDriverConfig(params.config), {
      companyId: params.companyId,
      environmentId: params.environmentId,
      runId: params.runId,
      requestedCwd: params.requestedCwd,
      requestedExpiresAt: params.requestedExpiresAt,
    });
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    let machine: Machine;
    try {
      machine = await client.machines.get(params.providerLeaseId);
    } catch (error) {
      if (error instanceof NotFoundError) return { providerLeaseId: null, metadata: { expired: true } };
      throw error;
    }
    if (machine.status === "destroyed" || machine.status === "failed") {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    await wakeMachine(client, machine);
    const remoteCwd = parseOptionalString(params.leaseMetadata?.remoteCwd)
      ?? path.posix.join(await detectHome(client, machine.id), WORKSPACE_DIR);
    await ensureWorkspace(client, machine.id, remoteCwd);
    return {
      providerLeaseId: machine.id,
      metadata: leaseMetadata({ config, machine, remoteCwd, resumedLease: true }),
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    if (params.resourceDisposition === "stop_and_retain") {
      return await stopMachine(client, params.providerLeaseId);
    }
    if (config.reuseLease) {
      if (params.cancelActiveWork) return await stopMachine(client, params.providerLeaseId);
      return await pauseOrDestroy(client, params.providerLeaseId);
    }
    return await destroyMachine(client, params.providerLeaseId);
  },

  async onEnvironmentStopLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt> {
    if (!params.providerLeaseId) {
      throw new Error("No provider lease ID available to stop.");
    }
    const config = parseDriverConfig(params.config);
    return await stopMachine(clientFor(config), params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    if (params.leaseMetadata?.failedCreateCleanup !== undefined) await checkFailedCreation(client, config, params);
    return await destroyMachine(client, params.providerLeaseId);
  },

  async onEnvironmentInspectLease(
    params: PluginEnvironmentInspectLeaseParams,
  ): Promise<PluginEnvironmentLeaseObservation> {
    const config = parseDriverConfig(params.config);
    try {
      const machine = await clientFor(config).machines.get(params.providerLeaseId);
      if (ACTIVE_STATES.has(machine.status)) return { providerLeaseId: params.providerLeaseId, state: "active" };
      if (STOPPED_STATES.has(machine.status)) return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (machine.status === "destroyed") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      return { providerLeaseId: params.providerLeaseId, state: "unknown" };
    } catch (error) {
      if (error instanceof NotFoundError) return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw error;
    }
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      parseOptionalString(params.lease.metadata?.remoteCwd)
      ?? params.workspace.remotePath
      ?? path.posix.join(FALLBACK_HOME, WORKSPACE_DIR);

    if (params.lease.providerLeaseId) {
      await ensureWorkspace(clientFor(config), params.lease.providerLeaseId, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "boxd",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const machineId = params.lease.providerLeaseId;
    if (!machineId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      env: params.env,
    });
    const timeoutMs = params.timeoutMs != null && params.timeoutMs > 0 ? params.timeoutMs : config.timeoutMs;
    const cwd = params.cwd ?? parseOptionalString(params.lease.metadata?.remoteCwd) ?? undefined;
    const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;
    const command = stdinPath ? `${script} < ${shellQuote(stdinPath)}` : script;

    try {
      const result = await withStartedMachine(client, machineId, async () => {
        if (stdinPath) {
          const stdin = params.stdin ?? "";
          await withAgentFallback(
            async () => {
              await client.machines.fs.write(machineId, stdinPath, stdin, { mode: STDIN_MODE });
            },
            async () => {
              await client.machines.files.upload(machineId, stdinPath, stdin);
            },
          );
        }
        return await client.machines.exec(machineId, { command, ...(cwd ? { cwd } : {}), timeout: timeoutMs });
      });
      return {
        exitCode: result.exitCode,
        timedOut: false,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (isExecTimeout(error)) {
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: `${formatErrorMessage(error)}\n`,
        };
      }
      throw error;
    } finally {
      if (stdinPath) {
        await withAgentFallback(
          () => client.machines.fs.remove(machineId, stdinPath),
          () => client.machines.files.delete(machineId, stdinPath),
        ).catch(() => undefined);
      }
    }
  },
});

export default plugin;
