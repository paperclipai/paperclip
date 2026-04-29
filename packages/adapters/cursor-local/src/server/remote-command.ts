import path from "node:path";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_CURSOR_COMMAND_BASENAMES = new Set(["agent", "cursor-agent"]);

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
  timeoutSec: number;
  graceSec: number;
}): Promise<SandboxCursorRuntimeInfo> {
  const shouldCheckPreferredCommand = isDefaultCursorCommand(input.command) && !hasPathSeparator(input.command);
  const homeMarker = "__PAPERCLIP_CURSOR_HOME__:";
  const preferredMarker = "__PAPERCLIP_CURSOR_AGENT__:";
  try {
    const result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      [
        `printf ${JSON.stringify(`${homeMarker}%s\\n`)} "$HOME"`,
        shouldCheckPreferredCommand
          ? `if [ -x "$HOME/.local/bin/cursor-agent" ]; then printf ${JSON.stringify(`${preferredMarker}%s\\n`)} "$HOME/.local/bin/cursor-agent"; fi`
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
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
  });
  const remoteSystemHomeDir = runtimeInfo.remoteSystemHomeDir;

  if (!remoteSystemHomeDir) {
    return {
      command: input.command,
      env: input.env,
      remoteSystemHomeDir: null,
      addedPathEntry: null,
      preferredCommandPath: null,
    };
  }

  const remoteLocalBinDir = path.posix.join(remoteSystemHomeDir, ".local", "bin");
  const runtimeEnv = ensurePathInEnv(input.env);
  const currentPath = runtimeEnv.PATH ?? runtimeEnv.Path ?? "";
  const nextPath = prependPosixPathEntry(currentPath, remoteLocalBinDir);
  const env = nextPath === currentPath ? input.env : { ...input.env, PATH: nextPath };

  if (!runtimeInfo.preferredCommandPath) {
    return {
      command: input.command,
      env,
      remoteSystemHomeDir,
      addedPathEntry: nextPath === currentPath ? null : remoteLocalBinDir,
      preferredCommandPath: null,
    };
  }

  return {
    command: runtimeInfo.preferredCommandPath,
    env,
    remoteSystemHomeDir,
    addedPathEntry: nextPath === currentPath ? null : remoteLocalBinDir,
    preferredCommandPath: runtimeInfo.preferredCommandPath,
  };
}
