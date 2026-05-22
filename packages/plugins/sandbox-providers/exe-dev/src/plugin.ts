import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
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

interface ExeDevDriverConfig {
  apiKey: string | null;
  apiUrl: string;
  namePrefix: string;
  image: string | null;
  command: string | null;
  cpu: number | null;
  memory: string | null;
  disk: string | null;
  comment: string | null;
  env: Record<string, string>;
  integrations: string[];
  tags: string[];
  setupScript: string | null;
  prompt: string | null;
  timeoutMs: number;
  reuseLease: boolean;
  sshUser: string | null;
  sshPrivateKey: string | null;
  sshIdentityFile: string | null;
  sshPort: number;
  strictHostKeyChecking: string;
}

interface ExeDevVmRecord {
  name: string;
  sshDest: string;
  httpsUrl: string | null;
  status: string | null;
  region: string | null;
  regionDisplay: string | null;
}

interface SshExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_API_URL = "https://exe.dev/exec";
const DEFAULT_TIMEOUT_MS = 300_000;
const EXE_DEV_API_MAX_TIMEOUT_MS = 29_000;
const SSH_SIGKILL_GRACE_MS = 250;
const MAX_VM_RECORD_DEPTH = 4;
const EXE_DEV_SSH_ONBOARDING_MARKER = "Please complete registration by running: ssh exe.dev";
const EXE_DEV_SSH_EMAIL_PROMPT = "Please enter your email address:";

// exe.dev's `--setup-script` runs at VM init as the unprivileged `exedev` user, which
// has passwordless sudo. The Paperclip sandbox callback bridge is a Node script, so
// every Paperclip workload on this provider needs node on PATH before the bridge can
// start. When the operator hasn't supplied their own setup script, install Node 20 via
// nodesource so the VM comes up ready for Paperclip out of the box.
const DEFAULT_SETUP_SCRIPT =
  "command -v node >/dev/null 2>&1 || " +
  "(curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && " +
  "sudo apt-get install -y nodejs)";

class ExeDevApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ExeDevApiError";
    this.status = status;
    this.body = body;
  }
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseOptionalString(entry))
      .filter((entry): entry is string => entry != null);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function parseEnvMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim();
    const normalizedValue = parseOptionalString(raw);
    if (normalizedKey.length > 0 && normalizedValue != null) {
      env[normalizedKey] = normalizedValue;
    }
  }
  return env;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeApiUrl(value: string | null): string {
  if (!value) return DEFAULT_API_URL;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_API_URL;
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    if (normalizedPath === "/exec") {
      parsed.pathname = "/exec";
      return parsed.toString();
    }
    parsed.pathname = `${normalizedPath === "/" ? "" : normalizedPath}/exec`.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? "paperclip")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 24) : "paperclip";
}

function parseDriverConfig(raw: Record<string, unknown>): ExeDevDriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sshPort = Number(raw.sshPort ?? 22);

  return {
    apiKey: parseOptionalString(raw.apiKey),
    apiUrl: normalizeApiUrl(parseOptionalString(raw.apiUrl)),
    namePrefix: normalizeNamePrefix(parseOptionalString(raw.namePrefix)),
    image: parseOptionalString(raw.image),
    command: parseOptionalString(raw.command),
    cpu: parseOptionalInteger(raw.cpu),
    memory: parseOptionalString(raw.memory),
    disk: parseOptionalString(raw.disk),
    comment: parseOptionalString(raw.comment),
    env: parseEnvMap(raw.env),
    integrations: parseStringArray(raw.integrations),
    tags: parseStringArray(raw.tags),
    setupScript: parseOptionalString(raw.setupScript),
    prompt: parseOptionalString(raw.prompt),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    reuseLease: raw.reuseLease === true,
    sshUser: parseOptionalString(raw.sshUser),
    sshPrivateKey: parseOptionalString(raw.sshPrivateKey),
    sshIdentityFile: parseOptionalString(raw.sshIdentityFile),
    sshPort: Number.isFinite(sshPort) ? Math.trunc(sshPort) : 22,
    strictHostKeyChecking: parseOptionalString(raw.strictHostKeyChecking) ?? "accept-new",
  };
}

