import path from "node:path";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_CURSOR_COMMAND_BASENAMES = new Set(["agent", "cursor-agent"]);
// `.local/bin` first because the official Cursor Agent installer drops the
// binary there; `.cursor/bin` is a secondary location used by some older
// installs. The order also defines the prepended `PATH` order surfaced to the
// adapter.
const CURSOR_SANDBOX_BIN_DIRS = [
  path.posix.join(".local", "bin"),
  path.posix.join(".cursor", "bin"),
];

function commandBasename(command: string): string {
  return command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function prependPosixPathEntry(pathValue: string, entry: string): string {
  const parts = pathValue.split(":").filter(Boolean);
  if (parts.includes(entry)) return pathValue;
  const cleaned = parts.join(":");
  return cleaned.length > 0 ? `${entry}:${cleaned}` : entry;
}

function prependPosixPathEntries(pathValue: string, entries: string[]): string {
  return entries.reduceRight((value, entry) => prependPosixPathEntry(value, entry), pathValue);
}

function preferredSandboxCommandBasenames(command: string): string[] {
  const basename = commandBasename(command);
  if (!DEFAULT_CURSOR_COMMAND_BASENAMES.has(basename)) return [];
  return basename === "cursor-agent"
    ? ["cursor-agent", "agent"]
    : ["agent", "cursor-agent"];
}

function candidateSandboxCommandPaths(homeDir: string, basenames: string[]): string[] {
  // Iterate dirs first, then basenames within each dir, so directory
  // preference (CURSOR_SANDBOX_BIN_DIRS order) wins over basename
  // preference. Both basenames inside `.local/bin` are checked before
  // falling through to `.cursor/bin`.
  return CURSOR_SANDBOX_BIN_DIRS.flatMap((relativeDir) =>
    basenames.map((basename) => path.posix.join(homeDir, relativeDir, basename))
  );
}

function candidateSandboxPathEntries(homeDir: string): string[] {
  return CURSOR_SANDBOX_BIN_DIRS.map((relativeDir) => path.posix.join(homeDir, relativeDir));
}

type SandboxCursorRuntimeInfo = {
  remoteSystemHomeDir: string | null;
  preferredCommandPath: string | null;
};

function readMarkedValue(lines: string[], marker: string): string | null {
  const matchedLine = lines.find((line) => line.startsWith(marker));
  if (!matchedLine) return null;
  const value = matchedLine.slice(marker.length).trim();
  return value.length > 0 ? value : null;
}

async function readSandboxCursorRuntimeInfo(input: {
  runId: string;
  target: AdapterExecutionTarget;
  command: string;
  cwd: string;
  env: Record<string, string>;
  remoteSystemHomeDirHint?: string | null;
  timeoutSec: number;
  graceSec: number;
}): Promise<SandboxCursorRuntimeInfo> {
  const preferredBasenames =
    !hasPathSeparator(input.command)
      ? preferredSandboxCommandBasenames(input.command)
      : [];
  const hintedRemoteSystemHomeDir = input.remoteSystemHomeDirHint?.trim() || null;
  const homeMarker = "__PAPERCLIP_CURSOR_HOME__:";
  const preferredMarker = "__PAPERCLIP_CURSOR_AGENT__:";
  try {
    // When the caller has already resolved the remote `$HOME`, probe absolute
    // paths so the shell doesn't depend on its own environment to interpret
    // `$HOME`. Without a hint we still probe `$HOME/...` literally — this is
    // how the sandbox finds a user-prefixed install before falling back to a
    // PATH lookup. Skipping the `$HOME` probes here was the regression behind
    // server tests `cursor-local-adapter-environment.test.ts` and
    // `cursor-local-execute.test.ts` failing on a host whose own `agent`
    // command resolves via PATH.
    const fixedCandidatePaths =
      preferredBasenames.length > 0
        ? hintedRemoteSystemHomeDir
          ? candidateSandboxCommandPaths(hintedRemoteSystemHomeDir, preferredBasenames)
          : preferredBasenames.flatMap((basename) =>
              CURSOR_SANDBOX_BIN_DIRS.map((relativeDir) =>
                `$HOME/${relativeDir}/${basename}`,
              ),
            )
        : [];
    const preferredProbeBranches = [
      ...fixedCandidatePaths.map(
        (fixedPath) =>
          `[ -x ${JSON.stringify(fixedPath)} ] && printf ${JSON.stringify(`${preferredMarker}%s\\n`)} ${JSON.stringify(fixedPath)}`,
      ),
      ...preferredBasenames.map(
        (basename) =>
          `resolved="$(command -v ${JSON.stringify(basename)} 2>/dev/null)" && [ -n "$resolved" ] && printf ${JSON.stringify(`${preferredMarker}%s\\n`)} "$resolved"`,
      ),
    ];
    const result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      [
        hintedRemoteSystemHomeDir
          ? `printf ${JSON.stringify(`${homeMarker}%s\\n`)} ${JSON.stringify(hintedRemoteSystemHomeDir)}`
          : `printf ${JSON.stringify(`${homeMarker}%s\\n`)} "$HOME"`,
        preferredProbeBranches.length > 0
          ? preferredProbeBranches
            .map((probeBranch, index) => {
              const branchKeyword = index === 0 ? "if" : "elif";
              return `${branchKeyword} ${probeBranch}; then :`;
            })
            .join("; ") + "; fi; :"
          : "",
      ].filter(Boolean).join("; "),
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (result.timedOut || (result.exitCode ?? 1) !== 0) {
      return {
        remoteSystemHomeDir: null,
        preferredCommandPath: null,
      };
    }
    const lines = result.stdout.split(/\r?\n/);
    return {
      remoteSystemHomeDir: readMarkedValue(lines, homeMarker),
      preferredCommandPath: readMarkedValue(lines, preferredMarker),
    };
  } catch {
    return {
      remoteSystemHomeDir: null,
      preferredCommandPath: null,
    };
  }
}

export function isDefaultCursorCommand(command: string): boolean {
  return DEFAULT_CURSOR_COMMAND_BASENAMES.has(commandBasename(command));
}

export type PreparedCursorSandboxCommand = {
  command: string;
  env: Record<string, string>;
  remoteSystemHomeDir: string | null;
  addedPathEntry: string | null;
  preferredCommandPath: string | null;
};

export async function prepareCursorSandboxCommand(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  command: string;
  cwd: string;
  env: Record<string, string>;
  remoteSystemHomeDirHint?: string | null;
  timeoutSec: number;
  graceSec: number;
}): Promise<PreparedCursorSandboxCommand> {
  if (input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return {
      command: input.command,
      env: input.env,
      remoteSystemHomeDir: null,
      addedPathEntry: null,
      preferredCommandPath: null,
    };
  }

  const runtimeInfo = await readSandboxCursorRuntimeInfo({
    runId: input.runId,
    target: input.target,
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    remoteSystemHomeDirHint: input.remoteSystemHomeDirHint,
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
  });
  const remoteSystemHomeDir =
    runtimeInfo.remoteSystemHomeDir ?? input.remoteSystemHomeDirHint?.trim() ?? null;

  if (!remoteSystemHomeDir) {
    return {
      command: input.command,
      env: input.env,
      remoteSystemHomeDir: null,
      addedPathEntry: null,
      preferredCommandPath: null,
    };
  }

  const sandboxPathEntries = candidateSandboxPathEntries(remoteSystemHomeDir);
  const runtimeEnv = ensurePathInEnv(input.env);
  const currentPath = runtimeEnv.PATH ?? runtimeEnv.Path ?? "";
  const nextPath = prependPosixPathEntries(currentPath, sandboxPathEntries);
  const env = nextPath === currentPath ? input.env : { ...input.env, PATH: nextPath };
  const addedPathEntry = nextPath === currentPath ? null : sandboxPathEntries[0];

  if (!runtimeInfo.preferredCommandPath) {
    return {
      command: input.command,
      env,
      remoteSystemHomeDir,
      addedPathEntry,
      preferredCommandPath: null,
    };
  }

  return {
    command: runtimeInfo.preferredCommandPath,
    env,
    remoteSystemHomeDir,
    addedPathEntry,
    preferredCommandPath: runtimeInfo.preferredCommandPath,
  };
}
