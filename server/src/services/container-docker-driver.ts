import { spawn } from "node:child_process";
import type { ContainerEngineDriver, ContainerEngineDetail, ContainerEngineExecResult, ContainerEngineStartOpts } from "./container-service.js";

// ---------------------------------------------------------------------------
// CLI runner abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface CliRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CliRunner = (args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<CliRunnerResult>;

export interface DockerDriverOpts {
  /** Override the CLI binary path (defaults to "docker"). */
  cliBin?: string;
  /** Injectable CLI runner for testing. Defaults to spawn-based runner. */
  cliRunner?: CliRunner;
  /** Docker socket path override (NEVER passed to plugin workers). */
  socketPath?: string;
  /** Default memory limit in MB for containers (plugin can lower, not raise). */
  defaultMemoryMb?: number;
  /** Default pids limit for containers. */
  defaultPidsLimit?: number;
  /** Network mode for containers. Defaults to "none". */
  networkMode?: "none" | "bridge";
  /** When true, omits the --user=65534:65534 flag (operator opt-in only). */
  allowRootUser?: boolean;
}

const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_MEMORY_MB = 512;

// ---------------------------------------------------------------------------
// Safe env: strips DOCKER_HOST so plugin workers can't inherit it
// ---------------------------------------------------------------------------

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "DOCKER_HOST") continue; // must never leak to child
    if (v !== undefined) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Spawn-based CLI runner (production implementation)
// ---------------------------------------------------------------------------

function makeSpawnRunner(cliBin: string, socketPath?: string): CliRunner {
  return (args, runOpts) => {
    return new Promise((resolve, reject) => {
      // Use caller-supplied env (already built by run()) if present; otherwise build here.
      const env = runOpts?.env ?? safeEnv();
      if (socketPath && !env["DOCKER_HOST"]) {
        env["DOCKER_HOST"] = socketPath;
      }

      const child = spawn(cliBin, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (runOpts?.timeoutMs) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ stdout, stderr, exitCode: null });
        }, runOpts.timeoutMs);
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      });

      child.on("error", reject);
    });
  };
}

// ---------------------------------------------------------------------------
// Docker/Podman CLI driver
// ---------------------------------------------------------------------------

export interface DockerDriver extends ContainerEngineDriver {
  probe(): Promise<{ ok: boolean; summary?: string; error?: string }>;
}

// OCI image reference: optional registry/repo, required name, optional tag/digest.
// Rejects anything starting with '-' to block CLI option injection.
const OCI_IMAGE_RE = /^[a-z0-9]([a-z0-9._\-/:@]*[a-z0-9])?$/i;

function validateImage(image: string): void {
  if (!OCI_IMAGE_RE.test(image)) {
    throw new Error(`Invalid image reference: "${image}"`);
  }
}

function validateLabelKey(key: string): void {
  if (key.includes("=")) {
    throw new Error(`Invalid label key "${key}": must not contain '='`);
  }
}

function validateEnvKey(key: string): void {
  if (key.includes("=")) {
    throw new Error(`Invalid env key "${key}": must not contain '='`);
  }
}

