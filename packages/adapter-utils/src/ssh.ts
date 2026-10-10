import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  createUnrelatedHistoryGraftCommit,
  GIT_SYNC_COMMIT_IDENTITY_ARGS,
  PROJECT_REPOSITORIES_DIR,
  readSanitizedOriginRemoteUrl,
} from "./git-workspace-sync.js";
import type { RunProcessResult } from "./server-utils.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";
import { mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
} from "./runtime-progress.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
}

export interface SshRemoteExecutionSpec extends SshConnectionConfig {
  remoteCwd: string;
}

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const envEntries = Object.entries(commandInput.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      const envPrefix = envEntries.length > 0
        ? `env ${envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `
        : "";
      const exportPrefix = envEntries.length > 0
        ? envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ") + " "
        : "";
      const commandScript = command === "sh" || command === "bash"
        ? (args[0] === "-c" || args[0] === "-lc") && typeof args[1] === "string"
          ? `${exportPrefix}${args[1]}`
          : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`
        : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `cd ${shellQuote(cwd)} && ${commandScript}`;

      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export interface SshEnvLabSupport {
  supported: boolean;
  reason: string | null;
}

export interface SshEnvLabFixtureState {
  kind: "ssh_openbsd";
  bindHost: string;
  host: string;
  port: number;
  username: string;
  rootDir: string;
  workspaceDir: string;
  statePath: string;
  pid: number;
  createdAt: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  hostPrivateKeyPath: string;
  hostPublicKeyPath: string;
  authorizedKeysPath: string;
  knownHostsPath: string;
  sshdConfigPath: string;
  sshdLogPath: string;
}

interface LocalGitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseSshRemoteExecutionSpec(value: unknown): SshRemoteExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
  const remoteCwd = typeof parsed.remoteCwd === "string" ? parsed.remoteCwd.trim() : "";
  const portValue = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
  if (!host || !username || !remoteCwd || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return null;
  }

  return {
    host,
    port: portValue,
    username,
    remoteCwd,
    remoteWorkspacePath:
      typeof parsed.remoteWorkspacePath === "string" && parsed.remoteWorkspacePath.trim().length > 0
        ? parsed.remoteWorkspacePath.trim()
        : remoteCwd,
    privateKey: typeof parsed.privateKey === "string" && parsed.privateKey.length > 0 ? parsed.privateKey : null,
    knownHosts: typeof parsed.knownHosts === "string" && parsed.knownHosts.length > 0 ? parsed.knownHosts : null,
    strictHostKeyChecking:
      typeof parsed.strictHostKeyChecking === "boolean" ? parsed.strictHostKeyChecking : true,
  };
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await execFileText("git", ["-C", localDir, ...args], options);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-c", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}

function tarExcludeArgs(exclude: string[] | undefined): string[] {
  const combined = ["._*", ...(exclude ?? [])];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

// Converts a tar `--exclude` pattern into a regexp for the local-size estimate.
// We only need approximate fidelity here (the estimate feeds a clamped percent),
// so we support the literal names and `*`/`?` globs used in practice.
function tarPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Walks `localDir` summing regular-file sizes, mirroring tar's `--exclude`
// handling (plus the implicit `._*`) and `followSymlinks` so the to-ssh upload
// can report an estimated total before tar finishes producing the stream.
async function estimateLocalDirSize(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map(tarPatternToRegExp);
  const isExcluded = (relPath: string, base: string) =>
    regexes.some((regex) => regex.test(relPath) || regex.test(base));

  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = await (input.followSymlinks ? fs.stat(full) : fs.lstat(full)).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(full, entryRelative);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };
  await walk(input.localDir, "");
  return total;
}

// Best-effort remote size probe for the from-ssh restore. `du -sk` is POSIX and
// available on the BSD/Linux remotes we target; it over-counts (block-rounded,
// includes excluded dirs) which keeps the reported percent safely below 100
// until the stream actually closes. Returns null when unavailable so the caller
// falls back to MB-received mode.
async function probeRemoteDirSize(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
}): Promise<number | null> {
  try {
    const result = await runSshScript(
      input.spec,
      `du -sk ${shellQuote(input.remoteDir)} 2>/dev/null | cut -f1`,
      { timeoutMs: 15_000, maxBuffer: 16 * 1024 },
    );
    const kilobytes = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

interface TransferProgress {
  // Backpressure-respecting counter to splice into a transport pipe.
  counter: Transform;
  // Last cumulative byte count observed by the counter.
  transferred: () => number;
  // Emit the terminal completion line. Idempotent.
  finish: () => Promise<void>;
  // Emit a terminal failure marker instead of a completion line. Idempotent.
  fail: () => Promise<void>;
}

// Wraps a throttled progress reporter behind a counting Transform so transports
// can `source.pipe(progress.counter).pipe(dest)`. When `totalBytes` is a known
// exact size (e.g. a git bundle) the reporter emits an exact percentage. When it
// is an estimate (tar upload / remote probe) we clamp the reported bytes to 99%
// of the estimate so an inaccurate total never shows a premature 100%; `finish`
// then emits the terminal 100% (or, in MB-only mode, the final MB) line.
//
// `totalBytes` may be a promise so an expensive size estimate (a local dir walk
// or a remote `du` probe) runs concurrently with the transfer instead of
// blocking the pipe from opening. Until it resolves the counter reports bytes in
// MB-only mode, then adopts the percentage once the total is known; `finish`
// awaits the estimate so the terminal 100% line is still guaranteed.
function createTransferProgress(input: {
  onProgress: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  direction: RuntimeProgressDirection;
  label?: string;
  totalBytes: number | null | Promise<number | null>;
  estimated: boolean;
}): TransferProgress {
  const reporter = createRuntimeProgressReporter({
    sink: input.onProgress,
    phase: input.phase,
    direction: input.direction,
    label: input.label,
    target: "ssh",
  });

  let total: number | null = null;
  let cap: number | null = null;
  const applyTotal = (value: number | null) => {
    total = value != null && value > 0 ? value : null;
    cap = total != null && input.estimated ? Math.floor(total * 0.99) : null;
  };
  const totalReady: Promise<void> =
    input.totalBytes != null && typeof (input.totalBytes as Promise<number | null>).then === "function"
      ? (input.totalBytes as Promise<number | null>).then(applyTotal, () => applyTotal(null))
      : (applyTotal(input.totalBytes as number | null), Promise.resolve());

  let transferred = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch(() => undefined);
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const reported = cap != null ? Math.min(transferred, cap) : transferred;
      const totalSnapshot = total;
      enqueue(() => reporter.report(reported, totalSnapshot));
      callback(null, chunk);
    },
  });

  return {
    counter,
    transferred: () => transferred,
    finish: async () => {
      await chain.catch(() => undefined);
      await totalReady.catch(() => undefined);
      await reporter.complete(total != null ? total : transferred, total).catch(() => undefined);
    },
    fail: async () => {
      await chain.catch(() => undefined);
      await reporter.fail(transferred, total).catch(() => undefined);
    },
  };
}

async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    script,
    options,
  );
}

async function clearLocalDirectory(
  localDir: string,
  preserveEntries: string[] = [],
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const preserve = new Set(preserveEntries);
  const entries = await fs.readdir(localDir);
  await Promise.all(
    entries
      .filter((entry) => !preserve.has(entry))
      .map((entry) => fs.rm(path.join(localDir, entry), { recursive: true, force: true })),
  );
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }));
}

async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      ssh.kill("SIGTERM");
      reject(error);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    if (input.progress) {
      input.progress.counter.on("error", fail);
      source.pipe(input.progress.counter).pipe(ssh.stdin ?? null);
    } else {
      source.pipe(ssh.stdin ?? null);
    }
    ssh.on("close", (code) => {
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = createWriteStream(input.localFile, { mode: 0o600 });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      ssh.kill("SIGTERM");
      sink.destroy();
      reject(error);
    };

    if (input.progress) {
      input.progress.counter.on("error", fail);
      ssh.stdout?.pipe(input.progress.counter).pipe(sink);
    } else {
      ssh.stdout?.pipe(sink);
    }
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    ssh.on("error", fail);
    sink.on("error", fail);
    ssh.on("close", (code) => {
      sink.end(() => {
        if (settled) return;
        settled = true;
        if ((code ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        resolve();
      });
    });
  }).finally(auth.cleanup);
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  // Per-import unique ref so concurrent imports against the same local repo
  // can't race on `update-ref` between this run's update and bundle create.
  const tempRef = `refs/paperclip/ssh-sync/import/${randomUUID()}`;

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      // Carry the workspace's (credential-scrubbed) origin into the transported
      // repo so branches there keep a publishable remote instead of reading as
      // remote-less snapshots. set-url covers a reused workspace whose origin
      // changed; add covers the fresh-init case. Best-effort under `set -e`.
      ...(originUrl
        ? [
          `{ git -C ${shellQuote(input.remoteDir)} remote set-url origin ${shellQuote(originUrl)} >/dev/null 2>&1 || git -C ${shellQuote(input.remoteDir)} remote add origin ${shellQuote(originUrl)} >/dev/null 2>&1; } || true`,
        ]
        : []),
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
      // Drop the per-import ref on the remote side too so it can't accumulate.
      `git -C ${shellQuote(input.remoteDir)} update-ref -d ${shellQuote(tempRef)} >/dev/null 2>&1 || true`,
    ].join("\n");

    // The git bundle is a real local file of known size, so report an exact
    // percentage. No `workspace` label: the "Importing git history" phase is
    // already self-describing in the log line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Importing git history",
        direction: "to",
        totalBytes: (await fs.stat(bundlePath)).size,
        estimated: false,
      })
      : null;

    try {
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: remoteSetupScript,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  importedRef?: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = input.importedRef ?? `refs/paperclip/ssh-sync/imported/${randomUUID()}`;

  try {
    const exportScript = [
      "set -e",
      `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
      'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
      'trap cleanup EXIT',
      `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" refs/paperclip/ssh-sync/export >/dev/null`,
      'cat "$tmp_bundle"',
    ].join("\n");

    // The remote bundle size isn't known before streaming, so report bytes
    // received (MB mode) with a terminal completion line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Exporting git history",
        direction: "from",
        totalBytes: null,
        estimated: false,
      })
      : null;

    try {
      await streamSshToLocalFile({
        spec: input.spec,
        remoteScript: exportScript,
        localFile: bundlePath,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }

    await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    }
    const importedHead = await runLocalGit(input.localDir, ["rev-parse", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return importedHead.stdout.trim();
  } finally {
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    // `git merge-base` exits 1 when the commits share no ancestor — the only
    // outcome that authorizes the graft fallback below. Every other failure
    // (timeout, missing object, repository error) must keep failing the
    // integration instead of silently rewriting the tip.
    let noCommonAncestor = false;
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch((error: unknown) => {
      noCommonAncestor = (error as { code?: unknown } | null)?.code === 1;
      return null;
    });
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    if (noCommonAncestor) {
      // No common ancestor — merging is impossible and failing here would
      // discard the imported work. Graft it onto the current head instead;
      // see createUnrelatedHistoryGraftCommit.
      const graftCommit = await createUnrelatedHistoryGraftCommit({
        localDir: input.localDir,
        currentHead,
        importedHead: input.importedHead,
        syncLabel: "Paperclip SSH sync",
      });
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, graftCommit, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent SSH git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for SSH workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        ...GIT_SYNC_COMMIT_IDENTITY_ARGS,
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip SSH sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent SSH git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

const PROJECT_REPOSITORY_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

async function isLocalGitRepositoryRoot(localDir: string): Promise<boolean> {
  try {
    const toplevel = await runLocalGit(localDir, ["rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const [directory, repository] = await Promise.all([
      fs.realpath(localDir),
      fs.realpath(toplevel.stdout.trim()),
    ]);
    return directory === repository;
  } catch {
    return false;
  }
}

async function listLocalProjectRepositories(localDir: string): Promise<string[]> {
  const root = path.join(localDir, PROJECT_REPOSITORIES_DIR);
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Invalid project repositories directory");
  }
  const repositories: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROJECT_REPOSITORY_NAME_PATTERN.test(entry.name)) {
      throw new Error("Invalid project repository directory");
    }
    const relative = `${PROJECT_REPOSITORIES_DIR}/${entry.name}`;
    if (!(await isLocalGitRepositoryRoot(path.join(localDir, relative)))) {
      throw new Error(`Project repository is not a Git checkout: ${relative}`);
    }
    repositories.push(relative);
  }
  return repositories.sort();
}

async function transportGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  exclude?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
}): Promise<void> {
  await importGitWorkspaceToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    snapshot: input.snapshot,
    onProgress: input.onProgress,
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    exclude: [".git", ".paperclip-runtime", ...(input.exclude ?? [])],
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  });
  await removeDeletedPathsOnSsh({
    spec: input.spec,
    remoteDir: input.remoteDir,
    deletedPaths: input.snapshot.deletedPaths,
  });
}

