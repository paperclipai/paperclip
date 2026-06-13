import fs from "node:fs";
import path from "node:path";

const CODEX_COMMAND_EXAMPLE =
  process.platform === "win32" ? "C:\\Program Files\\Codex\\codex.cmd" : "/opt/homebrew/bin/codex";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [""];
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function canExecute(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = nonEmpty(env.PATH) ?? nonEmpty(env.Path) ?? nonEmpty(process.env.PATH) ?? "";
  if (!pathValue) return null;

  const entries = pathValue.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const exts = pathExts(env);
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const entry of entries) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(entry, command)]
          : exts.map((ext) => path.join(entry, `${command}${ext}`))
        : [path.join(entry, command)];
    for (const candidate of candidates) {
      if (canExecute(candidate)) return candidate;
    }
  }

  return null;
}

function resolveKnownCodexCandidate(env: NodeJS.ProcessEnv): string | null {
  const configuredCandidate =
    nonEmpty(env.PAPERCLIP_CODEX_COMMAND) ??
    nonEmpty(env.CODEX_COMMAND) ??
    nonEmpty(env.CODEX_BIN);
  if (configuredCandidate) {
    const resolved = path.isAbsolute(configuredCandidate)
      ? configuredCandidate
      : path.resolve(configuredCandidate);
    if (canExecute(resolved)) return resolved;
  }

  const platformCandidates =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
      : process.platform === "linux"
        ? ["/usr/local/bin/codex", "/usr/bin/codex"]
        : [];
  for (const candidate of platformCandidates) {
    if (canExecute(candidate)) return candidate;
  }

  return resolveFromPath("codex", env);
}

export function resolveDefaultCodexCommand(env: NodeJS.ProcessEnv = process.env): string {
  return resolveKnownCodexCandidate(env) ?? "";
}

export function codexCommandConfigError(configKey = "adapterConfig.command"): string {
  return `codex_local requires ${configKey} to be an absolute path to the Codex executable. PATH lookup is no longer used at runtime. Example: ${CODEX_COMMAND_EXAMPLE}`;
}

export function assertCodexCommandReadyForExecution(
  command: unknown,
  configKey = "adapterConfig.command",
): string {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(codexCommandConfigError(configKey));
  }
  return trimmed;
}
