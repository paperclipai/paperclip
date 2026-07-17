import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentHealthRuntimeServiceParams,
  PluginEnvironmentHealthRuntimeServiceResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentStartRuntimeServiceParams,
  PluginEnvironmentStartRuntimeServiceResult,
  PluginEnvironmentStopRuntimeServiceParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

const WORKSPACE_PATH = "/workspace";
const SERVICE_PORT = 3107;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

export interface DockerDriverConfig {
  image: string;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export interface DockerCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type DockerRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<DockerCommandResult>;

export interface DockerRuntimeService {
  providerLeaseId: string;
  serviceName: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

type DockerInspect = {
  Id?: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function parseDockerDriverConfig(raw: Record<string, unknown>): DockerDriverConfig {
  const image = typeof raw.image === "string" && SAFE_IMAGE.test(raw.image) ? raw.image : "paperclip-noble-qa:24.04";
  return {
    image,
    timeoutMs: boundedNumber(raw.timeoutMs, 300_000, 1_000, MAX_TIMEOUT_MS),
    memoryMb: boundedNumber(raw.memoryMb, 2_048, 256, 16_384),
    cpus: boundedNumber(raw.cpus, 2, 1, 16),
    pidsLimit: boundedNumber(raw.pidsLimit, 512, 64, 4_096),
  };
}

function configError(raw: Record<string, unknown>): string | null {
  if (typeof raw.image === "string" && !SAFE_IMAGE.test(raw.image)) {
    return "image must be a Docker image reference without whitespace or shell syntax";
  }
  for (const key of ["timeoutMs", "memoryMb", "cpus", "pidsLimit"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) {
      return `${key} must be a finite number`;
    }
  }
  return null;
}

function fingerprint(config: DockerDriverConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function labelPart(value: string | null | undefined): string {
  return (value ?? "none").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "none";
}

export function buildLeaseLabels(input: {
  companyId: string;
  environmentId: string;
  executionWorkspaceId?: string | null;
  runId: string;
  leaseNonce: string;
  config: DockerDriverConfig;
}): Record<string, string> {
  return {
    "com.paperclip.managed": "true",
    "com.paperclip.provider": "docker",
    "com.paperclip.company": labelPart(input.companyId),
    "com.paperclip.environment": labelPart(input.environmentId),
    "com.paperclip.workspace": labelPart(input.executionWorkspaceId),
    "com.paperclip.run": labelPart(input.runId),
    "com.paperclip.lease": labelPart(input.leaseNonce),
    "com.paperclip.config-fingerprint": fingerprint(input.config),
  };
}

export function buildDockerRunArgs(input: {
  containerName: string;
  labels: Record<string, string>;
  config: DockerDriverConfig;
}): string[] {
  const args = [
    "run", "--detach", "--init", "--name", input.containerName,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(input.config.pidsLimit),
    "--memory", `${input.config.memoryMb}m`, "--cpus", String(input.config.cpus),
    "--publish", `127.0.0.1::${SERVICE_PORT}`,
  ];
  for (const [key, value] of Object.entries(input.labels)) args.push("--label", `${key}=${value}`);
  args.push(input.config.image, "sleep", "infinity");
  return args;
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current));
  if (remaining === 0) return { text: current, truncated: true };
  const content = chunk.subarray(0, remaining).toString();
  return { text: current + content, truncated: chunk.length > remaining };
}

export function runDockerCli(args: string[], options: { timeoutMs?: number } = {}): Promise<DockerCommandResult> {
  const timeoutMs = boundedNumber(options.timeoutMs, 30_000, 1_000, MAX_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, MAX_OUTPUT_BYTES);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, MAX_OUTPUT_BYTES);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : exitCode, signal, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

function failure(result: DockerCommandResult, operation: string): Error {
  return new Error(`${operation} failed${result.timedOut ? " (timed out)" : ""}: ${result.stderr.trim() || result.stdout.trim() || "Docker returned a non-zero status"}`);
}

async function mustRun(runner: DockerRunner, args: string[], options?: { timeoutMs?: number }): Promise<DockerCommandResult> {
  const result = await runner(args, options);
  if (result.exitCode !== 0 || result.timedOut) throw failure(result, `docker ${args[0] ?? "command"}`);
  return result;
}

async function inspectLease(runner: DockerRunner, providerLeaseId: string): Promise<DockerInspect | null> {
  const result = await runner(["inspect", providerLeaseId], { timeoutMs: 20_000 });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as DockerInspect[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

function expectedLeaseLabels(params: { companyId: string; environmentId: string; config: DockerDriverConfig }) {
  return {
    "com.paperclip.managed": "true",
    "com.paperclip.provider": "docker",
    "com.paperclip.company": labelPart(params.companyId),
    "com.paperclip.environment": labelPart(params.environmentId),
    "com.paperclip.config-fingerprint": fingerprint(params.config),
  };
}

function isOwnedLease(inspect: DockerInspect | null, expected: Record<string, string>): boolean {
  const labels = inspect?.Config?.Labels;
  return Boolean(labels && Object.entries(expected).every(([key, value]) => labels[key] === value));
}

function hostPort(inspect: DockerInspect): number | null {
  const binding = inspect.NetworkSettings?.Ports?.[`${SERVICE_PORT}/tcp`]?.[0];
  if (!binding || binding.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort ?? "")) return null;
  const port = Number(binding.HostPort);
  return port > 0 && port < 65_536 ? port : null;
}

function validContainerCwd(cwd: string | undefined): string {
  const selected = path.posix.normalize(cwd?.trim() || WORKSPACE_PATH);
  if (!selected.startsWith(`${WORKSPACE_PATH}/`) && selected !== WORKSPACE_PATH) {
    throw new Error(`Docker sandbox cwd must be inside ${WORKSPACE_PATH}`);
  }
  if (selected.includes("\0")) throw new Error("Docker sandbox cwd contains a null byte");
  return selected;
}

function validCommand(command: string, args: string[] | undefined, env: Record<string, string> | undefined) {
  if (!command || command.includes("\0")) throw new Error("Docker sandbox command must be non-empty and contain no null bytes");
  for (const arg of args ?? []) if (arg.includes("\0")) throw new Error("Docker sandbox argument contains a null byte");
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!SAFE_ENV_KEY.test(key) || value.includes("\0")) throw new Error("Docker sandbox environment contains an invalid key or null byte");
  }
}

function servicePidPath(serviceName: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(serviceName)) throw new Error("Docker runtime service name is invalid");
  return `/tmp/paperclip-services/${serviceName}.pid`;
}