async function excludeProjectRepositoriesOnSsh(spec: SshConnectionConfig, remoteDir: string): Promise<void> {
  const pattern = `/${PROJECT_REPOSITORIES_DIR}/`;
  const excludeFile = path.posix.join(remoteDir, ".git", "info", "exclude");
  await runSshScript(
    spec,
    `mkdir -p ${shellQuote(path.posix.dirname(excludeFile))} && ` +
      `{ grep -qxF ${shellQuote(pattern)} ${shellQuote(excludeFile)} 2>/dev/null || ` +
      `printf '\\n%s\\n' ${shellQuote(pattern)} >> ${shellQuote(excludeFile)}; }`,
    { timeoutMs: 30_000 },
  );
}

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  if (process.platform === "darwin" && process.env.PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB !== "1") {
    return {
      supported: false,
      reason: "SSH env-lab fixture is disabled on macOS; set PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1 to opt in.",
    };
  }

  for (const command of ["ssh", "sshd", "ssh-keygen"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    const envEntries = Object.entries(options.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    for (const [key] of envEntries) {
      if (!isValidShellEnvKey(key)) {
        throw new Error(`Invalid SSH environment variable key: ${key}`);
      }
    }

    // Mirror buildSshSpawnTarget: source the login profiles first, then run
    // `env KEY=VAL cmd` so user-supplied identity overrides win over anything a
    // profile re-exports. The SSH target is an operator-configured host, not a
    // Paperclip sandbox image, so it can expose `node` or an agent CLI only
    // through a login profile; a non-login SSH command would miss that PATH.
    // Source `/etc/profile` first so a host that exposes the PATH through
    // `/etc/profile.d` scripts still resolves node and the agent CLI.
    // The script no longer sources `nvm.sh`; a profile that adds nvm still runs.
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists, so a host that adds nvm in
    // .bashrc still resolves node without a double-run of the setup.
    const envArgs = envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`);
    const remoteScript = [
      'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      envArgs.length > 0
        ? `exec env ${envArgs.join(" ")} sh -c ${shellQuote(remoteCommand)}`
        : `exec sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -c ${shellQuote(remoteScript)}`,
    );

    return options.stdin != null
      ? await spawnText("ssh", sshArgs, {
          stdin: options.stdin,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        })
      : await execFileText("ssh", sshArgs, {
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        });
  } finally {
    await cleanup();
  }
}

// Run session records live under the SSH user's home directory, not under the
// workspace (`<remoteDir>/.paperclip-runtime`): the cleanup of a stuck lease
// can run after the environment's workspace path has been repointed or the
// workspace cleaned, and the record must still be where the run left it.
const SSH_RUN_SESSION_RECORD_ROOT = ".paperclip/run-sessions";

/**
 * Where the remote sessions of an SSH run are recorded, relative to the remote
 * user's home directory. Null for a run id that is not safe to embed in a path.
 *
 * sshd starts every non-pty exec channel in a new session (`setsid()`), so the
 * agent command and every process it starts share one session id, however
 * they are re-parented, unless a process calls `setsid()` itself. The spawn
 * script records that id here, and the pending_cleanup retry stops the
 * session from this record (buildStopSshRunSessionsScript).
 */
export function sshRunSessionRecordDir(runId: string): string | null {
  return /^[A-Za-z0-9-]{1,128}$/.test(runId) ? `${SSH_RUN_SESSION_RECORD_ROOT}/${runId}` : null;
}

// Shell pieces shared by the stop (buildStopSshRunSessionsScript) and the
// prune (buildPruneSshRunSessionRecordsScript), so both read records and
// decide which sessions are alive by the same rules.
//
// readrec FILE: sets `rsid` and `rstart` from a `<sid> <leader start time>`
// record whose name is its sid. Returns 1 for an unreadable or malformed one.
const SSH_RUN_SESSION_READ_RECORD =
  "readrec() { n=${1##*/}; line=''; { read -r line < \"$1\"; } 2>/dev/null || [ -n \"$line\" ] || return 1; set -- $line; case \"$1:$2\" in *[!0-9:]*|:*|*:) return 1 ;; esac; [ \"$1\" = \"$n\" ] || return 1; rsid=$1; rstart=$2; }";

// The visibility checks a /proc scan needs before its result can be trusted.
// `fail` is a shell function called with the reason when one fails. They also
// set `me` and `mysid`, the scanning shell's pid and session.
function sshProcScanChecks(fail: string): string[] {
  return [
    "me=$$",
    `[ -r /proc/self/stat ] || ${fail} "no /proc on this host"`,
    `for t in awk tr grep sleep; do command -v "$t" >/dev/null 2>&1 || ${fail} "$t is not installed"; done`,
    `grep -qE '^[^ ]+ /proc proc .*hidepid=(1|2|4|invisible|noaccess|ptraceable)' /proc/mounts 2>/dev/null && ${fail} "/proc is mounted with hidepid, which hides other users' processes"`,
    "mysid=''; { read -r s < \"/proc/$me/stat\"; } 2>/dev/null && { r=${s##*\")\"}; set -- $r; mysid=$4; }",
    `[ -n "$mysid" ] || ${fail} "cannot read this shell's own /proc entry"`,
  ];
}

// snap: one line per process, `<pid> <state> <sid> <start time> <run-id match>`,
// from a single pass over /proc with the `read` builtin. The run-id match
// (the exact environment line PAPERCLIP_RUN_ID=$rid) is checked only when
// `rid` is set, and never for the scanning shell's own session.
//
// scan: runs snap through awk with the recorded sessions in `recs`
// (` <sid>:<leader start time>` pairs). Each pair is judged on its own, never
// by sid alone, since records of different runs can share a sid after pid
// reuse. A pair (s, t) is alive through a process that is not a zombie, has
// session id s, and started at or after t, unless the pair has ended by reuse:
// a process with pid s exists with a start time other than t. Linux reuses a
// pid only once no session refers to it, so that session has ended. The last
// line is `scan-ok <saw me> <saw pid
// 1>`; the result counts only as `scan-ok 1 1`, which shows that awk ran to
// completion and that the snapshot held this shell (enumeration works) and
// pid 1 (which every pid namespace has, and which hidepid or a security
// policy hides from an unprivileged user).
function sshProcScanFunctions(output: "members" | "live-sessions"): string[] {
  const emit = output === "members"
    // Every process to stop: members of an alive recorded pair, and run-id
    // matches.
    ? "if (sid[i] == mysid || dead(i)) continue; if (member(i) || env[i] == 1) print pid[i]"
    // Every recorded pair that is still alive, as `<sid>:<start time>`.
    : "if (dead(i) || !(sid[i] in bysid)) continue; m = split(bysid[sid[i]], js, \" \"); for (k = 1; k <= m; k++) if (pairlive(js[k], i)) alive[ps[js[k]] \":\" pt[js[k]]] = 1";
  const after = output === "members" ? "" : " for (x in alive) print x;";
  return [
    "snap() { for p in /proc/[0-9]*; do { read -r s < \"$p/stat\"; } 2>/dev/null || continue; r=${s##*\")\"}; set -- $r; e=0; if [ -n \"$rid\" ] && [ \"$4\" != \"$mysid\" ] && [ -O \"$p/environ\" ] && [ -r \"$p/environ\" ] && tr '\\000' '\\n' < \"$p/environ\" 2>/dev/null | grep -qxF \"PAPERCLIP_RUN_ID=$rid\"; then e=1; fi; echo \"${p#/proc/} $1 $4 ${20} $e\"; done; }",
    `scan() { snap | awk -v recs="$recs" -v me="$me" -v mysid="$mysid" 'function dead(i) { return state[i] == "Z" || state[i] == "X" } function pairlive(j, i) { return !(j in ended) && start[i] + 0 >= pt[j] + 0 } function member(i,  m, k, js) { if (!(sid[i] in bysid)) return 0; m = split(bysid[sid[i]], js, " "); for (k = 1; k <= m; k++) if (pairlive(js[k], i)) return 1; return 0 } BEGIN { n = split(recs, a, " "); for (j = 1; j <= n; j++) { split(a[j], kv, ":"); ps[j] = kv[1]; pt[j] = kv[2]; bysid[kv[1]] = bysid[kv[1]] " " j } } { pid[NR] = $1; state[NR] = $2; sid[NR] = $3; start[NR] = $4; env[NR] = $5; if ($1 == me) seenme = 1; if ($1 == "1") seeninit = 1; if ($1 in bysid) { m = split(bysid[$1], js, " "); for (k = 1; k <= m; k++) if ($4 != pt[js[k]]) ended[js[k]] = 1 } } END { for (i = 1; i <= NR; i++) { ${emit} }${after} print "scan-ok", seenme + 0, seeninit + 0 }'; }`,
    // scanned: runs scan into `out` and returns 1 unless it provably saw
    // every process; `found` holds its result lines.
    "scanned() { out=$(scan); case \"$out\" in *'scan-ok 1 1') ;; *) return 1 ;; esac; found=$(printf '%s\\n' \"$out\" | grep -v '^scan-ok'); return 0; }",
  ];
}

/**
 * Removes run session record dirs that are untouched for 30 days AND whose
 * recorded sessions are all gone. A record outlives a run that ended normally,
 * because the spawn `exec`s the agent command and nothing runs after it, but a
 * run can also outlive 30 days, and its record is what lets cleanup stop it.
 *
 * - A dir with valid records is pruned only when one /proc scan, passing the
 *   same visibility checks as the stop, shows none of its recorded
 *   (sid, leader start time) pairs alive (the stop's own rule). If the scan can't be trusted, no such dir is pruned.
 * - A dir with an unreadable or malformed record is never pruned.
 * - A dir with no record, only an `untracked` marker or nothing, grants
 *   nothing and is pruned by age alone.
 *
 * Runs in a subshell, silently, and always succeeds.
 */
export function buildPruneSshRunSessionRecordsScript(): string {
  return [
    "(",
    `root="$HOME"/${shellQuote(SSH_RUN_SESSION_RECORD_ROOT)}`,
    "[ -d \"$root\" ] || exit 0",
    "old=$(find \"$root\" -mindepth 1 -maxdepth 1 -type d -mtime +30 2>/dev/null)",
    "[ -n \"$old\" ] || exit 0",
    "rid=''",
    SSH_RUN_SESSION_READ_RECORD,
    // Pass 1: the valid records of every old dir.
    "recs=''",
    "while IFS= read -r dir; do for f in \"$dir\"/*; do [ -f \"$f\" ] || continue; case \"${f##*/}\" in untracked|*.tmp) continue ;; esac; readrec \"$f\" && recs=\"$recs $rsid:$rstart\"; done; done <<PAPERCLIP_OLD_DIRS",
    "$old",
    "PAPERCLIP_OLD_DIRS",
    // One scan for all of them, trusted only if it passes every check.
    "canscan=1",
    "noscan() { canscan=0; }",
    ...sshProcScanChecks("noscan"),
    ...sshProcScanFunctions("live-sessions"),
    "alive=''",
    "if [ -n \"$recs\" ] && [ \"$canscan\" = 1 ]; then if scanned; then alive=\" $(echo $found) \"; else canscan=0; fi; fi",
    // Pass 2: decide each old dir.
    "while IFS= read -r dir; do",
    "  keep=0; sessions=0",
    "  for f in \"$dir\"/*; do",
    "    [ -f \"$f\" ] || continue",
    "    case \"${f##*/}\" in untracked|*.tmp) continue ;; esac",
    "    if readrec \"$f\"; then sessions=1; case \"$alive\" in *\" $rsid:$rstart \"*) keep=1 ;; esac; else keep=1; fi",
    "  done",
    "  [ \"$sessions\" = 1 ] && [ \"$canscan\" != 1 ] && keep=1",
    "  [ \"$keep\" = 1 ] || rm -rf \"$dir\"",
    "done <<PAPERCLIP_OLD_DIRS",
    "$old",
    "PAPERCLIP_OLD_DIRS",
    ") >/dev/null 2>&1 || true",
  ].join("\n");
}

// Records the session this spawn runs in as `<sid> <leader start time>` in
// `<record dir>/<sid>`, before the command is exec'd. The session id is taken
// from /proc only when it is this shell or its parent (the login shell sshd
// started), so a host that did not start a new session never records a foreign
// one; such a host, or one without /proc, writes an `untracked` marker instead.
// Recording is best effort and never blocks the run. Stat files are read with
// the `read` builtin, which forks nothing.
function buildRecordSshRunSessionScript(recordDir: string): string {
  return [
    "{",
    `pc_d="$HOME"/${shellQuote(recordDir)};`,
    'mkdir -p "$pc_d" &&',
    'if read -r pc_s < "/proc/$$/stat" && pc_r=${pc_s##*")"} && set -- $pc_r && pc_sid=$4 &&',
    '{ [ "$pc_sid" = "$$" ] || [ "$pc_sid" = "$PPID" ]; } &&',
    'read -r pc_s < "/proc/$pc_sid/stat" && pc_r=${pc_s##*")"} && set -- $pc_r && [ -n "${20}" ];',
    'then printf \'%s %s\\n\' "$pc_sid" "${20}" > "$pc_d/$pc_sid.tmp" && mv -f "$pc_d/$pc_sid.tmp" "$pc_d/$pc_sid";',
    'else : > "$pc_d/untracked"; fi;',
    "} >/dev/null 2>&1 || true",
  ].join(" ");
}

export type SshRunSessionStopStatus = "stopped" | "untracked" | "no-record";

/**
 * Parses the status line of buildStopSshRunSessionsScript. Null when the
 * output carries none.
 */
export function parseSshRunSessionStopStatus(stdout: string): SshRunSessionStopStatus | null {
  const match = /^paperclip-run-sessions: (stopped|untracked|no-record)$/m.exec(stdout);
  return match ? (match[1] as SshRunSessionStopStatus) : null;
}

/**
 * Stops an SSH run's processes on the host and reports whether that is
 * confirmed.
 *
 * The processes to stop are the union of two sets:
 * - **The recorded sessions' members** (sshRunSessionRecordDir): processes
 *   whose session id, from `/proc/<pid>/stat` (readable for every uid), is a
 *   recorded id. That includes re-parented descendants and descendants under
 *   another uid. A recorded id whose pid now belongs to a process with a
 *   different start time was reused, which Linux allows only once the session
 *   is empty, so that session is done. Members must also have started no
 *   earlier than the recorded session leader.
 * - **The SSH user's processes whose environment holds the exact line
 *   `PAPERCLIP_RUN_ID=<runId>`.** This catches a process that left the
 *   session with `setsid()` but kept its environment. The scan only adds
 *   processes to stop; an environment it cannot read is skipped, so it never
 *   proves anything stopped. A process that both calls `setsid()` and clears
 *   its environment is not found.
 *
 * Both sets get TERM, then KILL after `wait` seconds, and are re-derived on
 * every check. A zombie counts as stopped. Anything still running at the end,
 * including a member this user cannot signal, makes the script exit 3, the
 * only failure a later attempt can resolve.
 *
 * Otherwise the script exits 0 with one status line:
 * - `stopped`: records were read and every set is empty. The record is removed.
 * - `untracked`: nothing can confirm the run stopped. The host wrote an
 *   `untracked` marker, a record is unreadable or malformed, `/proc` is
 *   missing or mounted with `hidepid`, `awk`/`tr`/`grep`/`sleep` is missing,
 *   or a scan did not provably complete and see every process (its own shell
 *   and pid 1).
 * - `no-record`: there is no record for the run.
 *
 * `stopped` is printed only after a scan that provably ran and could see
 * other users' processes found nothing left. Processes in the stop's own
 * session are never targets.
 */
export function buildStopSshRunSessionsScript(runId: string): string {
  const recordDir = sshRunSessionRecordDir(runId);
  if (!recordDir) throw new Error(`Invalid run id for an SSH session record: ${runId}`);
  return [
    `d="$HOME"/${shellQuote(recordDir)}`,
    `rid=${shellQuote(runId)}`,
    "wait=10",
    SSH_RUN_SESSION_READ_RECORD,
    "recs=''; untracked=0; norecord=0",
    "if [ -d \"$d\" ]; then",
    "  for f in \"$d\"/*; do",
    "    [ -e \"$f\" ] || continue",
    "    case \"${f##*/}\" in untracked) untracked=1; continue ;; *.tmp) continue ;; esac",
    "    readrec \"$f\" || { echo \"unreadable or malformed session record ${f##*/}\" >&2; untracked=1; continue; }",
    "    recs=\"$recs $rsid:$rstart\"",
    "  done",
    "  [ -z \"$recs\" ] && [ \"$untracked\" = 0 ] && norecord=1",
    "else",
    "  norecord=1",
    "fi",
    "status() { if [ \"$norecord\" = 1 ]; then s=no-record; elif [ \"$untracked\" = 1 ]; then s=untracked; else s=stopped; fi; echo \"paperclip-run-sessions: $s\"; }",
    // Anything that stops the scan from seeing every process ends in
    // `untracked` (no receipt), never in `stopped`.
    "unconfirmed() { echo \"cannot confirm the run stopped: $1\" >&2; [ \"$norecord\" = 1 ] || untracked=1; status; exit 0; }",
    ...sshProcScanChecks("unconfirmed"),
    // The stop's own session (its subshells, awk, tr, grep) is never a
    // target, even if this shell's environment carries the run id.
    "unset PAPERCLIP_RUN_ID",
    ...sshProcScanFunctions("members"),
    "members() { scanned || unconfirmed \"the process scan did not complete or could not see every process\"; m=$found; }",
    "members",
    "if [ -n \"$m\" ]; then",
    "  kill -TERM $m 2>/dev/null",
    "  i=0; while [ \"$i\" -lt \"$wait\" ]; do sleep 1; members; [ -z \"$m\" ] && break; i=$((i + 1)); done",
    "  k=0; while [ -n \"$m\" ] && [ \"$k\" -lt 3 ]; do kill -KILL $m 2>/dev/null; sleep 1; members; k=$((k + 1)); done",
    "  [ -z \"$m\" ] || { echo \"processes of the run are still running or could not be signalled: $(echo $m)\" >&2; exit 3; }",
    "fi",
    "rm -rf \"$d\"",
    "status",
  ].join("\n");
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
  // The heartbeat run this spawn belongs to. Its remote session is recorded
  // under this id. When absent, the env's PAPERCLIP_RUN_ID is used.
  runId?: string | null;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
}> {
  for (const key of Object.keys(input.env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  const envArgs = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  const runId = input.runId ?? input.env.PAPERCLIP_RUN_ID;
  const recordDir = typeof runId === "string" ? sshRunSessionRecordDir(runId) : null;
  // Source the login profiles first, then run `env KEY=VAL cmd` so
  // user-supplied identity overrides win over anything a profile re-exports.
  // The SSH target is an operator-configured host, not a Paperclip sandbox
  // image, so it can expose `node` or an agent CLI only through a login
  // profile; a non-login SSH command would miss that PATH. Source
  // `/etc/profile` first so a host that exposes the PATH through
  // `/etc/profile.d` scripts still resolves node and the agent CLI. The script
  // no longer sources `nvm.sh`; a profile that adds nvm still runs.
  // .bash_profile typically sources .bashrc itself; only source .bashrc
  // directly when no .bash_profile exists, so a host that adds nvm in
  // .bashrc still resolves node without a double-run of the setup.
  const remoteScript = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    // Record the session before exec, so the pending_cleanup retry can stop
    // everything the command starts (buildStopSshRunSessionsScript).
    ...(recordDir ? [buildRecordSshRunSessionScript(recordDir)] : []),
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    envArgs.length > 0
      ? `exec env ${envArgs.join(" ")} ${remoteCommandParts}`
      : `exec ${remoteCommandParts}`,
  ].join(" && ");

  sshArgs.push(
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteScript)}`,
  );

  return {
    command: "ssh",
    args: sshArgs,
    cleanup: auth.cleanup,
  };
}

export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  // tar's archive size isn't known until tar finishes, so estimate it from the
  // local file sizes and clamp the reported percent to 99% until the pipe closes.
  // The estimate walk runs concurrently with the transfer so it never delays the
  // pipe from opening on large workspaces.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Syncing",
      direction: "to",
      label: input.progressLabel,
      totalBytes: estimateLocalDirSize({
        localDir: input.localDir,
        exclude: input.exclude,
        followSymlinks: input.followSymlinks,
      }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude),
      "-cf",
      "-",
      ".",
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if ((tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.kill("SIGTERM");
      ssh.kill("SIGTERM");
      reject(error);
    };

    if (progress) {
      progress.counter.on("error", fail);
      tar.stdout?.pipe(progress.counter).pipe(ssh.stdin ?? null);
    } else {
      tar.stdout?.pipe(ssh.stdin ?? null);
    }
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      maybeFinish();
    });
    }).finally(auth.cleanup);
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  }
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const remoteTarScript = [
    `cd ${shellQuote(input.remoteDir)}`,
    `tar ${[...tarExcludeArgs(input.exclude).map(shellQuote), "-cf", "-", "."].join(" ")}`,
  ].join(" && ");
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteTarScript)}`,
  ];

  // The remote tar size isn't known locally, so probe the remote directory for
  // an estimate (clamped to 99%). The probe runs concurrently with the transfer
  // so its round-trip never delays the restore; when it is unavailable we report
  // bytes received in MB mode with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: probeRemoteDirSize({ spec: input.spec, remoteDir: input.remoteDir }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if ((sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        tar.kill("SIGTERM");
        reject(error);
      };

      if (progress) {
        progress.counter.on("error", fail);
        ssh.stdout?.pipe(progress.counter).pipe(tar.stdin ?? null);
      } else {
        ssh.stdout?.pipe(tar.stdin ?? null);
      }
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        maybeFinish();
      });
    });
    await progress?.finish();

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}

