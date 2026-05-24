import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClosureGateRejectionCode =
  | "NO_TEXT"
  | "NO_HEAD_SHA"
  | "INVALID_HEAD_SHA"
  | "PROCESS_ONLY_UNDECLARED"
  | "PATH_PROOF_MISMATCH"
  | "INVALID_PROOF_BRANCH"
  | "INVALID_BYPASS_REASON"
  | "INVALID_REMOTE_REACHABILITY";

export type ClosureGateRejection = {
  code: ClosureGateRejectionCode;
  message: string;
  detail?: Record<string, unknown>;
};

export type ClosureGateInput = {
  text: string;
  isProcessOnly: boolean;
  defaultBranch: string;
};

export type ClosureGateOptions = {
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  runFetch?: (branch: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
  fetchTimeoutMs?: number;
};

export type ClosureGateResult =
  | { ok: true; verifiedHeadSha: string; citedPathsVerified: string[]; remoteUnreachable?: boolean }
  | { ok: false; rejections: ClosureGateRejection[] };

// Spec §6.4 rev 3: bypass reason deny-list — D1, D2, D3 patterns
// D1: PR-not-merged; D2: locally-merged; D3: no upstream access
export const BYPASS_REASON_DENYLIST_RE =
  /pr.*(not.*merged|pending|open|review)|\blocal\b.*(merge|master|main)|merged.*(locally|local-only)|no.*(upstream|maintainer).*(access|merge)/i;

// SHA pattern: 7-40 hex chars at start of line followed by whitespace
const SHA_LINE_RE = /^([0-9a-f]{7,40})[ \t]/gm;

// Extractor C (spec §3.1 rev 2): git log <REF> --oneline -- <path>
// Group 1: ref token; Group 2: path. First char of ref must be alphanum/dot/underscore to exclude --flags.
const EXTRACTOR_C_RE =
  /(?:^|\s)git\s+(?:-C\s+\S+\s+)?log\s+(?!--oneline\b)([A-Za-z0-9._][A-Za-z0-9._/\-]*)\s+--oneline\s+--\s+(\S+)/gm;

// Extractor C malformed: git log --oneline -- <path> (missing ref token → §4.4.0 rejects)
const EXTRACTOR_C_MALFORMED_RE =
  /(?:^|\s)git\s+(?:-C\s+\S+\s+)?log\s+--oneline\s+--\s+(\S+)/gm;

export function extractShas(text: string): {
  headSha: string | null;
  subShas: { sha: string; path: string | null }[];
} {
  const seen = new Map<string, number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SHA_LINE_RE.source, "gm");
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) seen.set(m[1], m.index);
  }
  const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  if (sorted.length === 0) return { headSha: null, subShas: [] };
  const headSha = sorted[0][0];
  const subShas = sorted.slice(1).map(([sha]) => ({ sha, path: null }));
  return { headSha, subShas };
}

// §3.2: Returns cited artifacts with captured ref token (undefined = malformed or free-text mention)
export function extractCitedArtifacts(text: string): { path: string; ref?: string }[] {
  const artifacts: { path: string; ref?: string }[] = [];
  const seen = new Set<string>();

  // Match git log <REF> --oneline -- <path>
  const re1 = new RegExp(EXTRACTOR_C_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) {
    const ref = m[1].trim();
    const path = m[2].trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      artifacts.push({ path, ref });
    }
  }

  // Match malformed git log --oneline -- <path> (ref missing → §4.4.0 will reject)
  const re2 = new RegExp(EXTRACTOR_C_MALFORMED_RE.source, "gm");
  while ((m = re2.exec(text)) !== null) {
    const path = m[1].trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      artifacts.push({ path }); // ref: undefined
    }
  }

  return artifacts;
}

// Backward-compat wrapper: returns paths only (unit tests rely on this signature)
export function extractCitedPaths(text: string): string[] {
  return extractCitedArtifacts(text).map((a) => a.path);
}

export function isProcessOnlyDeclared(text: string): boolean {
  return /cites no in.repo artifact/i.test(text);
}

async function defaultRunGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return { stdout: result.stdout, stderr: result.stderr };
}