/**
 * Start a configured runtime command inside the lease. The service command is
 * passed as a positional argument to the container shell; it is never parsed
 * by the trusted host process.
 */
export async function startDockerRuntimeService(runner: DockerRunner, service: DockerRuntimeService): Promise<{ providerRef: string }> {
  if (!service.providerLeaseId || service.providerLeaseId.includes("\0") || service.command.includes("\0")) {
    throw new Error("Docker runtime service has an invalid lease id or command");
  }
  validCommand(service.command, undefined, service.env);
  const pidPath = servicePidPath(service.serviceName);
  const cwd = validContainerCwd(service.cwd);
  const script = "mkdir -p /tmp/paperclip-services; (exec /bin/sh -lc \"$1\") >/tmp/paperclip-services/$2.log 2>&1 & pid=$!; echo \"$pid\" >\"$3\"; wait \"$pid\"";
  const args = ["exec", "--detach", "--workdir", cwd, "--user", "paperclip"];
  for (const [key, value] of Object.entries(service.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push(service.providerLeaseId, "/bin/sh", "-lc", script, "paperclip-service", service.command, service.serviceName, pidPath);
  await mustRun(runner, args, { timeoutMs: 30_000 });
  return { providerRef: `${service.providerLeaseId}:${service.serviceName}` };
}

export async function stopDockerRuntimeService(runner: DockerRunner, service: Pick<DockerRuntimeService, "providerLeaseId" | "serviceName">): Promise<void> {
  const pidPath = servicePidPath(service.serviceName);
  const script = "if test -r \"$1\"; then pid=$(cat \"$1\"); kill \"$pid\" 2>/dev/null || true; rm -f \"$1\"; fi";
  const result = await runner(["exec", "--user", "paperclip", service.providerLeaseId, "/bin/sh", "-lc", script, "paperclip-service-stop", pidPath], { timeoutMs: 30_000 });
  if (result.exitCode !== 0 && !result.timedOut) throw failure(result, "docker exec service stop");
}

export async function healthDockerRuntimeService(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/|$)/.test(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function metadata(params: { providerLeaseId: string; inspect: DockerInspect; config: DockerDriverConfig }) {
  const port = hostPort(params.inspect);
  return {
    provider: "docker",
    image: params.config.image,
    remoteCwd: WORKSPACE_PATH,
    configFingerprint: fingerprint(params.config),
    port3107HostPort: port,
    port3107Url: port ? `http://127.0.0.1:${port}` : null,
    containerId: params.providerLeaseId,
  };
}

async function releaseDockerLease(input: {
  runner: DockerRunner;
  companyId: string;
  environmentId: string;
  config: DockerDriverConfig;
  providerLeaseId: string | null;
}): Promise<void> {
  if (!input.providerLeaseId) return;
  const inspect = await inspectLease(input.runner, input.providerLeaseId);
  if (!inspect) return;
  if (!isOwnedLease(inspect, expectedLeaseLabels(input))) {
    throw new Error("Refusing to remove a Docker container that is not this exact Paperclip lease");
  }
  await mustRun(input.runner, ["rm", "--force", input.providerLeaseId], { timeoutMs: 30_000 });
}

export function createDockerSandboxPlugin(runner: DockerRunner = runDockerCli) {
  return definePlugin({
    async setup(ctx) { ctx.logger.info("Docker sandbox provider plugin ready"); },
    async onHealth() { return { status: "ok", message: "Docker sandbox provider plugin healthy" }; },
    async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
      const error = configError(params.config);
      if (error) return { ok: false, errors: [error] };
      return { ok: true, normalizedConfig: parseDockerDriverConfig(params.config) as unknown as Record<string, unknown> };
    },
    async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
      const config = parseDockerDriverConfig(params.config);
      try {
        const result = await mustRun(runner, ["info", "--format", "{{json .ServerVersion}}"], { timeoutMs: 20_000 });
        return { ok: true, summary: `Docker daemon reachable for ${config.image}.`, metadata: { provider: "docker", image: config.image, dockerVersion: result.stdout.trim() } };
      } catch (error) {
        return { ok: false, summary: "Docker daemon probe failed.", diagnostics: [{ severity: "error", code: "docker_unavailable", message: error instanceof Error ? error.message : String(error) }] };
      }
    },
    async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
      const config = parseDockerDriverConfig(params.config);
      const leaseNonce = randomUUID();
      const labels = buildLeaseLabels({ companyId: params.companyId, environmentId: params.environmentId, executionWorkspaceId: params.executionWorkspaceId, runId: params.runId, leaseNonce, config });
      const name = `paperclip-${labelPart(params.runId).slice(0, 36)}-${leaseNonce.slice(0, 8)}`;
      const created = await mustRun(runner, buildDockerRunArgs({ containerName: name, labels, config }), { timeoutMs: config.timeoutMs });
      const providerLeaseId = created.stdout.trim();
      if (!providerLeaseId) throw new Error("Docker did not return a container id for the new lease");
      const inspect = await inspectLease(runner, providerLeaseId);
      if (!isOwnedLease(inspect, expectedLeaseLabels({ companyId: params.companyId, environmentId: params.environmentId, config }))) {
        await runner(["rm", "--force", providerLeaseId], { timeoutMs: 20_000 }).catch(() => undefined);
        throw new Error("Created Docker container did not have the expected Paperclip ownership labels");
      }
      return { providerLeaseId, metadata: metadata({ providerLeaseId, inspect: inspect!, config }) };
    },
    async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
      const config = parseDockerDriverConfig(params.config);
      const inspect = await inspectLease(runner, params.providerLeaseId);
      if (!isOwnedLease(inspect, expectedLeaseLabels({ companyId: params.companyId, environmentId: params.environmentId, config })) || !inspect?.State?.Running) {
        throw new Error("Docker sandbox lease has expired or no longer matches its Paperclip identity");
      }
      return { providerLeaseId: params.providerLeaseId, metadata: metadata({ providerLeaseId: params.providerLeaseId, inspect, config }) };
    },
    async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
      const config = parseDockerDriverConfig(params.config);
      await releaseDockerLease({ runner, companyId: params.companyId, environmentId: params.environmentId, config, providerLeaseId: params.providerLeaseId });
    },
    async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
      const config = parseDockerDriverConfig(params.config);
      await releaseDockerLease({ runner, companyId: params.companyId, environmentId: params.environmentId, config, providerLeaseId: params.providerLeaseId });
    },
    async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const config = parseDockerDriverConfig(params.config);
      if (!params.lease.providerLeaseId) throw new Error("Docker sandbox lease id is required to realize a workspace");
      const inspect = await inspectLease(runner, params.lease.providerLeaseId);
      if (!isOwnedLease(inspect, expectedLeaseLabels({ companyId: params.companyId, environmentId: params.environmentId, config })) || !inspect?.State?.Running) {
        throw new Error("Docker sandbox lease is unavailable for workspace realization");
      }
      await mustRun(runner, ["exec", "--user", "paperclip", params.lease.providerLeaseId, "mkdir", "-p", WORKSPACE_PATH], { timeoutMs: 20_000 });
      return { cwd: WORKSPACE_PATH, metadata: metadata({ providerLeaseId: params.lease.providerLeaseId, inspect, config }) };
    },
    async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
      const config = parseDockerDriverConfig(params.config);
      if (!params.lease.providerLeaseId) throw new Error("Docker sandbox lease id is required to execute a command");
      validCommand(params.command, params.args, params.env);
      const cwd = validContainerCwd(params.cwd);
      const args = ["exec", "--workdir", cwd, "--user", "paperclip"];
      for (const [key, value] of Object.entries(params.env ?? {})) args.push("--env", `${key}=${value}`);
      args.push(params.lease.providerLeaseId, params.command, ...(params.args ?? []));
      const result = await runner(args, { timeoutMs: boundedNumber(params.timeoutMs, config.timeoutMs, 1_000, MAX_TIMEOUT_MS) });
      return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, metadata: { provider: "docker", stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated } };
    },
    async onEnvironmentStartRuntimeService(params: PluginEnvironmentStartRuntimeServiceParams): Promise<PluginEnvironmentStartRuntimeServiceResult> {
      if (!params.lease.providerLeaseId) throw new Error("Docker sandbox lease id is required to start a runtime service");
      const started = await startDockerRuntimeService(runner, {
        providerLeaseId: params.lease.providerLeaseId,
        serviceName: params.service.serviceName,
        command: params.service.command,
        cwd: params.service.cwd,
        env: params.service.env,
      });
      return { ...started, url: params.service.url ?? null, metadata: { provider: "docker", providerLeaseId: params.lease.providerLeaseId } };
    },
    async onEnvironmentStopRuntimeService(params: PluginEnvironmentStopRuntimeServiceParams): Promise<void> {
      if (!params.lease.providerLeaseId) throw new Error("Docker sandbox lease id is required to stop a runtime service");
      await stopDockerRuntimeService(runner, { providerLeaseId: params.lease.providerLeaseId, serviceName: params.serviceName });
    },
    async onEnvironmentHealthRuntimeService(params: PluginEnvironmentHealthRuntimeServiceParams): Promise<PluginEnvironmentHealthRuntimeServiceResult> {
      const url = params.readinessUrl ?? params.url ?? null;
      return { healthy: url ? await healthDockerRuntimeService(url) : true, url, metadata: { provider: "docker" } };
    },
  });
}

const plugin = createDockerSandboxPlugin();
export default plugin;
