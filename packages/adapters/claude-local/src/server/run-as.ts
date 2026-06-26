import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCAL_RUN_AS_USER_RE = /^[a-z_][a-z0-9_-]*[$]?$/i;
const DEFAULT_RUN_AS_WORKSPACE_DIRNAME = "paperclip-workspace";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeLocalRunAsUser(config: Record<string, unknown>): string | null {
  return nonEmptyString(config.localRunAsUser) ?? nonEmptyString(config.runAsUser);
}

export function readClaudeLocalRunAsWorkspaceDir(config: Record<string, unknown>): string | null {
  return nonEmptyString(config.localRunAsWorkspaceDir);
}

export function validateClaudeLocalRunAsUser(user: string): string | null {
  if (LOCAL_RUN_AS_USER_RE.test(user)) return null;
  return "localRunAsUser must be a local POSIX account name, not a shell fragment or arbitrary command.";
}

export function buildClaudeLocalRunAsInvocation(input: {
  command: string;
  args: string[];
  config: Record<string, unknown>;
  targetIsRemote: boolean;
}): {
  command: string;
  args: string[];
  runAsUser: string | null;
  commandLabel: string;
} {
  const runAsUser = readClaudeLocalRunAsUser(input.config);
  if (!runAsUser || input.targetIsRemote) {
    return {
      command: input.command,
      args: input.args,
      runAsUser: null,
      commandLabel: input.command,
    };
  }

  const validationError = validateClaudeLocalRunAsUser(runAsUser);
  if (validationError) {
    throw new Error(validationError);
  }

  return {
    command: "sudo",
    args: ["-E", "-H", "-u", runAsUser, "--", input.command, ...input.args],
    runAsUser,
    commandLabel: `sudo -E -H -u ${runAsUser} -- ${input.command}`,
  };
}

/**
 * Resolve the on-disk working directory the non-root run-as user should operate
 * in. The Paperclip server is hosted as root, so the configured workspace cwd
 * (e.g. /root/paperclip) is owned by root and is neither enterable nor writable
 * by a non-root `sudo -u <user>` Claude process. This picks a path the run-as
 * user can own instead, defaulting to <home>/paperclip-workspace, and refuses to
 * silently reuse a root-owned location. Pure function: callers supply the
 * resolved home directory; side effects (mkdir/chown) live in
 * {@link ensureClaudeLocalRunAsWorkspace}. See MIC-206.
 */
export function resolveClaudeLocalRunAsWorkspaceDir(input: {
  config: Record<string, unknown>;
  runAsUser: string;
  homeDir: string;
}): { dir: string; error: string | null } {
  const configured = readClaudeLocalRunAsWorkspaceDir(input.config);
  const home = input.homeDir.trim().replace(/\/+$/, "");
  const candidate = configured ?? (home ? path.posix.join(home, DEFAULT_RUN_AS_WORKSPACE_DIRNAME) : "");

  if (!candidate) {
    return {
      dir: "",
      error:
        `Could not resolve a writable workspace for non-root user "${input.runAsUser}": ` +
        "no localRunAsWorkspaceDir configured and the user's home directory is unknown.",
    };
  }
  if (!path.isAbsolute(candidate)) {
    return { dir: candidate, error: "localRunAsWorkspaceDir must be an absolute path." };
  }

  const dir = path.resolve(candidate);
  // Preserve root-owned source safety: never hand the non-root lane a path under
  // /root, which is where the root-hosted Paperclip checkout lives.
  if (dir === "/root" || dir.startsWith("/root/")) {
    return {
      dir,
      error:
        `Refusing to use root-owned path "${dir}" as the non-root Claude workspace; ` +
        "set localRunAsWorkspaceDir to a directory the run-as user can own.",
    };
  }
  return { dir, error: null };
}

/**
 * Best-effort lookup of a local account's home directory via getent. Returns
 * null when getent is unavailable or the account/home cannot be parsed, letting
 * callers fall back to the conventional /home/<user> default.
 */
export async function resolveLocalUserHomeDir(user: string): Promise<string | null> {
  if (validateClaudeLocalRunAsUser(user)) return null;
  try {
    const { stdout } = await execFileAsync("getent", ["passwd", user]);
    const line = stdout.split(/\r?\n/).find((value) => value.trim().length > 0) ?? "";
    const home = line.split(":")[5]?.trim();
    if (home && path.isAbsolute(home)) return home;
  } catch {
    // getent missing or account not found - fall through to the default.
  }
  return null;
}

/**
 * Ensure a writable working directory exists for the non-root run-as lane and
 * return it. The directory is created AS the run-as user (sudo -u <user> mkdir)
 * so ownership and writability are correct without uid/gid mapping, then a
 * `test -w` confirms the user can actually write there. Throws a descriptive
 * error (surfaced as a real run blocker) if the workspace cannot be made
 * writable. See MIC-206.
 */
export async function ensureClaudeLocalRunAsWorkspace(input: {
  runAsUser: string;
  config: Record<string, unknown>;
  requestedCwd?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<{ cwd: string; note: string }> {
  const validationError = validateClaudeLocalRunAsUser(input.runAsUser);
  if (validationError) {
    throw new Error(validationError);
  }

  const homeDir = (await resolveLocalUserHomeDir(input.runAsUser)) ?? `/home/${input.runAsUser}`;
  const resolved = resolveClaudeLocalRunAsWorkspaceDir({
    config: input.config,
    runAsUser: input.runAsUser,
    homeDir,
  });
  if (resolved.error) {
    throw new Error(resolved.error);
  }
  const dir = resolved.dir;

  try {
    await execFileAsync("sudo", ["-n", "-u", input.runAsUser, "--", "mkdir", "-p", dir]);
    await execFileAsync("sudo", ["-n", "-u", input.runAsUser, "--", "test", "-w", dir]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not prepare a writable workspace "${dir}" for non-root user "${input.runAsUser}": ${reason}`,
    );
  }

  const note = `Redirected non-root Claude working directory to ${dir} (owned by ${input.runAsUser})`;
  if (input.onLog) {
    const from =
      input.requestedCwd && path.resolve(input.requestedCwd) !== dir
        ? ` instead of the root-owned "${input.requestedCwd}"`
        : "";
    await input.onLog("stdout", `[paperclip] ${note}${from}.\n`);
  }
  return { cwd: dir, note };
}
