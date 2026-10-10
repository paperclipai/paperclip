import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { Machine, SmolError } from "smolmachines";
import type { ConnectOptions, MachineConfig } from "smolmachines";

const FALLBACK_CWD = "/tmp/paperclip-workspace";
const DEFAULT_PROBE_IMAGE = "node:24-alpine";
const RUNTIME_IMAGES: Record<string, string> = {
  claude_local: "ghcr.io/paperclipai/agent-runtime-claude:git-38d8f371722b315d2fb3bbaa512518742e33ce2f",
  codex_local: "ghcr.io/paperclipai/agent-runtime-codex:git-38d8f371722b315d2fb3bbaa512518742e33ce2f",
  gemini_local: "ghcr.io/paperclipai/agent-runtime-gemini:git-38d8f371722b315d2fb3bbaa512518742e33ce2f",
  opencode_local: "ghcr.io/paperclipai/agent-runtime-opencode:git-38d8f371722b315d2fb3bbaa512518742e33ce2f",
  pi_local: "ghcr.io/paperclipai/agent-runtime-pi:git-38d8f371722b315d2fb3bbaa512518742e33ce2f",
};

type Target = "local" | "cloud";
interface DriverConfig {
  target: Target;
  apiKey: string | null;
  image: string | null;
  cpus: number;
  memoryMb: number;
  ttlSeconds: number;
  reuseLease: boolean;
}

function parseConfig(raw: Record<string, unknown>): DriverConfig {
  return {
    target: raw.target === "cloud" ? "cloud" : "local",
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : null,
    image: typeof raw.image === "string" && raw.image.trim() ? raw.image.trim() : null,
    cpus: raw.cpus == null ? 2 : Number(raw.cpus),
    memoryMb: raw.memoryMb == null ? 2048 : Number(raw.memoryMb),
    ttlSeconds: raw.ttlSeconds == null ? 3600 : Number(raw.ttlSeconds),
    reuseLease: raw.reuseLease === true,
  };
}

function connection(config: DriverConfig): ConnectOptions {
  return {
    target: config.target,
    handleSignals: false,
    ...(config.target === "cloud" && config.apiKey ? { apiKey: config.apiKey } : {}),
  };
}

function imageForRun(config: DriverConfig, adapterType?: string): string {
  if (config.image) return config.image;
  if (adapterType && RUNTIME_IMAGES[adapterType]) return RUNTIME_IMAGES[adapterType];
  if (adapterType) throw new Error(`No Smol Machines runtime image for adapter ${adapterType}; set image in the environment.`);
  return DEFAULT_PROBE_IMAGE;
}

function isNotFound(error: unknown): boolean {
  return error instanceof SmolError && error.code === "NOT_FOUND";
}

function verifyLeaseTarget(config: DriverConfig, lease: PluginEnvironmentLease): void {
  if (lease.metadata?.target != null && lease.metadata.target !== config.target) {
    throw new Error("Smol Machines lease target does not match the environment target.");
  }
}

async function connectLease(config: DriverConfig, id: string): Promise<Machine> {
  return Machine.connect(id, connection(config));
}

async function ensureWorkspace(machine: Machine, cwd: string): Promise<void> {
  const result = await machine.exec(["mkdir", "-p", "--", cwd], { timeout: 30 });
  if (result.exitCode !== 0) throw new Error(`Could not create sandbox workspace: ${result.stderr}`);
}

async function guestHome(machine: Machine): Promise<string> {
  // The default /workspace volume is owned by root. Paperclip runtime images
  // run as uid 1000, and the current Cloud control plane cannot change the
  // exec user. The image user's home stays writable and persists on its
  // container overlay when the VM stops and starts again.
  const home = await machine.exec(["sh", "-c", `printf '%s' "$HOME"`], { timeout: 15 });
  if (home.exitCode !== 0) throw new Error(`Could not resolve the sandbox home: ${home.stderr}`);
  const root = home.stdout.trim();
  if (!path.posix.isAbsolute(root)) throw new Error("Sandbox HOME must be an absolute path.");
  return root;
}

