/**
 * git-state-capture.ts — LIF-456 Layer 2b
 *
 * Captures pre- and post-run git state for execution workspaces.
 * Called by the harness around adapter invocations; all errors are non-fatal
 * so a failing git environment never blocks a run from completing.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { RunGitState, RunGitStateCommit, RunGitStatePushedRef } from "@paperclipai/db";

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 30_000;

export interface PreRunGitSnapshot {
  headBefore: string;
  branchBefore: string;
}

/**
 * Snapshot HEAD + branch immediately before the adapter executes.
 * Returns null if the directory is not a git repo or git is unavailable.
 */
export async function capturePreRunGitState(cwd: string): Promise<PreRunGitSnapshot | null> {
  try {
    const [headRes, branchRes] = await Promise.all([
      execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
    ]);
    const headBefore = headRes.stdout.trim();
    const rawBranch = branchRes.stdout.trim();
    if (!headBefore) return null;
    return {
      headBefore,
      branchBefore: rawBranch === "HEAD" ? "HEAD (detached)" : rawBranch,
    };
  } catch {
    return null;
  }
}

/**
 * Snapshot the post-run git state: HEAD, branch, commits created, push status.
 *
 * Edge-case handling:
 * - Detached HEAD: branchAfter is "HEAD (detached)"; push is skipped.
 * - History rewritten (amend/rebase): merge-base check detects headBefore not in
 *   ancestry; commitsCreated is derived from porcelain push output instead of the
 *   git log range, which would fatal on a non-ancestor range.
 * - No remote / push failure: caught; pushed=false, pushedRefs=[].
 * - No changes: commitsCreated=[], pushedRefs=[]; not a failure.
 */
export async function capturePostRunGitState(
  cwd: string,
  pre: PreRunGitSnapshot,
): Promise<RunGitState> {
  const { headBefore, branchBefore } = pre;

  // --- 1. Capture current HEAD and branch ---
  let headAfter = headBefore;
  let branchAfter = branchBefore;
  try {
    const [headRes, branchRes] = await Promise.all([
      execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
    ]);
    headAfter = headRes.stdout.trim() || headBefore;
    const rawBranch = branchRes.stdout.trim();
    branchAfter = rawBranch === "HEAD" ? "HEAD (detached)" : rawBranch;
  } catch {
    // keep fallbacks
  }

  const isDetached = branchAfter === "HEAD (detached)";

  // --- 2. Remote URL ---
  let remoteUrl: string | null = null;
  try {
    const remoteRes = await execFile("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    remoteUrl = remoteRes.stdout.trim() || null;
  } catch {
    // no remote configured
  }

  // --- 3. Check ancestry for history-rewrite detection ---
  let ancestorOk = false;
  if (headBefore !== headAfter) {
    try {
      await execFile("git", ["merge-base", "--is-ancestor", headBefore, headAfter], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      ancestorOk = true;
    } catch {
      // non-zero exit → history rewritten
    }
  } else {
    // same SHA → trivially ancestor (no new commits)
    ancestorOk = true;
  }

  // --- 4. Push ---
  let pushedRefs: RunGitStatePushedRef[] = [];
  let pushed = false;

  if (!isDetached && remoteUrl) {
    try {
      const pushRes = await execFile(
        "git",
        ["push", "--porcelain", "origin", branchAfter],
        { cwd, timeout: GIT_TIMEOUT_MS },
      );
      const parsed = parsePorcelainPushOutput(pushRes.stdout);
      pushedRefs = parsed;
      pushed = parsed.some((r) => r.status !== "=" && r.status !== "!");
    } catch (err: unknown) {
      // Push failed (no upstream, auth error, etc.) — treat as not pushed
      const stdout = typeof (err as Record<string, unknown>).stdout === "string"
        ? ((err as Record<string, unknown>).stdout as string)
        : "";
      const parsed = parsePorcelainPushOutput(stdout);
      if (parsed.length > 0) {
        pushedRefs = parsed;
        pushed = parsed.some((r) => r.status !== "=" && r.status !== "!");
      }
    }
  }

  // --- 5. commitsCreated ---
  let commitsCreated: RunGitStateCommit[] = [];

  if (headBefore === headAfter) {
    // No new commits
    commitsCreated = [];
  } else if (ancestorOk) {
    // Linear history — safe to use range
    commitsCreated = await safeGitLogRange(cwd, headBefore, headAfter);
  } else {
    // History rewritten — derive from porcelain push output (newSha is what landed on remote)
    commitsCreated = await deriveCommitsFromPushedRefs(cwd, pushedRefs);
  }

  return {
    headBefore,
    branchBefore,
    headAfter,
    branchAfter,
    commitsCreated,
    pushedRefs,
    pushed,
    remoteUrl,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git push --porcelain` stdout into typed ref records.
 *
 * Porcelain format per line (after the "To <url>" header):
 *   <flag>\t<local>:<remote>\t<result>
 *
 * Where <result> for updates is "<oldSha>..<newSha>" and for new refs is
 * "0000000000000000000000000000000000000000..<newSha>".
 * For up-to-date refs the result token is "[up to date]".
 */
function parsePorcelainPushOutput(stdout: string): RunGitStatePushedRef[] {
  const refs: RunGitStatePushedRef[] = [];
  for (const line of stdout.split("\n")) {
    // Lines starting with a flag char followed by tab
    const match = line.match(/^([ +\-*=!])\t([^\t]+)\t(.+)$/);
    if (!match) continue;
    const [, flagChar, refPart, result] = match;
    const flag = flagChar.trim();

    let oldSha = "";
    let newSha = "";

    // Parse "old..new" SHA range — ignore human-readable summaries like "[up to date]"
    const shaRange = result.match(/^([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})$/i);
    if (shaRange) {
      oldSha = shaRange[1];
      newSha = shaRange[2];
    }

    // Map flag to status string
    let status: string;
    if (flag === "" || flag === "+") {
      status = "ok";
    } else if (flag === "=") {
      status = "=";
    } else if (flag === "!") {
      status = "rejected";
    } else if (flag === "-") {
      status = "deleted";
    } else if (flag === "*") {
      status = "ok";
    } else {
      status = flag;
    }

    refs.push({ ref: refPart, oldSha, newSha, status });
  }
  return refs;
}

async function safeGitLogRange(
  cwd: string,
  from: string,
  to: string,
): Promise<RunGitStateCommit[]> {
  try {
    const res = await execFile(
      "git",
      ["log", "--format=%H%x00%s", `${from}..${to}`],
      { cwd, timeout: GIT_TIMEOUT_MS },
    );
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const nul = line.indexOf("\x00");
        return nul === -1
          ? { sha: line, subject: "" }
          : { sha: line.slice(0, nul), subject: line.slice(nul + 1) };
      });
  } catch {
    return [];
  }
}

async function deriveCommitsFromPushedRefs(
  cwd: string,
  refs: RunGitStatePushedRef[],
): Promise<RunGitStateCommit[]> {
  const commits: RunGitStateCommit[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (!r.newSha || r.status === "=" || r.status === "!") continue;
    if (seen.has(r.newSha)) continue;
    seen.add(r.newSha);
    try {
      const res = await execFile("git", ["log", "-1", "--format=%H%x00%s", r.newSha], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      const line = res.stdout.trim();
      if (line) {
        const nul = line.indexOf("\x00");
        commits.push(
          nul === -1
            ? { sha: line, subject: "" }
            : { sha: line.slice(0, nul), subject: line.slice(nul + 1) },
        );
      }
    } catch {
      // commit may not exist locally
    }
  }
  return commits;
}
