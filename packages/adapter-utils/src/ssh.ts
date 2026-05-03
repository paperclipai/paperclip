import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
  paperclipApiUrl?: string | null;
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
    paperclipApiUrl:
      typeof parsed.paperclipApiUrl === "string" && parsed.paperclipApiUrl.trim().length > 0
        ? parsed.paperclipApiUrl.trim()
        : null,
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

function normalizeHttpUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

const DEFAULT_PAPERCLIP_API_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PAPERCLIP_API_PROBE_ATTEMPTS = 3;
const MAX_PAPERCLIP_API_PROBE_ATTEMPTS = 10;
const DEFAULT_PAPERCLIP_API_PROBE_TOTAL_BUDGET_MS = 30_000;
// Per BLO-1490: 300 ms base, sampled uniform from [250, 750] ms per attempt.
// Short-and-jittered absorbs the sub-second SSH-handshake stalls observed on
// the worker host without pathologically inflating lease-acquire latency.
const PROBE_BACKOFF_JITTER_MIN_MS = 250;
const PROBE_BACKOFF_JITTER_MAX_MS = 750;
const PROBE_STDERR_TAIL_BYTES = 512;

function resolveProbeTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = process.env.PAPERCLIP_RUNTIME_API_PROBE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PAPERCLIP_API_PROBE_TIMEOUT_MS;
}

function resolveProbeAttempts(explicit?: number): number {
  // Cap at MAX_PAPERCLIP_API_PROBE_ATTEMPTS so a fat-fingered "9999" can't
  // strand a heartbeat looping over a flapping upstream.
  const clamp = (value: number): number =>
    Math.min(MAX_PAPERCLIP_API_PROBE_ATTEMPTS, Math.max(1, Math.floor(value)));
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) {
    return clamp(explicit);
  }
  const raw = process.env.PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return clamp(parsed);
  }
  return DEFAULT_PAPERCLIP_API_PROBE_ATTEMPTS;
}

function resolveProbeTotalBudgetMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = process.env.PAPERCLIP_RUNTIME_API_PROBE_TOTAL_BUDGET_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PAPERCLIP_API_PROBE_TOTAL_BUDGET_MS;
}

/**
 * Backoff is either an explicit array of sleep durations (one per attempt
 * boundary) or a function that samples per-attempt with optional jitter.
 * Tests inject deterministic arrays; production defaults to jittered.
 */
type ProbeBackoffSource =
  | readonly number[]
  | ((attemptIndex: number, randomMs: () => number) => number);

function defaultJitteredBackoff(_attemptIndex: number, randomMs: () => number): number {
  return randomMs();
}

function defaultRandomBackoffMs(): number {
  // Uniform inclusive [PROBE_BACKOFF_JITTER_MIN_MS, PROBE_BACKOFF_JITTER_MAX_MS].
  const span = PROBE_BACKOFF_JITTER_MAX_MS - PROBE_BACKOFF_JITTER_MIN_MS;
  return PROBE_BACKOFF_JITTER_MIN_MS + Math.floor(Math.random() * (span + 1));
}

function resolveProbeBackoff(explicit?: readonly number[]): ProbeBackoffSource {
  const sanitize = (values: unknown): number[] | null => {
    if (!Array.isArray(values)) return null;
    const cleaned = values
      .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
      .filter((entry): entry is number => Number.isFinite(entry) && entry >= 0)
      // Cap each sleep at 30s so a fat-fingered config can never strand a heartbeat.
      .map((entry) => Math.min(entry, 30_000));
    return cleaned.length > 0 ? cleaned : null;
  };
  if (explicit) {
    const cleaned = sanitize(explicit);
    if (cleaned) return cleaned;
  }
  const raw = process.env.PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON;
  if (raw) {
    try {
      const cleaned = sanitize(JSON.parse(raw));
      if (cleaned) return cleaned;
    } catch {
      // Fall through to the default. A malformed knob must never crash acquireRunLease.
    }
  }
  return defaultJitteredBackoff;
}

function resolveBackoffMs(
  source: ProbeBackoffSource,
  attemptIndex: number,
  randomMs: () => number,
): number {
  if (typeof source === "function") return source(attemptIndex, randomMs);
  return source[Math.min(attemptIndex, source.length - 1)] ?? 0;
}

/**
 * Per-attempt detail captured during a Paperclip API probe over SSH. Surfaced
 * via {@link ProbeResult.attempts} so callers can attach the full failure
 * trail to their thrown error / structured log instead of swallowing it.
 */