function resolveApiKey(config: ExeDevDriverConfig): string {
  if (config.apiKey) return config.apiKey;
  const envApiKey = process.env.EXE_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("exe.dev environments require an API key in config or EXE_API_KEY.");
  }
  return envApiKey;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildVmName(config: ExeDevDriverConfig, params: PluginEnvironmentAcquireLeaseParams): string {
  const envPart = params.environmentId.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase() || "env";
  const runPart = params.runId.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase() || randomUUID().slice(0, 8);
  return `${config.namePrefix}-${envPart}-${runPart}`.slice(0, 63);
}

function buildFlag(name: string, value: string | number | null | undefined): string[] {
  if (value == null) return [];
  return [`--${name}=${shellQuote(String(value))}`];
}

function buildRepeatedFlag(name: string, values: string[]): string[] {
  return values.flatMap((value) => buildFlag(name, value));
}

function buildEnvFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => buildFlag("env", `${key}=${value}`));
}

function resolveSetupScript(config: ExeDevDriverConfig): string | null {
  if (config.setupScript === null) return DEFAULT_SETUP_SCRIPT;
  const trimmed = config.setupScript.trim();
  return trimmed.length > 0 ? config.setupScript : null;
}

function buildCreateCommand(
  config: ExeDevDriverConfig,
  vmName: string,
): string {
  return [
    "new",
    "--json",
    "--no-email",
    ...buildFlag("name", vmName),
    ...buildFlag("image", config.image),
    ...buildFlag("command", config.command),
    ...buildFlag("cpu", config.cpu),
    ...buildFlag("memory", config.memory),
    ...buildFlag("disk", config.disk),
    ...buildFlag("comment", config.comment),
    ...buildEnvFlags(config.env),
    ...buildRepeatedFlag("integration", config.integrations),
    ...buildRepeatedFlag("tag", config.tags),
    ...buildFlag("setup-script", resolveSetupScript(config)),
    ...buildFlag("prompt", config.prompt),
  ].join(" ");
}

function replaceLiteralAll(input: string, search: string, replacement: string): string {
  return search.length === 0 ? input : input.split(search).join(replacement);
}

function redactCreateCommand(command: string, config: ExeDevDriverConfig): string {
  let redacted = command;

  for (const [key, value] of Object.entries(config.env)) {
    redacted = replaceLiteralAll(
      redacted,
      `--env=${shellQuote(`${key}=${value}`)}`,
      `--env=${shellQuote(`${key}=[REDACTED]`)}`,
    );
  }

  if (config.prompt) {
    redacted = replaceLiteralAll(
      redacted,
      `--prompt=${shellQuote(config.prompt)}`,
      `--prompt=${shellQuote("[REDACTED]")}`,
    );
  }

  const resolvedSetupScript = resolveSetupScript(config);
  if (resolvedSetupScript && resolvedSetupScript !== DEFAULT_SETUP_SCRIPT) {
    redacted = replaceLiteralAll(
      redacted,
      `--setup-script=${shellQuote(resolvedSetupScript)}`,
      `--setup-script=${shellQuote("[REDACTED]")}`,
    );
  }

  return redacted;
}

async function runLifecycleCommand(
  config: ExeDevDriverConfig,
  command: string,
  logCommand = command,
): Promise<unknown> {
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(config)}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: command,
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, EXE_DEV_API_MAX_TIMEOUT_MS)),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new ExeDevApiError(
      `exe.dev API command failed (${response.status}) for: ${logCommand}`,
      response.status,
      body,
    );
  }

  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

