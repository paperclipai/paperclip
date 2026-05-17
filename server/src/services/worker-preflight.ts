import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000;
const MAX_PREFLIGHT_LOG_BYTES = 12 * 1024;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export const WORKER_PREFLIGHT_ERROR_CODE = "worker_preflight_failed";

type WorkerPreflightEnv = NodeJS.ProcessEnv;

export class WorkerPreflightError extends Error {
  readonly errorCode = WORKER_PREFLIGHT_ERROR_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerPreflightError";
  }
}

export function isPaperclipWorkerPreflightRequired(input: {
  adapterType: string | null | undefined;
  config: Record<string, unknown>;
  env?: WorkerPreflightEnv;
}) {
  const env = input.env ?? process.env;
  if (isFalseLike(env.PAPERCLIP_WORKER_PREFLIGHT_ENABLED)) return false;
  if (isTrueLike(env.PAPERCLIP_WORKER_PREFLIGHT_FORCE)) return true;
  if (isTrueLike(input.config.paperclipWorkerPreflight)) return true;

  const command = readCommand(input.config);
  const commandName = command ? path.basename(firstShellToken(command)) : null;
  if (!commandName) return false;

  if (input.adapterType === "opencode_local") {
    return commandName === "paperclip-opencode-worker";
  }
  if (input.adapterType === "claude_local") {
    return commandName === "paperclip-openclaude-worker";
  }
  return false;
}

export async function runPaperclipWorkerPreflight(input: {
  adapterType: string;
  config: Record<string, unknown>;
  env?: WorkerPreflightEnv;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const env = { ...process.env, ...(input.env ?? {}) };
  if (!isPaperclipWorkerPreflightRequired({ ...input, env })) return;

  const homeDir = os.homedir();
  const doctorCommand = readString(input.config.workerDoctorCommand) ??
    readString(env.PAPERCLIP_WORKER_DOCTOR_BIN) ??
    path.join(homeDir, ".local/bin/paperclip-worker-doctor");
  const proofPath = path.join(homeDir, ".paperclip/proof/model-policy/latest.md");
  const timeoutMs = normalizeTimeoutMs(env.PAPERCLIP_WORKER_PREFLIGHT_TIMEOUT_MS);
  const label = describePreflightTarget(input.adapterType, input.config);

  await input.onLog("stderr", `[paperclip] Running worker preflight for ${label}.\n`);

  try {
    const result = await execFileAsync(doctorCommand, ["--quick"], {
      cwd: homeDir,
      env,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
    });
    const summary = summarizeDoctorOutput(`${result.stdout}\n${result.stderr}`) ?? "paperclip-worker-doctor --quick";
    await input.onLog("stderr", `[paperclip] Worker preflight passed: ${summary}. Proof: ${proofPath}\n`);
  } catch (err) {
    const failure = normalizeExecFailure(err);
    const output = truncateForLog(`${failure.stdout}\n${failure.stderr}`.trim());
    const summary = summarizeDoctorOutput(output) ?? failure.reason ?? "doctor failed";
    const outputBlock = output ? `\n${output}\n` : "\n";
    await input.onLog("stderr", `[paperclip] Worker preflight failed for ${label}: ${summary}.${outputBlock}`);
    throw new WorkerPreflightError(
      `Worker preflight failed for ${label}: ${summary}. Run ${doctorCommand} --quick and inspect ${proofPath}.`,
      { cause: err },
    );
  }
}

function readCommand(config: Record<string, unknown>) {
  return readString(config.command);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstShellToken(value: string) {
  return value.trim().split(/\s+/)[0] ?? "";
}

function isFalseLike(value: unknown) {
  return typeof value === "string" && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function isTrueLike(value: unknown) {
  if (value === true) return true;
  if (value === 1) return true;
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeTimeoutMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PREFLIGHT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(parsed), 5 * 60_000));
}

function describePreflightTarget(adapterType: string, config: Record<string, unknown>) {
  const command = readCommand(config);
  return command ? `${adapterType} (${path.basename(firstShellToken(command))})` : adapterType;
}

function stripAnsi(value: string) {
  return value.replace(ANSI_PATTERN, "");
}

function truncateForLog(value: string) {
  const clean = stripAnsi(value).trim();
  if (Buffer.byteLength(clean, "utf8") <= MAX_PREFLIGHT_LOG_BYTES) return clean;
  return `...${Buffer.from(clean).subarray(-MAX_PREFLIGHT_LOG_BYTES).toString("utf8")}`;
}

function summarizeDoctorOutput(value: string) {
  const cleanLines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    cleanLines.find((line) => /^\d+\s+ok,\s+\d+\s+warn,\s+\d+\s+fail$/i.test(line)) ??
    cleanLines.find((line) => /\bfail\b/i.test(line)) ??
    cleanLines.find((line) => /\bwarn\b/i.test(line)) ??
    null
  );
}

function normalizeExecFailure(err: unknown) {
  const candidate = err as {
    code?: string | number | null;
    signal?: string | null;
    killed?: boolean;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    message?: string;
  };
  const stdout = candidate?.stdout ? String(candidate.stdout) : "";
  const stderr = candidate?.stderr ? String(candidate.stderr) : "";
  const reason = candidate?.killed
    ? "doctor timed out"
    : candidate?.code != null
      ? `doctor exited with ${candidate.code}`
      : candidate?.signal
        ? `doctor stopped by ${candidate.signal}`
        : candidate?.message;
  return { stdout, stderr, reason };
}