export interface PaperclipApiProbeAttempt {
  candidate: string;
  attempt: number; // 1-indexed within this candidate
  ok: boolean;
  exitCode: number | null;
  httpStatus: number | null;
  durationMs: number;
  stderrTail: string | null;
  classification: "ok" | "transient" | "permanent";
  error: string | null;
}

export interface PaperclipApiProbeResult {
  url: string | null;
  attempts: PaperclipApiProbeAttempt[];
}

const TRANSIENT_HTTP_STATUSES = new Set<number>([408, 425, 429]);

// Spec deviation note (BLO-1489 vs BLO-1490): BLO-1490 says "fast-fail on
// non-2xx, the API is reachable but unhealthy". We deliberately keep BLO-1489's
// 5xx-as-transient behavior because the BLO-1489 incident on 2026-04-28 was a
// real ~50ms 503 from nginx during an upstream restart — exactly the blip the
// retry budget is designed to absorb. Switching 5xx to permanent here would
// re-introduce BLO-1489 in single-candidate prod setups. The total-budget cap
// (PAPERCLIP_RUNTIME_API_PROBE_TOTAL_BUDGET_MS, default 30s) bounds the worst
// case so a sustained 5xx storm still falls through to the next candidate.
function classifyHttpStatus(status: number | null): "ok" | "transient" | "permanent" {
  if (status === null) return "transient";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 && status < 600) return "transient";
  if (TRANSIENT_HTTP_STATUSES.has(status)) return "transient";
  return "permanent";
}

const PROBE_STATUS_SENTINEL = "__PAPERCLIP_PROBE_HTTP_CODE__:";

/**
 * Test seam: the probe runner. Production code uses {@link runSingleProbe}
 * which executes curl over SSH; tests can pass a fake to avoid spinning up
 * a real sshd + http server per case.
 */
export type SingleProbeRunner = (input: {
  config: SshConnectionConfig;
  healthUrl: string;
  curlSeconds: number;
  timeoutMs: number;
}) => Promise<SingleProbeAttempt>;

export interface SingleProbeAttempt {
  exitCode: number | null;
  httpStatus: number | null;
  durationMs: number;
  stderrTail: string | null;
  sshError: string | null;
}