async function resolveWorkspace(machine: Machine): Promise<string> {
  const cwd = path.posix.join(await guestHome(machine), "paperclip-workspace");
  await ensureWorkspace(machine, cwd);
  return cwd;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ttlForRequest(config: DriverConfig, requestedExpiresAt?: string | null): number {
  if (!requestedExpiresAt) return config.ttlSeconds;
  const deadline = Date.parse(requestedExpiresAt);
  if (!Number.isFinite(deadline)) throw new Error("Invalid requested lease expiry.");
  // Round down: the VM must expire no later than the requested deadline.
  const seconds = Math.floor((deadline - Date.now()) / 1000);
  if (seconds < 1) throw new Error("Requested lease expiry is too close to create a VM.");
  return Math.min(config.ttlSeconds, seconds);
}

async function acquire(config: DriverConfig, params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
  if (config.target === "local" && params.requestedExpiresAt) {
    throw new Error("A local SmolVM cannot guarantee the requested lease expiry; use the cloud target.");
  }
  const ttlSeconds = ttlForRequest(config, params.requestedExpiresAt);
  const createdAt = Date.now();
  const image = imageForRun(config, params.adapterType);
  const spec: MachineConfig = {
    name: `paperclip-${randomUUID()}`,
    image,
    resources: { cpus: config.cpus, memoryMb: config.memoryMb, network: true },
    ...(config.target === "local" ? {
      persistent: true,
      detach: true,
      labels: {
        paperclipProvider: "smolmachines",
        companyId: params.companyId,
        environmentId: params.environmentId,
        runId: params.runId,
      },
    } : { ttlSeconds }),
  };
  const machine = await Machine.create(spec, connection(config));
  try {
    const remoteCwd = await resolveWorkspace(machine);
    const expiresAt = config.target === "cloud" ? new Date(createdAt + ttlSeconds * 1000).toISOString() : null;
    return {
      providerLeaseId: machine.name,
      metadata: { provider: "smolmachines", target: config.target, image, remoteCwd, ...(expiresAt ? { expiresAt } : {}) },
      ...(expiresAt ? { expiresAt } : {}),
    };
  } catch (error) {
    await machine.delete().catch(() => undefined);
    throw error;
  }
}

const plugin = definePlugin({
  async setup(ctx) { ctx.logger.info("Smol Machines sandbox provider ready"); },

  async onHealth() { return { status: "ok", message: "Smol Machines sandbox provider healthy" }; },

  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
    const raw = params.config;
    const config = parseConfig(raw);
    const errors: string[] = [];
    if (raw.target != null && raw.target !== "local" && raw.target !== "cloud") errors.push("target must be local or cloud.");
    if (typeof raw.image === "string" && !raw.image.trim()) errors.push("image cannot be blank.");
    if (typeof raw.apiKey === "string" && !raw.apiKey.trim()) errors.push("apiKey cannot be blank.");
    for (const [key, value, min, max] of [
      ["cpus", config.cpus, 1, 32],
      ["memoryMb", config.memoryMb, 256, 131072],
      ["ttlSeconds", config.ttlSeconds, 60, 86400],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < min || value > max) errors.push(`${key} must be an integer between ${min} and ${max}.`);
    }
    if (raw.reuseLease != null && typeof raw.reuseLease !== "boolean") errors.push("reuseLease must be a boolean.");
    return errors.length ? { ok: false, errors } : { ok: true, normalizedConfig: { ...config } };
  },

  async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    const config = parseConfig(params.config);
    // The probe uses a small image when no adapter is known; a lease selects its own image.
    let machine: Machine | undefined;
    try {
      machine = await Machine.create({
        image: config.image ?? DEFAULT_PROBE_IMAGE,
        resources: { cpus: config.cpus, memoryMb: config.memoryMb, network: true },
        ...(config.target === "cloud" ? { ttlSeconds: Math.min(config.ttlSeconds, 300) } : {}),
      }, connection(config));
      const result = await machine.exec(["sh", "-c", "command -v node && command -v tar && command -v sh"], { timeout: 30 });
      if (result.exitCode !== 0) throw new Error(result.stderr || "node, tar, or sh is missing from the image");
      return { ok: true, summary: `Smol Machines ${config.target} sandbox is ready.`, metadata: { provider: "smolmachines", target: config.target } };
    } catch (error) {
      return { ok: false, summary: `Smol Machines ${config.target} sandbox probe failed.`, metadata: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      if (machine) await machine.delete().catch(() => undefined);
    }
  },

  async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    return acquire(parseConfig(params.config), params);
  },

  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const lease = { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata };
    verifyLeaseTarget(config, lease);
    const expiresAt = typeof params.leaseMetadata?.expiresAt === "string" ? params.leaseMetadata.expiresAt : null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) return { providerLeaseId: null, metadata: { expired: true } };
    try {
      const machine = await connectLease(config, params.providerLeaseId);
      if (config.target === "cloud") await machine.start();
      await ensureWorkspace(machine, typeof params.leaseMetadata?.remoteCwd === "string" ? params.leaseMetadata.remoteCwd : await resolveWorkspace(machine));
      return { providerLeaseId: machine.name, metadata: { ...params.leaseMetadata, provider: "smolmachines", target: config.target, resumedLease: true }, ...(expiresAt ? { expiresAt } : {}) };
    } catch (error) {
      if (isNotFound(error)) return { providerLeaseId: null, metadata: { expired: true } };
      throw error;
    }
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseConfig(params.config);
    verifyLeaseTarget(config, { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata });
    try {
      const machine = await connectLease(config, params.providerLeaseId);
      if (config.reuseLease || params.resourceDisposition === "stop_and_retain") await machine.stop();
      else await machine.delete();
    } catch (error) { if (!isNotFound(error)) throw error; }
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseConfig(params.config);
    verifyLeaseTarget(config, { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata });
    try { await (await connectLease(config, params.providerLeaseId)).delete(); }
    catch (error) { if (!isNotFound(error)) throw error; }
  },

  async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseConfig(params.config);
    verifyLeaseTarget(config, params.lease);
    const cwd = typeof params.lease.metadata?.remoteCwd === "string"
      ? params.lease.metadata.remoteCwd
      : params.workspace.remotePath ?? FALLBACK_CWD;
    if (!path.posix.isAbsolute(cwd)) throw new Error("The sandbox workspace path must be absolute.");
    if (params.lease.providerLeaseId) await ensureWorkspace(await connectLease(config, params.lease.providerLeaseId), cwd);
    return { cwd, metadata: { provider: "smolmachines", remoteCwd: cwd } };
  },

  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) return { exitCode: 1, timedOut: false, stdout: "", stderr: "No provider lease ID available for execution." };
    const config = parseConfig(params.config);
    verifyLeaseTarget(config, params.lease);
    const machine = await connectLease(config, params.lease.providerLeaseId);
    // File uploads arrive owned by root. In the image user's home the user
    // owns the parent directory, so it can remove the file after exec.
    // /tmp has a sticky bit and prevents a non-root user removing it.
    const stdinPath = params.stdin == null ? null : path.posix.join(await guestHome(machine), `.paperclip-stdin-${randomUUID()}`);
    if (stdinPath) {
      try {
        await machine.writeFile(stdinPath, params.stdin!);
      } catch (error) {
        // Uploads may fail after creating a partial file. Keep the original
        // failure, but clean up anything the sandbox already received.
        await machine.exec(["rm", "-f", "--", stdinPath], { timeout: 15 }).catch(() => undefined);
        throw error;
      }
    }
    try {
      const command = stdinPath
        ? ["sh", "-c", `exec "$@" < ${shellQuote(stdinPath)}`, "sh", params.command, ...(params.args ?? [])]
        : [params.command, ...(params.args ?? [])];
      const result = await machine.exec(command, {
        ...(params.cwd ? { workdir: params.cwd } : {}),
        ...(params.env ? { env: params.env } : {}),
        timeout: Math.max(1, Math.ceil((params.timeoutMs ?? 1_800_000) / 1000)),
      });
      // The Cloud SDK caps convenience text at 1 MiB, but keeps the full
      // byte-exact output in stdoutBytes/stderrBytes when it flags truncation.
      const stdout = result.stdoutTruncated ? Buffer.from(result.stdoutBytes).toString("utf8") : result.stdout;
      const stderr = result.stderrTruncated ? Buffer.from(result.stderrBytes).toString("utf8") : result.stderr;
      return { exitCode: result.exitCode, timedOut: false, stdout, stderr };
    } catch (error) {
      if (error instanceof SmolError && error.code === "TIMEOUT") {
        return { exitCode: null, timedOut: true, stdout: "", stderr: `${error.message}\n` };
      }
      throw error;
    } finally {
      if (stdinPath) {
        const removed = await machine.exec(["rm", "-f", "--", stdinPath], { timeout: 15 });
        if (removed.exitCode !== 0) throw new Error(`Could not remove staged sandbox input: ${removed.stderr}`);
      }
    }
  },
});

export default plugin;