export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  onProgress?: RuntimeProgressSink;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
}): Promise<{ gitBacked: boolean; repositories?: string[] }> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = input.workspaceFileMode === "all" ? null : await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    const repositories = await listLocalProjectRepositories(input.localDir);
    await transportGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
      exclude: repositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : [],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    if (repositories.length > 0) {
      await excludeProjectRepositoriesOnSsh(input.spec, remoteDir);
    }
    for (const relative of repositories) {
      const localDir = path.join(input.localDir, relative);
      const snapshot = await readLocalGitWorkspaceSnapshot(localDir);
      if (!snapshot) throw new Error(`Cannot read the Git state of project repository: ${relative}`);
      await transportGitWorkspaceToSsh({
        spec: input.spec,
        localDir,
        remoteDir: path.posix.join(remoteDir, relative),
        snapshot,
        onProgress: input.onProgress,
        progressLabel: relative,
      });
    }
    return { gitBacked: true, ...(repositories.length > 0 ? { repositories } : {}) };
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [".paperclip-runtime", ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
  return { gitBacked: false };
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  repositories?: Array<{ path: string; baselineSnapshot?: DirectorySnapshot }>;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const repositories = input.repositories ?? [];
  for (const repository of repositories) {
    if (
      path.posix.dirname(repository.path) !== PROJECT_REPOSITORIES_DIR ||
      !PROJECT_REPOSITORY_NAME_PATTERN.test(path.posix.basename(repository.path))
    ) {
      throw new Error(`Invalid project repository path: ${repository.path}`);
    }
    if (input.baselineSnapshot && !repository.baselineSnapshot) {
      throw new Error(`Project repository has no workspace baseline: ${repository.path}`);
    }
  }
  if (
    input.baselineSnapshot &&
    repositories.length > 0 &&
    !input.baselineSnapshot.exclude.includes(PROJECT_REPOSITORIES_DIR)
  ) {
    throw new Error(`Workspace baseline must exclude ${PROJECT_REPOSITORIES_DIR} when project repositories are restored separately`);
  }
  for (const repository of repositories) {
    await restoreWorkspaceRootFromSsh({
      spec: input.spec,
      localDir: path.join(input.localDir, repository.path),
      remoteDir: path.posix.join(remoteDir, repository.path),
      baselineSnapshot: repository.baselineSnapshot,
      restoreGitHistory: input.restoreGitHistory,
      onProgress: input.onProgress,
      progressLabel: repository.path,
    });
  }
  await restoreWorkspaceRootFromSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    baselineSnapshot: input.baselineSnapshot,
    restoreGitHistory: input.restoreGitHistory,
    onProgress: input.onProgress,
    progressLabel: "workspace",
    hasProjectRepositories: repositories.length > 0,
  });
}