async function runSingleProbe(input: {
  config: SshConnectionConfig;
  healthUrl: string;
  curlSeconds: number;
  timeoutMs: number;
}): Promise<SingleProbeAttempt> {
  // Capture %{http_code} explicitly. We deliberately drop curl's `-f` so a 5xx
  // returns exit 0 with the actual status code in stdout — letting us
  // distinguish transient (5xx) from permanent (4xx) without parsing stderr.
  // Connection errors keep their non-zero curl exit and surface as null status.
  const remote = `curl -sS -m ${input.curlSeconds} -o /dev/null -w '${PROBE_STATUS_SENTINEL}%{http_code}\\n' ${shellQuote(input.healthUrl)}`;
  const startedAt = Date.now();
  try {
    const result = await runSshCommand(
      input.config,
      `sh -lc ${shellQuote(remote)}`,
      { timeoutMs: input.timeoutMs },
    );
    const durationMs = Date.now() - startedAt;
    const httpStatus = parseProbeHttpStatus(result.stdout);
    return {
      exitCode: 0,
      httpStatus,
      durationMs,
      stderrTail: tailString(result.stderr, PROBE_STDERR_TAIL_BYTES),
      sshError: null,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const exitCodeRaw = (e as { code?: unknown })?.code;
    const exitCode =
      typeof exitCodeRaw === "number"
        ? exitCodeRaw
        : typeof exitCodeRaw === "string" && /^\d+$/.test(exitCodeRaw)
          ? Number(exitCodeRaw)
          : null;
    return {
      exitCode,
      httpStatus: parseProbeHttpStatus(stdout),
      durationMs,
      stderrTail: tailString(stderr, PROBE_STDERR_TAIL_BYTES),
      sshError: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseProbeHttpStatus(stdout: string): number | null {
  const idx = stdout.lastIndexOf(PROBE_STATUS_SENTINEL);
  if (idx < 0) return null;
  const tail = stdout.slice(idx + PROBE_STATUS_SENTINEL.length).trim();
  const match = tail.match(/^(\d{3})/);
  if (!match) return null;
  const status = Number.parseInt(match[1], 10);
  // curl writes 000 when no HTTP response was received (DNS/TCP/TLS failure).
  return status === 0 ? null : status;
}

function tailString(value: string | null | undefined, bytes: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= bytes) return trimmed;
  return `…${trimmed.slice(-bytes)}`;
}

function dedupeCandidates(...sources: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const source of sources) {
    for (const candidate of source) {
      const normalized = normalizeHttpUrlCandidate(candidate);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}

export async function findReachablePaperclipApiUrlOverSsh(input: {
  config: SshConnectionConfig;
  candidates: string[];
  /** If provided, this candidate is probed first (cache short-circuit). */
  preferredCandidate?: string | null;
  timeoutMs?: number;
  /** Per-candidate attempt count. Env: PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS. */
  attempts?: number;
  /**
   * Wall-clock cap across the whole candidate sweep. Prevents pathological
   * lease-acquire latency when every candidate is flapping. Env:
   * PAPERCLIP_RUNTIME_API_PROBE_TOTAL_BUDGET_MS.
   */
  totalBudgetMs?: number;
  /** Sleep between retries in ms; index N is the wait BEFORE attempt N+2. */
  backoffMs?: readonly number[];
  /** Test-only seam to skip real sleeps in unit tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only seam: fake the curl-over-SSH runner. */
  runProbe?: SingleProbeRunner;
  /** Test-only seam: deterministic clock for total-budget enforcement. */
  now?: () => number;
  /** Test-only seam: deterministic jitter sample. */
  randomBackoffMs?: () => number;
}): Promise<PaperclipApiProbeResult> {
  const orderedCandidates = dedupeCandidates(
    input.preferredCandidate ? [input.preferredCandidate] : [],
    input.candidates,
  );

  const timeoutMs = resolveProbeTimeoutMs(input.timeoutMs);
  const curlSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const probeAttempts = resolveProbeAttempts(input.attempts);
  const totalBudgetMs = resolveProbeTotalBudgetMs(input.totalBudgetMs);
  const backoffSource = resolveProbeBackoff(input.backoffMs);
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runProbe: SingleProbeRunner = input.runProbe ?? runSingleProbe;
  const now = input.now ?? (() => Date.now());
  const randomBackoffMs = input.randomBackoffMs ?? defaultRandomBackoffMs;

  const startedAt = now();
  const elapsedMs = (): number => now() - startedAt;
  const isBudgetExhausted = (): boolean => elapsedMs() >= totalBudgetMs;

  const attemptsLog: PaperclipApiProbeAttempt[] = [];

  outer: for (const candidate of orderedCandidates) {
    const healthUrl = new URL("/api/health", candidate).toString();
    for (let attemptIndex = 0; attemptIndex < probeAttempts; attemptIndex++) {
      // Budget check BEFORE issuing a probe — we don't want to start a curl
      // we can't afford. The check is intentionally on entry to each attempt,
      // not just before sleep, so a slow probe + tight budget can't sneak in
      // an extra request after the budget elapsed.
      if (isBudgetExhausted()) break outer;

      const probe = await runProbe({ config: input.config, healthUrl, curlSeconds, timeoutMs });
      // Classification rules:
      //  - ok: HTTP 2xx with curl exit 0
      //  - permanent: HTTP 3xx/4xx (except 408/425/429) — retrying won't help
      //  - transient: anything else (5xx, 408/425/429, curl exit != 0, ssh
      //    timeout / network blip). Default to transient on uncertainty so a
      //    misclassified failure still gets the retry budget rather than
      //    falling through to "all candidates dead" on the first hiccup.
      const classification: PaperclipApiProbeAttempt["classification"] = (() => {
        if (probe.exitCode === 0 && probe.httpStatus !== null) {
          return classifyHttpStatus(probe.httpStatus);
        }
        return "transient";
      })();

      const ok = classification === "ok";
      const errorMessage = ok
        ? null
        : probe.sshError ??
          (probe.httpStatus !== null ? `HTTP ${probe.httpStatus}` : `curl exit ${probe.exitCode ?? "?"}`);
      const recorded: PaperclipApiProbeAttempt = {
        candidate,
        attempt: attemptIndex + 1,
        ok,
        exitCode: probe.exitCode,
        httpStatus: probe.httpStatus,
        durationMs: probe.durationMs,
        stderrTail: probe.stderrTail,
        classification,
        error: errorMessage,
      };
      attemptsLog.push(recorded);

      if (ok) {
        return { url: candidate, attempts: attemptsLog };
      }

      // Spec (BLO-1490): "Log (at info) each failed attempt with: candidate
      // URL, attempt index, error class, elapsed ms." Emit here so the line
      // shape is identical regardless of caller. Caller can attach further
      // context (env id, host) but cannot drop these fields.
      logFailedProbeAttempt(recorded);

      // Permanent failures — don't burn the retry budget on this candidate.
      if (classification === "permanent") {
        break;
      }

      const isLastAttempt = attemptIndex === probeAttempts - 1;
      if (isLastAttempt) break;

      const waitMs = resolveBackoffMs(backoffSource, attemptIndex, randomBackoffMs);
      // Cap the sleep so we don't sit idle past the total budget. If there's
      // no budget left for *any* sleep, drop straight into the next attempt
      // — but the budget check at the top of the next iteration will catch
      // an exhausted budget and exit the sweep cleanly.
      const remainingBudget = totalBudgetMs - elapsedMs();
      if (remainingBudget <= 0) break outer;
      const cappedWait = Math.min(Math.max(0, waitMs), remainingBudget);
      if (cappedWait > 0) {
        await sleep(cappedWait);
      }
    }
  }

  return { url: null, attempts: attemptsLog };
}

function logFailedProbeAttempt(attempt: PaperclipApiProbeAttempt): void {
  // Structured single-line log. Keep field order stable so log-scrapers
  // (Loki / journalctl greps) can parse without a schema bump.
  // eslint-disable-next-line no-console
  console.info(
    `[ssh-probe] ` +
      `candidate=${attempt.candidate} ` +
      `attempt=${attempt.attempt} ` +
      `class=${attempt.classification} ` +
      `status=${attempt.httpStatus ?? "none"} ` +
      `exit=${attempt.exitCode ?? "none"} ` +
      `durationMs=${attempt.durationMs}` +
      (attempt.error ? ` error="${attempt.error.replace(/"/g, "'")}"` : ""),
  );
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
    const result = await execFileText("sh", ["-lc", `command -v ${shellQuote(command)}`], {
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
    `sh -lc ${shellQuote(script)}`,
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
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(input.remoteScript)}`,
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
    source.pipe(ssh.stdin ?? null);
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
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(input.remoteScript)}`,
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

    ssh.stdout?.pipe(sink);
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
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const tempRef = "refs/paperclip/ssh-sync/import";

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
    ].join("\n");

    await streamLocalFileToSsh({
      spec: input.spec,
      localFile: bundlePath,
      remoteScript: remoteSetupScript,
    });
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
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = "refs/paperclip/ssh-sync/imported";

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

    await streamSshToLocalFile({
      spec: input.spec,
      remoteScript: exportScript,
      localFile: bundlePath,
    });

    await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      remoteCommand,
    );

    return await execFileText("ssh", sshArgs, {
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 1024 * 128,
    });
  } finally {
    await cleanup();
  }
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
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
  const remoteScript = [
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    envArgs.length > 0
      ? `exec env ${envArgs.join(" ")} ${remoteCommandParts}`
      : `exec ${remoteCommandParts}`,
  ].join(" && ");

  sshArgs.push(
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(remoteScript)}`,
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
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

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

    tar.stdout?.pipe(ssh.stdin ?? null);
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
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: string[];
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
    `sh -lc ${shellQuote(remoteTarScript)}`,
  ];

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

      ssh.stdout?.pipe(tar.stdin ?? null);
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

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}

export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await importGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
    });
    await syncDirectoryToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      exclude: [".git", ".paperclip-runtime"],
    });
    await removeDeletedPathsOnSsh({
      spec: input.spec,
      remoteDir,
      deletedPaths: gitSnapshot.deletedPaths,
    });
    return;
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
    exclude: [".paperclip-runtime"],
  });
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      exclude: [".git", ".paperclip-runtime"],
      preserveLocalEntries: [".git"],
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime"],
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `sh -lc ${shellQuote(`mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`)}`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    return raw;
  } catch {
    return null;
  }
}

export async function stopSshEnvLabFixture(statePath: string): Promise<boolean> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) return false;

  if (await isSshEnvLabFixtureProcess(state)) {
    process.kill(state.pid, "SIGTERM");
    await waitForCondition(async () => {
      if (await isSshEnvLabFixtureProcess(state)) {
        throw new Error("SSH fixture process is still running.");
      }
    }, { timeoutMs: 5_000, intervalMs: 100 });
  }

  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
}): Promise<SshEnvLabFixtureState> {
  const existing = await readSshEnvLabFixtureState(input.statePath);
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
  const rootDir = path.dirname(input.statePath);
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
    statePath: input.statePath,
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
    }, { timeoutMs: 10_000, intervalMs: 250 });
    await fs.writeFile(input.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    if (await isPidRunning(state.pid)) {
      process.kill(state.pid, "SIGTERM");
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
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