export function createDockerDriver(opts: DockerDriverOpts): DockerDriver {
  const cliBin = opts.cliBin ?? "docker";
  const runner = opts.cliRunner ?? makeSpawnRunner(cliBin, opts.socketPath);
  const defaultMemoryMb = opts.defaultMemoryMb ?? DEFAULT_MEMORY_MB;
  const defaultPidsLimit = opts.defaultPidsLimit ?? DEFAULT_PIDS_LIMIT;
  const networkMode = opts.networkMode ?? "none";
  const allowRootUser = opts.allowRootUser ?? false;

  async function run(args: string[], runOpts?: { timeoutMs?: number }): Promise<CliRunnerResult> {
    const env = safeEnv();
    if (opts.socketPath) env["DOCKER_HOST"] = opts.socketPath;
    return runner(args, { env, timeoutMs: runOpts?.timeoutMs });
  }

  return {
    async start(startOpts) {
      validateImage(startOpts.image);
      for (const k of Object.keys(startOpts.labels ?? {})) validateLabelKey(k);
      for (const k of Object.keys(startOpts.env ?? {})) validateEnvKey(k);

      const args: string[] = ["run", "-d", "--rm"];

      // Mandatory hardening — not overridable by plugins
      args.push("--cap-drop=ALL");
      args.push("--security-opt=no-new-privileges:true");
      args.push("--pids-limit=" + String(defaultPidsLimit));
      if (!allowRootUser) {
        args.push("--user=65534:65534");
      }
      args.push("--read-only");

      // Network mode (operator-configured; plugins cannot override)
      args.push(`--network=${networkMode}`);

      // Resource limits
      const memMb = startOpts.memoryMb ?? defaultMemoryMb;
      args.push(`--memory=${memMb}m`);
      args.push(`--memory-swap=${memMb}m`);

      // Labels — host-controlled; plugin labels arrive pre-sanitized from ContainerService
      for (const [k, v] of Object.entries(startOpts.labels ?? {})) {
        args.push(`--label=${k}=${v}`);
      }

      // Environment variables
      for (const [k, v] of Object.entries(startOpts.env ?? {})) {
        args.push(`-e`, `${k}=${v}`);
      }

      // -- terminates option parsing so image name cannot be a flag
      args.push("--");
      args.push(startOpts.image);

      if (startOpts.cmd && startOpts.cmd.length > 0) {
        args.push(...startOpts.cmd);
      }

      const result = await run(args);
      if (result.exitCode !== 0) {
        throw new Error(`docker run failed: ${result.stderr || result.stdout}`);
      }

      return { engineContainerId: result.stdout };
    },

    async stop(engineContainerId) {
      const result = await run(["stop", engineContainerId]);
      if (result.exitCode !== 0) {
        throw new Error(`docker stop failed: ${result.stderr}`);
      }
    },

    async kill(engineContainerId) {
      const result = await run(["rm", "-f", engineContainerId]);
      if (result.exitCode !== 0) {
        throw new Error(`docker rm -f failed: ${result.stderr}`);
      }
    },

    async exec(engineContainerId, cmd, execOpts) {
      const args = ["exec"];
      for (const [k, v] of Object.entries(execOpts?.env ?? {})) {
        validateEnvKey(k);
        args.push("-e", `${k}=${v}`);
      }
      args.push(engineContainerId, ...cmd);

      const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
      const result = await run(args, { timeoutMs: execOpts?.timeoutMs });

      const truncated =
        result.stdout.length >= MAX_OUTPUT_BYTES || result.stderr.length >= MAX_OUTPUT_BYTES;

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
        truncated,
      };
    },

    async list(listOpts) {
      const args = ["ps", "--format={{json .}}", "--no-trunc"];

      if (listOpts?.labelFilter) {
        for (const [k, v] of Object.entries(listOpts.labelFilter)) {
          args.push(`--filter=label=${k}=${v}`);
        }
      }

      const result = await run(args);
      if (result.exitCode !== 0) return [];

      const containers: ContainerEngineDetail[] = [];
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const labelsRaw = (row["Labels"] as string) ?? "";
          const labels: Record<string, string> = {};
          for (const pair of labelsRaw.split(",").filter(Boolean)) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx === -1) continue;
            const k = pair.slice(0, eqIdx);
            const v = pair.slice(eqIdx + 1);
            if (k) labels[k] = v;
          }
          containers.push({
            engineContainerId: String(row["ID"] ?? ""),
            image: String(row["Image"] ?? ""),
            status: String(row["State"] ?? "unknown"),
            createdAt: String(row["CreatedAt"] ?? new Date().toISOString()),
            labels,
          });
        } catch {
          // skip malformed line
        }
      }
      return containers;
    },

    async inspect(engineContainerId) {
      const args = ["inspect", "--format={{json .}}", engineContainerId];
      const result = await run(args);
      if (result.exitCode !== 0) return null;

      try {
        const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
        const row = rows[0];
        if (!row) return null;

        const config = row["Config"] as Record<string, unknown> | undefined;
        const state = row["State"] as Record<string, unknown> | undefined;
        const labelsRaw = (config?.["Labels"] as Record<string, string>) ?? {};

        return {
          engineContainerId,
          image: String(config?.["Image"] ?? ""),
          status: String(state?.["Status"] ?? "unknown"),
          createdAt: String(row["Created"] ?? new Date().toISOString()),
          labels: labelsRaw,
        };
      } catch {
        return null;
      }
    },

    async onStartup() {
      // On startup, kill any orphaned containers (those with paperclip.* labels
      // that survived a crash). Best-effort — failures are logged but not thrown.
      try {
        const containers = await this.list({ labelFilter: { "paperclip.managed": "true" } });
        await Promise.allSettled(containers.map((c) => this.kill(c.engineContainerId)));
      } catch {
        // non-critical startup cleanup
      }
    },

    async dispose() {},

    async probe() {
      const result = await run(["info", "--format={{json .ServerVersion}}"], { timeoutMs: 5000 });
      if (result.exitCode === 0 && result.stdout) {
        return { ok: true, summary: `Docker ${result.stdout.replace(/"/g, "")}` };
      }
      return { ok: false, error: result.stderr || "Docker daemon unreachable" };
    },
  };
}
