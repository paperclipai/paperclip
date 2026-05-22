import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClosureGateRejectionCode =
  | "NO_TEXT"
  | "NO_HEAD_SHA"
  | "INVALID_HEAD_SHA"
  | "PROCESS_ONLY_UNDECLARED"
  | "PATH_PROOF_MISMATCH";

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
};

export type ClosureGateResult =
  | { ok: true; verifiedHeadSha: string; citedPathsVerified: string[] }
  | { ok: false; rejections: ClosureGateRejection[] };

// SHA pattern: 7-40 hex chars at start of line followed by whitespace
const SHA_LINE_RE = /^([0-9a-f]{7,40})[ \t]/gm;

// Git log cited-path pattern: `git ... -- <path>` (spec §4.3)
const GIT_LOG_PATH_RE = /\bgit\b[^\n]*--[ \t]+(\S+)/g;

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

export function extractCitedPaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(GIT_LOG_PATH_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
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

export async function validate(
  input: ClosureGateInput,
  repoPath: string,
  opts?: ClosureGateOptions,
): Promise<ClosureGateResult> {
  const runGit = opts?.runGit ?? defaultRunGit;
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
  const citedPaths = extractCitedPaths(input.text);
  const processOnly = input.isProcessOnly || isProcessOnlyDeclared(input.text);

  if (!processOnly && citedPaths.length === 0 && subShas.length === 0) {
    rejections.push({
      code: "PROCESS_ONLY_UNDECLARED",
      message:
        "No cited paths found. Implementation tickets require per-path reachability proofs (`git log <branch> --oneline -- <path>`). If process-only, add 'cites no in-repo artifact' to the closing comment.",
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
  for (const path of citedPaths) {
    try {
      const result = await runGit(
        ["log", input.defaultBranch, "--oneline", "--", path],
        repoPath,
      );
      if (result.stdout.trim() === "") {
        rejections.push({
          code: "PATH_PROOF_MISMATCH",
          message: `Path "${path}" has no commits on ${input.defaultBranch}. The artifact may not be merged yet.`,
          detail: { path, branch: input.defaultBranch },
        });
      } else {
        verifiedPaths.push(path);
      }
    } catch {
      rejections.push({
        code: "PATH_PROOF_MISMATCH",
        message: `Could not verify path "${path}" on branch ${input.defaultBranch}.`,
        detail: { path, branch: input.defaultBranch },
      });
    }
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }
  return { ok: true, verifiedHeadSha: headSha, citedPathsVerified: verifiedPaths };
}
