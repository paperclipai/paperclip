import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { refreshRemoteTrackingBaseRef, type GitRemoteAuthProvider } from "./workspace-runtime.js";

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 30_000;
const MARKER_NAME = "paperclip-shared-checkout-refresh";

export const SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

export type SharedCheckoutRefreshStatus =
  | "fast_forwarded" | "up_to_date" | "skipped_recent" | "skipped_off_default_branch"
  | "skipped_dirty" | "skipped_diverged" | "skipped_no_default_branch" | "fetch_failed";

export type SharedCheckoutRefreshResult = {
  status: SharedCheckoutRefreshStatus;
  defaultBranch: string | null;
  currentBranch: string | null;
  notices: string[];
};

type RefreshOptions = {
  resolveGitAuth?: GitRemoteAuthProvider | null;
  now?: () => number;
  minIntervalMs?: number;
};

const inFlight = new Map<string, Promise<SharedCheckoutRefreshResult>>();

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)) || null;
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function readMarker(markerPath: string): Promise<number | null> {
  try {
    const value = Number((await fs.readFile(markerPath, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function runRefresh(cwd: string, options: RefreshOptions): Promise<SharedCheckoutRefreshResult> {
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS;
  const name = path.basename(path.resolve(cwd));

  const originHead = await gitOrNull(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = originHead?.startsWith("origin/") ? originHead.slice("origin/".length) : null;
  const currentBranch = await gitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const result = (status: SharedCheckoutRefreshStatus, notice?: string): SharedCheckoutRefreshResult => ({
    status, defaultBranch, currentBranch, notices: notice ? [notice] : [],
  });

  if (!defaultBranch) return result("skipped_no_default_branch");
  if (currentBranch !== defaultBranch) {
    return result(
      "skipped_off_default_branch",
      `Shared checkout ${name} is on \`${currentBranch ?? "a detached HEAD"}\` instead of \`${defaultBranch}\`; it was not updated.`,
    );
  }

  const gitPath = await gitOrNull(cwd, ["rev-parse", "--git-path", MARKER_NAME]);
  const markerPath = gitPath ? path.resolve(cwd, gitPath) : null;
  if (markerPath) {
    const last = await readMarker(markerPath);
    if (last !== null && now() - last < minIntervalMs) return result("skipped_recent");
  }

  let fetchProblem: string | null = null;
  try {
    const warnings = await refreshRemoteTrackingBaseRef(cwd, `origin/${defaultBranch}`, options.resolveGitAuth);
    if (warnings.length > 0) fetchProblem = warnings[0] ?? "";
  } catch (error) {
    fetchProblem = error instanceof Error ? error.message : String(error);
  }
  if (fetchProblem !== null) {
    const detail = oneLine(fetchProblem);
    return result(
      "fetch_failed",
      `Shared checkout ${name} could not be fetched and was left as it was${detail ? `: ${detail}` : "."}`,
    );
  }
  if (markerPath) await fs.writeFile(markerPath, String(now())).catch(() => undefined);

  const dirty = await gitOrNull(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) return result("skipped_dirty", `Shared checkout ${name} has uncommitted changes; it was not updated.`);

  const before = await gitOrNull(cwd, ["rev-parse", "HEAD"]);
  try {
    await git(cwd, ["merge", "--ff-only", `origin/${defaultBranch}`]);
  } catch {
    return result(
      "skipped_diverged",
      `Shared checkout ${name} has diverged from origin/${defaultBranch}; it was not updated.`,
    );
  }
  const after = await gitOrNull(cwd, ["rev-parse", "HEAD"]);
  return result(before === after ? "up_to_date" : "fast_forwarded");
}

/**
 * Brings a clean shared checkout that sits on its default branch up to date
 * with origin. Never throws for git or network problems: they are reported in
 * `notices` so a refresh problem cannot fail a run.
 */
export function refreshSharedManagedCheckout(
  cwd: string,
  options: RefreshOptions = {},
): Promise<SharedCheckoutRefreshResult> {
  const key = path.resolve(cwd);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = runRefresh(cwd, options).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