function parseVmRecord(value: unknown, depth = 0): ExeDevVmRecord | null {
  if (depth > MAX_VM_RECORD_DEPTH) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = parseVmRecord(record.vm, depth + 1) ?? parseVmRecord(record.data, depth + 1);
  if (nested) return nested;

  const name = parseOptionalString(record.vm_name ?? record.name ?? record.vmName);
  const sshDest = parseOptionalString(record.ssh_dest ?? record.sshDest)
    ?? (name ? `${name}.exe.xyz` : null);

  if (!name || !sshDest) return null;

  return {
    name,
    sshDest,
    httpsUrl: parseOptionalString(record.https_url ?? record.httpsUrl),
    status: parseOptionalString(record.status),
    region: parseOptionalString(record.region),
    regionDisplay: parseOptionalString(record.region_display ?? record.regionDisplay),
  };
}

async function lookupVm(config: ExeDevDriverConfig, vmName: string): Promise<ExeDevVmRecord | null> {
  const response = await runLifecycleCommand(config, `ls --json ${shellQuote(vmName)}`);
  const list = Array.isArray((response as { vms?: unknown[] } | null)?.vms)
    ? (response as { vms: unknown[] }).vms
    : Array.isArray(response)
      ? response
      : response
        ? [response]
        : [];
  for (const candidate of list) {
    const parsed = parseVmRecord(candidate);
    if (parsed?.name === vmName || parsed?.sshDest === vmName) {
      return parsed;
    }
  }
  return null;
}

async function createVm(
  config: ExeDevDriverConfig,
  params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentProbeParams,
): Promise<ExeDevVmRecord> {
  const vmName = "runId" in params
    ? buildVmName(config, params)
    : `${config.namePrefix}-probe-${randomUUID().slice(0, 8)}`.slice(0, 63);
  const command = buildCreateCommand(config, vmName);
  const response = await runLifecycleCommand(config, command, redactCreateCommand(command, config));
  const created = parseVmRecord(response) ?? await lookupVm(config, vmName);
  if (!created) {
    throw new Error(`exe.dev did not return VM metadata for ${vmName}.`);
  }
  return created;
}

async function deleteVm(config: ExeDevDriverConfig, vmName: string): Promise<void> {
  await runLifecycleCommand(config, `rm --json ${shellQuote(vmName)}`);
}

function buildSshDestination(config: ExeDevDriverConfig, vm: ExeDevVmRecord): string {
  return config.sshUser ? `${config.sshUser}@${vm.sshDest}` : vm.sshDest;
}

