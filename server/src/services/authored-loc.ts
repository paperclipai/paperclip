/**
 * authored-LOC accounting for merged PRs (BLO-9117 / BLO-9102 Diff 2).
 *
 * Raw `additions + deletions` from a GitHub PR is NOT authored work: repos
 * commit generated bundles, wasm blobs, lockfiles, swagger/protobuf codegen,
 * and submodule (gitlink) SHA bumps as if they were code. This is data-wall
 * #1 from BLO-9102 — LOC contamination. The exclusion set below is the single
 * source of truth for "what doesn't count as authored output," and
 * `computeAuthoredLoc` reduces a GitHub `pulls/{n}/files` listing into both the
 * generated-excluded authored figure and the raw figure (kept for comparison
 * per the acceptance criteria).
 *
 * Each rule is a named predicate rather than one opaque glob string so that the
 * unit test can assert one case per excluded pattern, and so a reviewer can see
 * exactly which classes of file are dropped and why.
 */

/** One file entry from `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface GithubPullFile {
  filename: string;
  additions?: number | null;
  deletions?: number | null;
  changes?: number | null;
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status?: string | null;
  /** The unified diff hunk. Absent for binary files and (usefully) for gitlinks. */
  patch?: string | null;
  /** Present on renames. */
  previous_filename?: string | null;
}

export interface ExclusionRule {
  /** Stable id used in `excludedPaths` accounting and in tests. */
  id: string;
  description: string;
  matches(file: GithubPullFile): boolean;
}

function basename(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

/** Lockfiles are matched by exact basename — they live at many depths. */
const LOCKFILE_BASENAMES = new Set<string>([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
]);

/**
 * A submodule (gitlink) bump shows up in the files API as an entry for the
 * submodule path whose only "diff" is the subproject pointer — no real line
 * content. GitHub reports such entries with `additions === 0 && deletions === 0`
 * and either no `patch` or a patch that is just `Subproject commit <sha>` lines.
 * Either signal alone is ambiguous (a pure-rename or mode-only change is also
 * 0/0), so we require BOTH: zero line churn AND the absence of a real hunk.
 */
function isGitlinkOnly(file: GithubPullFile): boolean {
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  if (additions !== 0 || deletions !== 0) return false;
  const patch = file.patch;
  if (patch == null || patch.trim().length === 0) return true;
  // Every non-empty line is a Subproject pointer → gitlink-only.
  return patch
    .split("\n")
    .map((line) => line.replace(/^[+\- ]/, "").trim())
    .filter((line) => line.length > 0)
    .every((line) => /^Subproject commit [0-9a-f]{7,40}$/i.test(line));
}

/**
 * The exported exclusion set. Order is significant only for which rule "claims"
 * a file in `excludedPaths` accounting (first match wins); membership is
 * order-independent.
 */
export const AUTHORED_LOC_EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: "generated_public_js",
    description: "compiled client bundles under public/js/**",
    matches: (f) => /(^|\/)public\/js\//.test(f.filename),
  },
  {
    id: "generated_client_assets",
    description: "built assets under public/client-js/assets/**",
    matches: (f) => /(^|\/)public\/client-js\/assets\//.test(f.filename),
  },
  {
    id: "vendored",
    description: "vendored third-party trees under vendor/**",
    matches: (f) => /(^|\/)vendor\//.test(f.filename),
  },
  {
    id: "wasm",
    description: "compiled WebAssembly blobs (*.wasm)",
    matches: (f) => /\.wasm$/i.test(f.filename),
  },
  {
    id: "lockfile",
    description: "dependency lockfiles (pnpm-lock.yaml, package-lock.json, go.sum, Cargo.lock, …)",
    matches: (f) => LOCKFILE_BASENAMES.has(basename(f.filename)),
  },
  {
    id: "swagger_codegen_go",
    description: "generated Go swagger clients (*_swaggergen.go)",
    matches: (f) => /_swaggergen\.go$/.test(f.filename),
  },
  {
    id: "protobuf_go",
    description: "generated Go protobuf (*.pb.go)",
    matches: (f) => /\.pb\.go$/.test(f.filename),
  },
  {
    id: "protobuf_py",
    description: "generated Python protobuf (*_pb2.py)",
    matches: (f) => /_pb2\.py$/.test(f.filename),
  },
  {
    id: "gitlink_only",
    description: "submodule (gitlink) SHA bumps with no real line content",
    matches: (f) => isGitlinkOnly(f),
  },
];

export interface AuthoredLocResult {
  /** additions on non-excluded files. */
  authoredAdditions: number;
  /** deletions on non-excluded files. */
  authoredDeletions: number;
  /** authoredAdditions + authoredDeletions, the headline authored-LOC figure. */
  authoredLoc: number;
  /** additions across ALL files, retained for contamination comparison (AC). */
  rawAdditions: number;
  /** deletions across ALL files, retained for contamination comparison (AC). */
  rawDeletions: number;
  /** rawAdditions + rawDeletions. */
  rawLoc: number;
  /**
   * The excluded files and which rule dropped each — surfaced (never silently
   * discarded) so a reviewer can audit what the authored figure dropped.
   */
  excludedPaths: Array<{ path: string; ruleId: string; additions: number; deletions: number }>;
}

/** First rule (in declaration order) that claims this file, or null. */
export function matchExclusionRule(file: GithubPullFile): ExclusionRule | null {
  for (const rule of AUTHORED_LOC_EXCLUSION_RULES) {
    if (rule.matches(file)) return rule;
  }
  return null;
}

export function isExcludedFromAuthoredLoc(file: GithubPullFile): boolean {
  return matchExclusionRule(file) !== null;
}

/**
 * Reduce a PR's file listing into authored vs raw LOC. Pure and synchronous so
 * it is trivially unit-testable; the GitHub fetch + persistence live in the
 * enrichment service.
 */
export function computeAuthoredLoc(files: GithubPullFile[]): AuthoredLocResult {
  const result: AuthoredLocResult = {
    authoredAdditions: 0,
    authoredDeletions: 0,
    authoredLoc: 0,
    rawAdditions: 0,
    rawDeletions: 0,
    rawLoc: 0,
    excludedPaths: [],
  };

  for (const file of files) {
    const additions = Math.max(0, file.additions ?? 0);
    const deletions = Math.max(0, file.deletions ?? 0);
    result.rawAdditions += additions;
    result.rawDeletions += deletions;

    const rule = matchExclusionRule(file);
    if (rule) {
      result.excludedPaths.push({ path: file.filename, ruleId: rule.id, additions, deletions });
      continue;
    }
    result.authoredAdditions += additions;
    result.authoredDeletions += deletions;
  }

  result.rawLoc = result.rawAdditions + result.rawDeletions;
  result.authoredLoc = result.authoredAdditions + result.authoredDeletions;
  return result;
}