async function restoreWorkspaceRootFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
  hasProjectRepositories?: boolean;
}): Promise<void> {
  const remoteDir = input.remoteDir;
  if (input.baselineSnapshot) {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const importedRef = input.restoreGitHistory
      ? `refs/paperclip/ssh-sync/imported/${randomUUID()}`
      : null;
    try {
      const importedHead = input.restoreGitHistory
        ? await exportGitWorkspaceFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          importedRef: importedRef ?? undefined,
          resetLocalWorkspace: false,
          onProgress: input.onProgress,
        })
        : null;
      await syncDirectoryFromSsh({
        spec: input.spec,
        remoteDir,
        localDir: stagingDir,
        exclude: input.baselineSnapshot.exclude,
        onProgress: input.onProgress,
        progressLabel: input.progressLabel,
      });
      await mergeDirectoryWithBaseline({
        baseline: input.baselineSnapshot,
        sourceDir: stagingDir,
        targetDir: input.localDir,
        // Git history advances via integrateImportedGitHead; the working tree
        // still comes from the remote file snapshot so dirty remote edits win.
        beforeApply: importedHead
          ? async () => {
            await integrateImportedGitHead({
              localDir: input.localDir,
              importedHead,
            });
          }
          : undefined,
      });
    } finally {
      if (importedRef) {
        await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    const projectRepositoryEntries = input.hasProjectRepositories ? [PROJECT_REPOSITORIES_DIR] : [];
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      onProgress: input.onProgress,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      exclude: [".git", ".paperclip-runtime", ...projectRepositoryEntries],
      preserveLocalEntries: [".git", ...projectRepositoryEntries],
      onProgress: input.onProgress,
      progressLabel: input.progressLabel,
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime"],
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  // Each lease acquire also prunes stale run session records, so they don't
  // accumulate on a long-lived host.
  const result = await runSshCommand(
    config,
    `${buildPruneSshRunSessionRecordsScript()}\n` +
      `mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

const SSH_ENV_LAB_FIXTURE_PATH_FIELDS = [
  "rootDir",
  "workspaceDir",
  "statePath",
  "clientPrivateKeyPath",
  "clientPublicKeyPath",
  "hostPrivateKeyPath",
  "hostPublicKeyPath",
  "authorizedKeysPath",
  "knownHostsPath",
  "sshdConfigPath",
  "sshdLogPath",
] as const satisfies readonly (keyof SshEnvLabFixtureState)[];

// True when candidate is an absolute path equal to rootDir or nested under
// it. Used to reject a state file whose paths point outside the fixture
// root it was read from.
function isPathRootedAt(candidate: string, rootDir: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  if (candidate === rootDir) return true;
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The state file is untrusted input: any local process running as the same
// user can write one. A forged pid or an empty sshdConfigPath would weaken
// isSshEnvLabFixtureProcess's identity check — an empty string is a
// substring of every command line, so it would match any running process.
// Reject a state file that fails this check before any identity check or
// signal runs against it.
function isValidSshEnvLabFixtureState(
  raw: SshEnvLabFixtureState,
  expectedRootDir: string,
): boolean {
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false;
  if (raw.rootDir !== expectedRootDir) return false;

  for (const field of SSH_ENV_LAB_FIXTURE_PATH_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || !isPathRootedAt(value, expectedRootDir)) {
      return false;
    }
  }

  const expectedSshdConfigPath = path.join(expectedRootDir, "sshd_config");
  if (raw.sshdConfigPath.length === 0 || raw.sshdConfigPath !== expectedSshdConfigPath) {
    return false;
  }

  return true;
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    // Resolve a relative statePath against the current working directory
    // before use. The state validator below only accepts absolute paths, and
    // a relative statePath must resolve to the same absolute directory every
    // time a caller reads it, no matter the process working directory.
    const resolvedStatePath = path.resolve(statePath);
    const raw = JSON.parse(await fs.readFile(resolvedStatePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    if (!isValidSshEnvLabFixtureState(raw, path.dirname(resolvedStatePath))) return null;
    return raw;
  } catch {
    return null;
  }
}

async function waitUntilFixtureProcessExits(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs;
  while (true) {
    if (!(await isSshEnvLabFixtureProcess(state))) return true;
    if (Date.now() >= timeoutAt) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Sends a signal to a pid and treats an already-dead process as success.
// The identity check that runs before this call is not free: it spawns
// `ps`, which opens a real gap between the check and the signal. If the
// process exits inside that gap, `process.kill` throws ESRCH even though
// the outcome the caller wants (the process is gone) already holds. Any
// other error, such as EPERM for a pid that belongs to another user, must
// still propagate.
function signalFixtureProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

// Bounded shutdown escalation shared by every caller that must stop a
// fixture process: send SIGTERM, wait, re-check process identity (the pid
// can be reused in the gap between two signals), then SIGKILL, then wait
// again. Returns true only when the listener is confirmed gone.
async function escalateSshEnvLabFixtureShutdown(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
): Promise<boolean> {
  if (!(await isSshEnvLabFixtureProcess(state))) return true;

  if (!signalFixtureProcess(state.pid, "SIGTERM")) return true;
  if (await waitUntilFixtureProcessExits(state, 5_000)) return true;

  if (!(await isSshEnvLabFixtureProcess(state))) return true;
  if (!signalFixtureProcess(state.pid, "SIGKILL")) return true;
  if (await waitUntilFixtureProcessExits(state, 2_000)) return true;

  return !(await isSshEnvLabFixtureProcess(state));
}

// Accepts a state path or an already-read state so a caller that already
// holds the fixture state in memory does not have to depend on the state
// file, which a teardown step may have already removed.
export async function stopSshEnvLabFixture(
  stateOrPath: string | SshEnvLabFixtureState,
): Promise<boolean> {
  const state = typeof stateOrPath === "string"
    ? await readSshEnvLabFixtureState(stateOrPath)
    : stateOrPath;
  if (!state) return false;

  if (!(await escalateSshEnvLabFixtureShutdown(state))) {
    throw new Error(
      `SSH env-lab fixture did not stop: pid ${state.pid} on port ${state.port} is still running after SIGKILL.`,
    );
  }

  // Remove the root directory only after the listener process is confirmed
  // gone. Removing it earlier would delete the state file the process needs
  // for a later stop attempt to find and signal it.
  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
  // Test-only. Shortens the readiness wait below its 10 second default, so
  // a regression test can force the start-failure cleanup path without a
  // real 10 second wait.
  readinessTimeoutMs?: number;
}): Promise<SshEnvLabFixtureState> {
  // Resolve a relative statePath against the current working directory once,
  // up front. Every derived path (rootDir and the persisted statePath field)
  // must be absolute, so the state validator in readSshEnvLabFixtureState
  // accepts the file that this function writes.
  const statePath = path.resolve(input.statePath);
  const existing = await readSshEnvLabFixtureState(statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: input.readinessTimeoutMs ?? 10_000, intervalMs: 250 });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    // No state file exists on this path yet, so a later stopSshEnvLabFixture
    // call can never find this pid. Escalate and wait for exit here, the
    // same way stopSshEnvLabFixture does, before the root directory goes
    // away — otherwise a slow-to-exit sshd survives as an orphan with its
    // root directory already gone.
    const stopped = await escalateSshEnvLabFixtureShutdown(state);
    if (stopped) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const survivalNote =
        `SSH env-lab fixture pid ${state.pid} on port ${state.port} is still running after SIGKILL. ` +
        `Kept ${rootDir} for inspection; no state file exists to target it with a later stop call.`;
      if (error instanceof Error) {
        error.message = `${error.message}\n${survivalNote}`;
      } else {
        console.error(survivalNote);
      }
    }
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