// §4.4.2: fetch with AbortController-based timeout
async function defaultRunFetch(
  branch: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await execFileAsync(
      "git",
      ["-C", cwd, "fetch", "origin", branch, "--no-tags", "--no-recurse-submodules"],
      { cwd, signal: controller.signal as AbortSignal },
    );
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function validate(
  input: ClosureGateInput,
  repoPath: string,
  opts?: ClosureGateOptions,
): Promise<ClosureGateResult> {
  const runGit = opts?.runGit ?? defaultRunGit;
  const fetchTimeoutMs =
    opts?.fetchTimeoutMs ??
    parseInt(process.env.PAPERCLIP_CLOSURE_GATE_FETCH_TIMEOUT_MS ?? "5000", 10);
  const runFetch = opts?.runFetch
    ? (branch: string, cwd: string) => opts.runFetch!(branch, cwd)
    : (branch: string, cwd: string) => defaultRunFetch(branch, cwd, fetchTimeoutMs);

  const rejections: ClosureGateRejection[] = [];

  if (!input.text || input.text.trim() === "") {
    return {
      ok: false,
      rejections: [
        {
          code: "NO_TEXT",
          message:
            "Closing comment body is empty. §B requires a closing comment with HEAD sha and path proofs.",
        },
      ],
    };
  }

  const { headSha, subShas } = extractShas(input.text);
  const citedArtifacts = extractCitedArtifacts(input.text);
  const processOnly = input.isProcessOnly || isProcessOnlyDeclared(input.text);

  if (!processOnly && citedArtifacts.length === 0 && subShas.length === 0) {
    rejections.push({
      code: "PROCESS_ONLY_UNDECLARED",
      message:
        "No cited paths found. Implementation tickets require per-path reachability proofs (`git log <defaultBranch> --oneline -- <path>`). If process-only, add 'cites no in-repo artifact' to the closing comment.",
    });
  }

  if (headSha === null) {
    rejections.push({
      code: "NO_HEAD_SHA",
      message:
        "No HEAD sha found. Run `git log <branch> --oneline -1` and paste the output in the closing comment.",
    });
    return { ok: false, rejections };
  }

  try {
    const result = await runGit(["cat-file", "-t", headSha], repoPath);
    if (result.stdout.trim() !== "commit") {
      rejections.push({
        code: "INVALID_HEAD_SHA",
        message: `SHA ${headSha} does not resolve to a commit (got: ${result.stdout.trim()}).`,
        detail: { sha: headSha },
      });
    }
  } catch {
    rejections.push({
      code: "INVALID_HEAD_SHA",
      message: `SHA ${headSha} not found in repository (git cat-file -t returned non-zero).`,
      detail: { sha: headSha },
    });
  }

  const verifiedPaths: string[] = [];
  for (const artifact of citedArtifacts) {
    // §4.4.0 ref-validation gate: reject if ref is missing (malformed line) or ≠ defaultBranch
    if (artifact.ref === undefined) {
      rejections.push({
        code: "INVALID_PROOF_BRANCH",
        message: `Path-proof line for "${artifact.path}" is missing the ref token (expected \`git log ${input.defaultBranch} --oneline -- ${artifact.path}\`). The §B predicate is canonical-default-branch reachability, NOT 'reachable from any branch where the work exists'. Path proofs against a feature branch with real shas still fail this gate.`,
        detail: { capturedRef: "<missing>", expectedRef: input.defaultBranch, path: artifact.path },
      });
      continue;
    }
    if (artifact.ref !== input.defaultBranch) {
      rejections.push({
        code: "INVALID_PROOF_BRANCH",
        message: `Path-proof line for "${artifact.path}" cites ref \`${artifact.ref}\` but the workspace default branch is \`${input.defaultBranch}\`. The §B predicate is canonical-default-branch reachability, NOT 'reachable from any branch where the work exists'. Path proofs against a feature branch with real shas still fail this gate.`,
        detail: { capturedRef: artifact.ref, expectedRef: input.defaultBranch, path: artifact.path },
      });
      continue;
    }

    // §4.4.1: reachability check (only reached when ref === defaultBranch)
    try {
      const result = await runGit(
        ["log", input.defaultBranch, "--oneline", "--", artifact.path],
        repoPath,
      );
      if (result.stdout.trim() === "") {
        rejections.push({
          code: "PATH_PROOF_MISMATCH",
          message: `Path "${artifact.path}" has no commits on ${input.defaultBranch}. The artifact may not be merged yet.`,
          detail: { path: artifact.path, branch: input.defaultBranch },
        });
      } else {
        verifiedPaths.push(artifact.path);
      }
    } catch {
      rejections.push({
        code: "PATH_PROOF_MISMATCH",
        message: `Could not verify path "${artifact.path}" on branch ${input.defaultBranch}.`,
        detail: { path: artifact.path, branch: input.defaultBranch },
      });
    }
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }

  // §4.4.2: remote-reachability gate (rev 3, UPG-840)
  // Fetch then check merge-base --is-ancestor. Fail-open on fetch errors.
  let remoteUnreachable = false;
  try {
    await runFetch(input.defaultBranch, repoPath);
    // merge-base --is-ancestor exits 0 if ancestor, 1 if not
    try {
      await runGit(
        ["merge-base", "--is-ancestor", headSha, `origin/${input.defaultBranch}`],
        repoPath,
      );
      // exit 0 → sha is on remote branch, continue
    } catch (mergeBaseErr: unknown) {
      const exitCode =
        mergeBaseErr &&
        typeof mergeBaseErr === "object" &&
        "code" in mergeBaseErr
          ? (mergeBaseErr as { code: unknown }).code
          : undefined;
      if (exitCode === 1) {
        // Definitive rejection: sha is not an ancestor of origin/<defaultBranch>
        let remoteSha = "unknown";
        try {
          const r = await runGit(["rev-parse", "--short", `origin/${input.defaultBranch}`], repoPath);
          remoteSha = r.stdout.trim();
        } catch {
          // ignore
        }
        return {
          ok: false,
          rejections: [
            {
              code: "INVALID_REMOTE_REACHABILITY",
              message: `SHA ${headSha} is not reachable from origin/${input.defaultBranch} (remote HEAD: ${remoteSha}). The §B predicate requires the cited sha to be on the externally-observable remote-tracking branch — merge your branch to origin/${input.defaultBranch} before closing.`,
              detail: { sha: headSha, remoteRef: `origin/${input.defaultBranch}`, remoteSha },
            },
          ],
        };
      }
      // exit != 1 (e.g. 128 — bad ref, remote/master doesn't exist yet): fail-open
      remoteUnreachable = true;
    }
  } catch {
    // fetch failed (network error, timeout, bad remote URL): fail-open
    remoteUnreachable = true;
  }

  return { ok: true, verifiedHeadSha: headSha, citedPathsVerified: verifiedPaths, remoteUnreachable };
}
