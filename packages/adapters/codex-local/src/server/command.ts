import path from "node:path";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

export const CODEX_DEFAULT_COMMAND = "codex";
export const CODEX_MACOS_APP_COMMAND_PATH = "/Applications/Codex.app/Contents/Resources/codex";
export const CODEX_MACOS_APP_RESOURCES_DIR = "/Applications/Codex.app/Contents/Resources";

type BuildCodexCommandEnvOptions = {
  fallbackDirs?: readonly string[];
  homeDir?: string | null;
};

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pathKeyForEnv(env: NodeJS.ProcessEnv): "PATH" | "Path" {
  if (isNonEmpty(env.PATH)) return "PATH";
  if (isNonEmpty(env.Path)) return "Path";
  return "PATH";
}

function splitPathList(value: string | undefined): string[] {
  return typeof value === "string" && value.length > 0 ? value.split(path.delimiter).filter(Boolean) : [];
}

function appendMissingPathDirs(pathValue: string | undefined, dirs: readonly string[]): string {
  const entries = splitPathList(pathValue);
  const seen = new Set(entries);

  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    entries.push(trimmed);
    seen.add(trimmed);
  }

  return entries.join(path.delimiter);
}

export function isBareDefaultCodexCommand(command: string): boolean {
  return command.trim() === CODEX_DEFAULT_COMMAND;
}

export function defaultCodexCommandFallbackDirs(
  env: NodeJS.ProcessEnv,
  options: Pick<BuildCodexCommandEnvOptions, "homeDir"> = {},
): string[] {
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? "";
  const homeFallbacks = isNonEmpty(homeDir)
    ? [
        path.join(homeDir, ".local", "bin"),
        path.join(homeDir, "bin"),
        path.join(homeDir, ".npm-global", "bin"),
        path.join(homeDir, ".bun", "bin"),
        path.join(homeDir, ".cargo", "bin"),
        path.join(homeDir, "Library", "pnpm"),
      ]
    : [];

  return [
    ...homeFallbacks,
    CODEX_MACOS_APP_RESOURCES_DIR,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function buildCodexCommandEnv(
  command: string,
  env: NodeJS.ProcessEnv,
  options: BuildCodexCommandEnvOptions = {},
): NodeJS.ProcessEnv {
  const baseEnv = ensurePathInEnv(env);
  if (!isBareDefaultCodexCommand(command)) return baseEnv;

  const pathKey = pathKeyForEnv(baseEnv);
  const fallbackDirs = options.fallbackDirs ?? defaultCodexCommandFallbackDirs(baseEnv, options);
  const nextPath = appendMissingPathDirs(baseEnv[pathKey], fallbackDirs);
  if (nextPath === baseEnv[pathKey]) return baseEnv;

  return {
    ...baseEnv,
    [pathKey]: nextPath,
  };
}

export function withCodexCommandPath(
  env: Record<string, string>,
  runtimeEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const pathKey = pathKeyForEnv(runtimeEnv);
  const pathValue = runtimeEnv[pathKey];
  if (!isNonEmpty(pathValue)) return env;
  return {
    ...env,
    [pathKey]: pathValue,
  };
}

export function codexCommandUnresolvableHint(command: string): string {
  if (isBareDefaultCodexCommand(command)) {
    return `If Codex is installed via the macOS app, set the adapter command to ${CODEX_MACOS_APP_COMMAND_PATH} or ensure that directory is on the Paperclip server PATH.`;
  }
  return "Verify the configured adapter command exists, is executable, and is reachable from the Paperclip server process.";
}

export function codexCommandResolutionDetail(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const pathKey = pathKeyForEnv(env);
  return [
    `command: ${command}`,
    `cwd: ${cwd}`,
    `${pathKey}: ${env[pathKey] ?? ""}`,
  ].join("\n");
}

export function codexCommandResolutionError(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : "Command is not executable";
  const detail = codexCommandResolutionDetail(command, cwd, env).replace(/\n/g, "; ");
  return `${message}. ${detail}. ${codexCommandUnresolvableHint(command)}`;
}
