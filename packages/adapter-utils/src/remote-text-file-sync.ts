import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";
import { preferredShellForSandbox } from "./sandbox-shell.js";
import { buildRemotePidLockAcquireScript, buildRemotePidLockCleanupScript } from "./remote-pid-lock.js";

export interface RemoteTextFileSyncFile {
  remoteDir: string;
  remotePath: string;
  body: string;
  label: string;
  action: string;
  lockDir: string;
  executable?: boolean;
}

export interface RemoteTextFileSyncInput extends RemoteTextFileSyncFile {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}

export interface RemoteTextFileBatchInput {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  files: RemoteTextFileSyncFile[];
  ensureDirectories?: string[];
  action: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}

interface RemoteTextSyncExecution {
  runShell(runner: CommandManagedRuntimeRunner, cwd: string, script: string, timeoutMs: number,
    shellCommand: "bash" | "sh", stdin?: string): Promise<RunProcessResult>;
  check(action: string, result: RunProcessResult): RunProcessResult;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function timeout(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 30_000;
}

function program(input: RemoteTextFileSyncFile) {
  const remotePartial = `${input.remotePath}.partial`;
  const remoteUploadPath = `${input.remotePath}.paperclip-upload.b64`;
  const base64Body = Buffer.from(input.body, "utf8").toString("base64");
  const sha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
  const script = [
      "set -eu",
      `remote_dir=${shellQuote(input.remoteDir)}`,
      `remote_path=${shellQuote(input.remotePath)}`,
      `remote_partial=${shellQuote(remotePartial)}`,
      `remote_upload=${shellQuote(remoteUploadPath)}`,
      `lock_dir=${shellQuote(input.lockDir)}`,
      `expected_sha=${shellQuote(sha256)}`,
      "hash_file() {",
      "  if command -v sha256sum >/dev/null 2>&1; then",
      "    sha256sum \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  if command -v shasum >/dev/null 2>&1; then",
      "    shasum -a 256 \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  return 127",
      "}",
      "mkdir -p \"$remote_dir\"",
      ...buildRemotePidLockAcquireScript("\"$lock_dir\"", `Timed out acquiring ${input.label} upload lock.`),
      ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
        "rm -f \"$remote_upload\" \"$remote_partial\"",
      ]),
      "current_sha=\"\"",
      "if [ -f \"$remote_path\" ]; then",
      "  current_sha=\"$(hash_file \"$remote_path\" 2>/dev/null)\" || current_sha=\"\"",
      "fi",
      "if [ -n \"$current_sha\" ] && [ \"$current_sha\" = \"$expected_sha\" ]; then",
      ...(input.executable ? ['  chmod 700 "$remote_path"'] : []),
      "  printf '{\"uploaded\":false}\\n'",
      "  exit 0",
      "fi",
      "rm -f \"$remote_upload\" \"$remote_partial\"",
      "cat > \"$remote_upload\"",
      "base64 -d < \"$remote_upload\" > \"$remote_partial\"",
      "if partial_sha=\"$(hash_file \"$remote_partial\" 2>/dev/null)\"; then",
      "  if [ \"$partial_sha\" != \"$expected_sha\" ]; then",
      `    echo ${shellQuote(`${input.label} upload sha mismatch.`)} >&2`,
      "    exit 1",
      "  fi",
      "else",
      `  echo ${shellQuote(`${input.label} sha verify skipped: no sha256sum/shasum on remote.`)} >&2`,
      "fi",
      ...(input.executable ? ['chmod 700 "$remote_partial"'] : []),
      "mv \"$remote_partial\" \"$remote_path\"",
      "printf '{\"uploaded\":true}\\n'",
    ].join("\n");
  return { script, base64Body, sha256 };
}

export async function syncRemoteTextFile(input: RemoteTextFileSyncInput, execution: RemoteTextSyncExecution) {
  const prepared = program(input);
  const result = await execution.runShell(input.runner, input.remoteCwd, prepared.script, timeout(input.timeoutMs),
    preferredShellForSandbox(input.shellCommand), prepared.base64Body);
  execution.check(input.action, result);
  let uploaded = false;
  try { uploaded = JSON.parse(result.stdout.trim())?.uploaded === true; }
  catch (error) {
    throw new Error(`${input.label} sync wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { uploaded, sha256: prepared.sha256 };
}

export async function syncRemoteTextFiles(input: RemoteTextFileBatchInput, execution: RemoteTextSyncExecution) {
  if (input.files.length === 0 || input.files.length > 16) throw new Error("Remote text sync requires 1 to 16 files");
  const shell = preferredShellForSandbox(input.shellCommand);
  const programs = input.files.map(program);
  const script = ["set -eu", ...programs.map((file, index) => {
    const delimiter = `PAPERCLIP_TEXT_${index}_${randomUUID().replaceAll("-", "")}`;
    return `${shellQuote(shell)} -c ${shellQuote(file.script)} <<'${delimiter}'\n${file.base64Body}\n${delimiter}`;
  }), ...(input.ensureDirectories?.length ? [`mkdir -p -- ${input.ensureDirectories.map(shellQuote).join(" ")}`] : [])].join("\n") + "\n";
  if (Buffer.byteLength(script, "utf8") > 1024 * 1024) throw new Error("Remote text sync batch exceeds 1 MiB");
  const result = await execution.runShell(input.runner, input.remoteCwd, `exec ${shell} -s`, timeout(input.timeoutMs), shell, script);
  execution.check(input.action, result);
  try {
    const results: unknown[] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    if (results.length !== programs.length || results.some(row => !row || typeof row !== "object" || typeof (row as { uploaded?: unknown }).uploaded !== "boolean")) {
      throw new Error("Invalid file result count or upload state");
    }
    return programs.map((file, index) => ({ uploaded: (results[index] as { uploaded: boolean }).uploaded, sha256: file.sha256 }));
  } catch (error) {
    throw new Error(`Remote text sync batch wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