function buildSshArgs(
  config: ExeDevDriverConfig,
  vm: ExeDevVmRecord,
  remoteCommand: string,
  sshIdentityFile: string | null,
): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking}`,
    "-o",
    "ConnectTimeout=15",
    "-p",
    String(config.sshPort),
  ];
  if (sshIdentityFile) {
    args.push("-i", sshIdentityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(buildSshDestination(config, vm), remoteCommand);
  return args;
}

async function prepareSshIdentity(config: ExeDevDriverConfig): Promise<{
  sshIdentityFile: string | null;
  cleanup: () => Promise<void>;
}> {
  if (!config.sshPrivateKey) {
    return {
      sshIdentityFile: config.sshIdentityFile,
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-exe-dev-ssh-"));
  const sshIdentityFile = path.join(tempDir, "id_ed25519");
  const privateKey = config.sshPrivateKey.endsWith("\n")
    ? config.sshPrivateKey
    : `${config.sshPrivateKey}\n`;

  await writeFile(sshIdentityFile, privateKey, { mode: 0o600 });
  await chmod(sshIdentityFile, 0o600);

  return {
    sshIdentityFile,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid exe.dev environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const finalLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
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

function formatSshFailure(
  action: string,
  vmName: string,
  result: Pick<SshExecutionResult, "stdout" | "stderr">,
): string {
  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  if (
    combinedOutput.includes(EXE_DEV_SSH_ONBOARDING_MARKER)
    || combinedOutput.includes(EXE_DEV_SSH_EMAIL_PROMPT)
  ) {
    return [
      `Failed to ${action} exe.dev VM ${vmName}: the Paperclip host SSH key is not registered with exe.dev.`,
      "Complete exe.dev's one-time SSH onboarding on this host by running `ssh exe.dev` and following the email verification prompt, then retry.",
    ].join(" ");
  }

  return `Failed to ${action} exe.dev VM ${vmName}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`;
}

async function runSshCommand(
  config: ExeDevDriverConfig,
  vm: ExeDevVmRecord,
  remoteCommand: string,
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<SshExecutionResult> {
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const identity = await prepareSshIdentity(config);

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("ssh", buildSshArgs(config, vm, remoteCommand, identity.sshIdentityFile), {
        stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, SSH_SIGKILL_GRACE_MS);
          }, timeoutMs)
        : null;

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          exitCode: timedOut ? null : code,
          signal,
          timedOut,
          stdout,
          stderr,
        });
      });

      if (options.stdin != null && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
    });
  } finally {
    await identity.cleanup();
  }
}

async function detectRemoteContext(
  config: ExeDevDriverConfig,
  vm: ExeDevVmRecord,
): Promise<{ homeDir: string; shellCommand: "bash" | "sh" }> {
  const result = await runSshCommand(
    config,
    vm,
    `sh -lc ${shellQuote(
      'home="${HOME:-}"; if [ -z "$home" ]; then home="$(pwd)"; fi; if command -v bash >/dev/null 2>&1; then shell=bash; else shell=sh; fi; printf "%s\\n%s\\n" "$home" "$shell"',
    )}`,
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(formatSshFailure("inspect", vm.name, result));
  }

  const [homeDirRaw, shellRaw] = result.stdout.split(/\r?\n/);
  const homeDir = homeDirRaw?.trim() || "/tmp";
  return {
    homeDir,
    shellCommand: shellRaw?.trim() === "bash" ? "bash" : "sh",
  };
}

async function ensureRemoteWorkspace(
  config: ExeDevDriverConfig,
  vm: ExeDevVmRecord,
  remoteCwd: string,
): Promise<void> {
  const result = await runSshCommand(
    config,
    vm,
    `sh -lc ${shellQuote(`mkdir -p ${shellQuote(remoteCwd)}`)}`,
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(formatSshFailure("create workspace for", vm.name, result));
  }
}

async function buildLease(
  config: ExeDevDriverConfig,
  vm: ExeDevVmRecord,
  requestedCwd: string | undefined,
  resumedLease: boolean,
): Promise<PluginEnvironmentLease> {
  const remote = await detectRemoteContext(config, vm);
  const remoteCwd = requestedCwd?.trim() || path.posix.join(remote.homeDir, "paperclip-workspace");
  await ensureRemoteWorkspace(config, vm, remoteCwd);

  return {
    providerLeaseId: vm.name,
    metadata: {
      provider: "exe-dev",
      vmName: vm.name,
      sshDest: vm.sshDest,
      httpsUrl: vm.httpsUrl,
      region: vm.region,
      regionDisplay: vm.regionDisplay,
      shellCommand: remote.shellCommand,
      remoteCwd,
      timeoutMs: config.timeoutMs,
      reuseLease: config.reuseLease,
      resumedLease,
    },
  };
}

function metadataVmRecord(params: {
  providerLeaseId: string | null;
  leaseMetadata?: Record<string, unknown> | null;
}): ExeDevVmRecord | null {
  if (!params.providerLeaseId) return null;
  const sshDest = parseOptionalString(params.leaseMetadata?.sshDest) ?? `${params.providerLeaseId}.exe.xyz`;
  return {
    name: params.providerLeaseId,
    sshDest,
    httpsUrl: parseOptionalString(params.leaseMetadata?.httpsUrl),
    status: parseOptionalString(params.leaseMetadata?.status),
    region: parseOptionalString(params.leaseMetadata?.region),
    regionDisplay: parseOptionalString(params.leaseMetadata?.regionDisplay),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("exe.dev sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "exe.dev sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.apiUrl && !isValidUrl(config.apiUrl)) {
      errors.push("apiUrl must be a valid URL.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }
    if (config.cpu != null && config.cpu <= 0) {
      errors.push("cpu must be greater than 0 when provided.");
    }
    if (config.sshPort < 1 || config.sshPort > 65_535) {
      errors.push("sshPort must be between 1 and 65535.");
    }
    if (!config.apiKey && !(process.env.EXE_API_KEY?.trim())) {
      errors.push("exe.dev environments require an API key in config or EXE_API_KEY.");
    }
    for (const key of Object.keys(config.env)) {
      if (!isValidShellEnvKey(key)) {
        errors.push(`env contains an invalid key: ${key}`);
      }
    }
    if (
      typeof params.config.strictHostKeyChecking === "string" &&
      params.config.strictHostKeyChecking.trim().length === 0
    ) {
      errors.push("strictHostKeyChecking cannot be empty.");
    }

    warnings.push(
      "The Paperclip host must have SSH access to the created exe.dev VM, and its SSH key must be registered with exe.dev. The API token only covers provisioning.",
    );
    if (config.reuseLease) {
      warnings.push("reuseLease keeps the VM alive between runs; this provider does not suspend retained VMs.");
    }

    if (errors.length > 0) {
      return { ok: false, errors, warnings };
    }

    return {
      ok: true,
      warnings,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    let vm: ExeDevVmRecord | null = null;

    try {
      vm = await createVm(config, params);
      const lease = await buildLease(config, vm, undefined, false);
      return {
        ok: true,
        summary: `Connected to exe.dev VM ${vm.name}.`,
        metadata: {
          provider: "exe-dev",
          vmName: vm.name,
          sshDest: vm.sshDest,
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          remoteCwd: lease.metadata?.remoteCwd,
          shellCommand: lease.metadata?.shellCommand,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: "exe.dev environment probe failed.",
        metadata: {
          provider: "exe-dev",
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    } finally {
      if (vm) {
        await deleteVm(config, vm.name).catch(() => undefined);
      }
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const vm = await createVm(config, params);
    try {
      return await buildLease(config, vm, params.requestedCwd, false);
    } catch (error) {
      await deleteVm(config, vm.name).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const vm = await lookupVm(config, params.providerLeaseId);
    if (!vm) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    const requestedCwd = parseOptionalString(params.leaseMetadata?.remoteCwd);
    return await buildLease(config, vm, requestedCwd ?? undefined, true);
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (config.reuseLease) return;
    await deleteVm(config, params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    await deleteVm(config, params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      parseOptionalString(params.lease.metadata?.remoteCwd)
      ?? params.workspace.remotePath
      ?? params.workspace.localPath
      ?? "/tmp/paperclip-workspace";

    const vm = metadataVmRecord({
      providerLeaseId: params.lease.providerLeaseId,
      leaseMetadata: params.lease.metadata,
    });
    if (vm) {
      await ensureRemoteWorkspace(config, vm, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "exe-dev",
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
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const vm = metadataVmRecord({
      providerLeaseId: params.lease.providerLeaseId,
      leaseMetadata: params.lease.metadata,
    });
    if (!vm) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "No exe.dev VM metadata available for execution.",
      };
    }

    const command = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd ?? parseOptionalString(params.lease.metadata?.remoteCwd) ?? undefined,
      env: params.env,
    });
    // `buildLoginShellScript` already explicitly sources `/etc/profile`,
    // `~/.profile`, `~/.bash_profile`/`~/.bashrc`, and `~/.zprofile`. Wrapping
    // the result in `sh -lc` (login shell) would source the same files a
    // second time, which can cause `PATH` duplication or unexpected behavior
    // on VMs whose profile init isn't idempotent. Use `sh -c` here so the
    // explicit sourcing inside the script is the single source of truth.
    const result = await runSshCommand(
      config,
      vm,
      `sh -c ${shellQuote(command)}`,
      { stdin: params.stdin, timeoutMs: params.timeoutMs ?? config.timeoutMs },
    );

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr:
        !result.timedOut && result.exitCode !== 0
          ? formatSshFailure("execute commands on", vm.name, result)
          : result.stderr,
      metadata: {
        provider: "exe-dev",
        vmName: vm.name,
        sshDest: vm.sshDest,
      },
    };
  },
});

export default plugin;
