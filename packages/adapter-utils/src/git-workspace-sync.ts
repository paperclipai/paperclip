import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  overlayPaths: string[];
  deletedPaths: string[];
  ignoredPaths: string[];
}

export interface ExpensiveWorkspaceGitInput {
  localDir: string;
  args: readonly string[];
  operation: string;
  timeout: number;
  maxBuffer: number;
  /**
   * Optional environment override for the invocation. Absent for the anchor
   * workspace's own full-tree walks (they inherit the process environment, a
   * directory this process already controls). A referenced-project scan sets
   * this to its hardened environment (see {@link buildHardenedGitEnv}), so a
   * host executor that honors it still runs the read hardened even though it
   * dispatches through the same seam as the anchor's reads.
   */
  env?: NodeJS.ProcessEnv;
}

export type ExpensiveWorkspaceGitExecutor = (
  input: ExpensiveWorkspaceGitInput,
) => Promise<GitCommandResult>;

let expensiveWorkspaceGitExecutor: ExpensiveWorkspaceGitExecutor | null = null;

/**
 * The workspace Git scan scheduler's typed code for a saturated queue
 * (`server/src/services/workspace-git-operation-scheduler.ts`,
 * `WORKSPACE_GIT_SCAN_ERROR_CODES.saturated`). Declared again here because
 * `adapter-utils` cannot import from `server` (the reverse direction is
 * allowed, not this one); `server` carries a test that asserts the two
 * literals stay equal. `resolveReferencedSourceIgnore` in
 * `sandbox-managed-runtime.ts` reads this code off a caught error's `code`
 * property, never off its message text, to retry only a saturated queue and
 * fail closed on every other Git scan error.
 */
export const WORKSPACE_GIT_SCAN_SATURATED_CODE = "workspace_git_scan_saturated";

/**
 * Lets a host process apply its process-wide admission policy to the adapter
 * package's full-tree Git walks. Standalone adapter-utils consumers retain the
 * existing timeout/buffer-bounded fallback.
 */
export function setExpensiveWorkspaceGitExecutor(executor: ExpensiveWorkspaceGitExecutor | null): void {
  expensiveWorkspaceGitExecutor = executor;
}

export const GIT_ARCHIVE_EXCLUDES = [".git", ".git/*"] as const;

/**
 * Identity flags for commits the sync machinery itself creates (the merge
 * commits that reconcile concurrent histories). Execution hosts are often
 * containers with no git config and no resolvable hostname, so git cannot
 * auto-detect an identity there and `commit-tree` hard-fails with "Author
 * identity unknown" — which fails the whole run at finalize. Passing the
 * identity per invocation keeps every deployment working without host
 * configuration; `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables
 * still take precedence over `-c` when an operator sets them.
 */
export const GIT_SYNC_COMMIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Paperclip",
  "-c",
  "user.email=noreply@paperclip.ing",
] as const;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    execFile(
      "git",
      ["-C", localDir, ...args],
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function runExpensiveWorkspaceGit(
  localDir: string,
  args: string[],
  operation: string,
  options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
): Promise<GitCommandResult> {
  if (expensiveWorkspaceGitExecutor) {
    return await expensiveWorkspaceGitExecutor({
      localDir,
      args,
      operation,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env,
    });
  }
  return await runLocalGit(localDir, args, options);
}

export async function readGitWorkspaceSnapshot(localDir: string): Promise<GitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, overlayDiffResult, untrackedResult, deletedResult, ignoredResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runExpensiveWorkspaceGit(localDir, ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", "HEAD", "--"], "adapter_sync.overlay_diff", {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      runExpensiveWorkspaceGit(localDir, ["ls-files", "--others", "--exclude-standard", "-z"], "adapter_sync.untracked_files", {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      runExpensiveWorkspaceGit(localDir, ["diff", "--name-only", "-z", "--diff-filter=D", "HEAD", "--"], "adapter_sync.deleted_files", {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
      runExpensiveWorkspaceGit(localDir, ["status", "--ignored", "--porcelain=v1", "-z", "--untracked-files=normal"], "adapter_sync.ignored_files", {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    // `-z` already delimits each record with a NUL byte, so a leading or
    // trailing space in a record is part of the path itself, not padding to
    // remove — trimming it would resolve to a path that does not exist. A
    // length check finds the one genuinely empty record `-z` appends after
    // the last NUL, without eating a real path's own leading or trailing
    // whitespace. This applies to all four NUL-delimited outputs below (the
    // overlay diff, the untracked list, the deleted list, and the ignored
    // list); `branchName` and `headCommit` come from non-`-z` commands and
    // keep their own `.trim()` above and below, which is safe.
    const splitNul = (value: string) => value.split("\0").filter((entry) => entry.length > 0);
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      overlayPaths: [...new Set([...splitNul(overlayDiffResult.stdout), ...splitNul(untrackedResult.stdout)])]
        .sort((left, right) => left.localeCompare(right)),
      deletedPaths: [...new Set(splitNul(deletedResult.stdout))]
        .sort((left, right) => left.localeCompare(right)),
      ignoredPaths: splitNul(ignoredResult.stdout)
        .filter((entry) => entry.startsWith("!! "))
        .map((entry) => entry.slice(3).replace(/\/+$/, ""))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    };
  } catch {
    return null;
  }
}

/** The `git ls-files --others --ignored` output for one directory, read by {@link readReferencedSourceGitIgnoredPaths}. */
export interface ReferencedSourceGitIgnoreScan {
  /** The absolute repository top level `git rev-parse --show-toplevel` reports. */
  toplevel: string;
  /** Ignored paths, relative to `toplevel`, trailing slashes stripped, sorted. */
  ignoredPaths: string[];
}

/**
 * Build the environment for a hardened, read-only Git invocation against a
 * directory this process does not control (a referenced project, not the
 * anchor workspace). Two protections apply:
 *
 * - Drop every inherited `GIT_*` variable, so an already-set override in this
 *   process's own environment cannot change how the read-only command runs.
 * - Point the global config file at `/dev/null` (in addition to the
 *   command-line `GIT_CONFIG_NOSYSTEM=1` the caller sets), so neither this
 *   host's global nor system Git configuration can add a setting the
 *   read-only command was not built to expect.
 *
 * This does not defend against the directory's OWN repository-local
 * configuration; the command-line `-c core.fsmonitor=false` override in
 * {@link runHardenedReadOnlyGit} does that instead, because command-line
 * config always wins over repository-local config.
 */
function buildHardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

/**
 * Run a read-only Git command against a directory this process does not
 * control, hardened against a hostile repository-local configuration, and
 * dispatched through {@link runExpensiveWorkspaceGit} — the SAME process-wide
 * admission seam the anchor workspace's expensive full-tree reads use. A host
 * process that registers a bounded scheduler there (see
 * `setExpensiveWorkspaceGitExecutor`) governs referenced-project scans too, so
 * a run with many referenced projects cannot spawn one unbounded Git process
 * per project; each request queues behind the same concurrency limit.
 *
 * Every call still carries `--no-optional-locks` (never blocks on, or is
 * blocked by, a concurrent Git process in the directory) and
 * `-c core.fsmonitor=false` (neutralizes a repository-local `core.fsmonitor`
 * setting that would otherwise run an arbitrary configured program on this
 * read). See {@link buildHardenedGitEnv} for the paired environment hardening,
 * carried through the executor's optional `env` field so hardening survives
 * the hop through a host-registered scheduler.
 */
async function runHardenedReadOnlyGit(
  localDir: string,
  args: string[],
  operation: string,
  options: { timeout: number; maxBuffer: number },
): Promise<GitCommandResult> {
  return await runExpensiveWorkspaceGit(
    localDir,
    ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args],
    operation,
    { timeout: options.timeout, maxBuffer: options.maxBuffer, env: buildHardenedGitEnv() },
  );
}

/**
 * True when a failed `git` invocation failed specifically because `localDir`
 * is not inside a Git work tree — Git's own "not a git repository" fatal
 * error. Distinguishes the expected non-Git case from a real failure (a
 * timeout, a permissions error, a corrupt repository), which must still
 * surface as a failure and never look like "no Git tree here".
 */
function isNotAGitRepositoryError(error: unknown): boolean {
  const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
  const message = error instanceof Error ? error.message : String(error);
  return /not a git repository/i.test(stderr) || /not a git repository/i.test(message);
}

/** Bound on the number of parsed ignored entries `readReferencedSourceGitIgnoredPaths` accepts before it fails closed. */
export const REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT = 10_000;

/** Bound on the summed UTF-8 byte length of the resolved ignored-path strings `readReferencedSourceGitIgnoredPaths` accepts before it fails closed. */
export const REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Bound on the raw `git ls-files --others --ignored` output
 * `readReferencedSourceGitIgnoredPaths` lets Node buffer, kept proportionate
 * to {@link REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES} instead of the far
 * larger allowance the anchor workspace's general-purpose full-tree reads
 * use. The command reports only ignored entries (see the invocation below),
 * so this raw allowance is not exposed to an unrelated tracked-change or
 * ordinary-untracked record count — a repository with a huge diff or a huge
 * untracked set never grows this command's output. The parser below still
 * enforces the real entry-count and byte bounds while it reads each record,
 * so this value only needs headroom for the NUL delimiter and the trailing
 * slash on every entry, not room for an oversized ignored-path list to land
 * in memory in the first place.
 */
const REFERENCED_SOURCE_IGNORE_MAX_RAW_BUFFER = REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES * 2;

/**
 * Thrown by {@link readReferencedSourceGitIgnoredPaths} when the parsed
 * ignored-path list breaches {@link REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT}
 * or {@link REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES}, so the caller can
 * classify the failure as a bound breach instead of a plain Git read error.
 * The message never leaves this package: `resolveReferencedSourceIgnore`
 * replaces it with a fixed category before the failure reaches any consumer.
 */
export class ReferencedSourceIgnoreScanLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferencedSourceIgnoreScanLimitExceededError";
  }
}

/**
 * Read the Git-ignored paths of a referenced-project host directory, for the
 * staging path to exclude them (see `resolveReferencedSourceIgnore` in
 * `sandbox-managed-runtime.ts`). Every command runs through
 * {@link runHardenedReadOnlyGit}, because the directory is a host checkout the
 * staging code does not control, unlike the anchor workspace.
 *
 * Returns `null` when `localDir` is not a Git work tree — the caller keeps
 * today's fixed excludes for that case. Throws on any other Git error, a
 * timeout, malformed output, or a bound breach (see
 * {@link ReferencedSourceIgnoreScanLimitExceededError}), so the caller can
 * fail closed and skip staging that one project instead of shipping it
 * unfiltered.
 */
export async function readReferencedSourceGitIgnoredPaths(
  localDir: string,
): Promise<ReferencedSourceGitIgnoreScan | null> {
  let toplevel: string;
  try {
    const toplevelResult = await runHardenedReadOnlyGit(
      localDir,
      ["rev-parse", "--show-toplevel"],
      "referenced_source.toplevel",
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    toplevel = toplevelResult.stdout.trim();
  } catch (error) {
    if (isNotAGitRepositoryError(error)) {
      return null;
    }
    throw error;
  }
  if (!toplevel) {
    throw new Error(`git rev-parse --show-toplevel returned an empty path for ${localDir}`);
  }

  // `ls-files --others --ignored --exclude-standard` reports only ignored
  // entries — unlike `git status --ignored`, it never also reports a tracked
  // change or an ordinary untracked file. A repository with a huge diff or a
  // huge untracked set (unrelated to what is ignored) cannot inflate this
  // command's raw output, so the raw buffer bound below only ever has to
  // cover the declared ignored-set limits, not an unbounded amount of
  // unrelated status noise ahead of them.
  // `--directory` collapses an entirely ignored directory into one entry with
  // a trailing slash, matching `git status --ignored`'s traditional mode.
  // `--full-name` reports paths relative to the repository toplevel, so this
  // still matches the toplevel-relative shape `resolveReferencedSourceIgnore`
  // re-relativizes against, regardless of `localDir`'s position under it.
  const ignoredResult = await runHardenedReadOnlyGit(
    localDir,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--full-name", "-z"],
    "referenced_source.ignored_files",
    { timeout: 60_000, maxBuffer: REFERENCED_SOURCE_IGNORE_MAX_RAW_BUFFER },
  );

  // Read one NUL-delimited record at a time and enforce both bounds while the
  // ignored-entry list accumulates, instead of splitting and mapping the
  // whole response into a list first and only then checking its size. A
  // pathologically large ignore set (a huge repository, or one crafted to
  // hold many ignored entries) must fail closed the moment it breaches a
  // bound, without this scan first retaining and transforming the full
  // oversized response.
  //
  // Do not trim each entry: `-z` already delimits entries with a NUL byte, so
  // a leading or trailing space in an entry is part of the path itself, not
  // padding to remove. A length check finds the one genuinely empty record
  // `-z` appends after the last NUL, without eating a real path's own
  // leading or trailing whitespace.
  const rawIgnored = ignoredResult.stdout;
  const parsedIgnoredEntries: string[] = [];
  let totalIgnoredBytes = 0;
  let recordStart = 0;
  while (recordStart < rawIgnored.length) {
    const nulIndex = rawIgnored.indexOf("\0", recordStart);
    const recordEnd = nulIndex === -1 ? rawIgnored.length : nulIndex;
    const record = rawIgnored.slice(recordStart, recordEnd);
    recordStart = nulIndex === -1 ? rawIgnored.length : nulIndex + 1;

    const entry = record.replace(/\/+$/, "");
    if (entry.length === 0) {
      continue;
    }

    if (parsedIgnoredEntries.length + 1 > REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT) {
      throw new ReferencedSourceIgnoreScanLimitExceededError(
        `referenced project ignore scan found more than ${REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT} ignored entries`,
      );
    }
    totalIgnoredBytes += Buffer.byteLength(entry, "utf8");
    if (totalIgnoredBytes > REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES) {
      throw new ReferencedSourceIgnoreScanLimitExceededError(
        `referenced project ignore scan exceeded ${REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES} UTF-8 bytes of ignored paths`,
      );
    }
    parsedIgnoredEntries.push(entry);
  }

  // The list is bounded by both checks above, so sorting and re-relativizing
  // it here never costs more than the accepted bounds allow.
  const ignoredPaths = parsedIgnoredEntries.sort((left, right) => left.localeCompare(right));

  return { toplevel, ignoredPaths };
}

// scp-like ssh remote (`user@host:path`). The syntax has no password slot, so
// it cannot embed a secret. Conservative shape: exactly one `@`, no colon in
// the user segment (a colon there could smuggle credential-looking material),
// no scheme separator (a `://` form parses as a URL and never reaches this).
const SCP_LIKE_REMOTE_PATTERN = /^[^@:/\s]+@[^@:/\s]+:\S+$/;

/**
 * Reduce a git remote URL to a credential-free form before it is copied into a
 * transported workspace, or null when the URL must not be carried at all.
 * Allowlist, fail closed: only shapes whose credential surface is fully known
 * are kept — http(s) with userinfo/query/fragment stripped (tokens ride in any
 * of those), ssh/git schemes with password/query/fragment stripped, and
 * scp-like `user@host:path` (no password slot exists in that syntax). Every
 * other form — filesystem paths, unknown schemes, unparseable strings — is
 * dropped rather than risk persisting an embedded secret in the execution
 * host's git config.
 */
export function sanitizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    if (parsed.protocol === "ssh:" || parsed.protocol === "git:" || parsed.protocol === "git+ssh:") {
      // The username (conventionally `git`) is addressing, not a secret; a
      // password or query string can be, so those are stripped.
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    return null;
  } catch {
    return SCP_LIKE_REMOTE_PATTERN.test(trimmed) ? trimmed : null;
  }
}

/**
 * The workspace's `origin` remote URL with credentials scrubbed, or null when
 * the workspace has no `origin` remote (or is not a git repository).
 */
export async function readSanitizedOriginRemoteUrl(localDir: string): Promise<string | null> {
  try {
    const result = await runLocalGit(localDir, ["remote", "get-url", "origin"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return sanitizeGitRemoteUrl(result.stdout.trim());
  } catch {
    return null;
  }
}

export async function withShallowGitWorkspaceClone<T>(
  input: {
    localDir: string;
    snapshot: GitWorkspaceSnapshot;
  },
  fn: (cloneDir: string) => Promise<T>,
): Promise<T> {
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-workspace-"));
  const tempRef = `refs/paperclip/git-sync/import/${randomUUID()}`;
  try {
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(cloneDir, ["init"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (originUrl) {
      // The clone is what lands in the sandbox. Without `origin`, the branch
      // there reads as an unpublishable root snapshot even though its head is a
      // commit the upstream remote already holds — so fetch (to reconnect
      // ancestry) and push (to publish the branch; the shallow boundary commit
      // is already on the remote, so the pack closes) are both mechanically
      // possible once the remote is carried over. Best-effort: a failure to
      // record the remote must not fail the transport.
      await runLocalGit(cloneDir, ["remote", "add", "origin", originUrl], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await runLocalGit(cloneDir, ["fetch", "--depth=1", input.localDir, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    await runLocalGit(
      cloneDir,
      input.snapshot.branchName
        ? ["checkout", "--force", "-B", input.snapshot.branchName, "FETCH_HEAD"]
        : ["checkout", "--force", "--detach", "FETCH_HEAD"],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    await runLocalGit(cloneDir, ["reset", "--hard", input.snapshot.headCommit], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return await fn(cloneDir);
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createImportedGitRef(scope = "remote"): string {
  return `refs/paperclip/git-sync/imported/${scope}/${randomUUID()}`;
}

export function createRemoteGitExportRef(scope = "remote"): string {
  return `refs/paperclip/git-sync/export/${scope}/${randomUUID()}`;
}

export async function deleteLocalGitRef(input: {
  localDir: string;
  ref: string;
}): Promise<void> {
  await runLocalGit(input.localDir, ["update-ref", "-d", input.ref], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }).catch(() => undefined);
}

export async function fetchGitBundleIntoLocalRef(input: {
  localDir: string;
  bundlePath: string;
  exportRef: string;
  importedRef: string;
  baseSha: string;
}): Promise<string> {
  const bundleSize = (await fs.stat(input.bundlePath).catch(() => null))?.size ?? 0;
  if (bundleSize === 0) {
    return input.baseSha;
  }

  await runLocalGit(input.localDir, ["fetch", "--force", input.bundlePath, `${input.exportRef}:${input.importedRef}`], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const importedHead = await runLocalGit(input.localDir, ["rev-parse", input.importedRef], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return importedHead.stdout.trim();
}

/** Substrings git emits when a bundle names a prerequisite the importer lacks. */
const GIT_MISSING_PREREQUISITE_MARKERS = [
  "did not send all necessary objects",
  "lacks these prerequisite commits",
  "revision walk setup failed",
];

/**
 * True when a bundle import failed because the host repository does not hold a
 * commit the (delta) bundle assumes as a prerequisite. Such a failure is
 * recoverable by re-exporting a full, self-contained bundle from the still-live
 * sandbox rather than discarding the run.
 */
export function isMissingGitPrerequisiteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_MISSING_PREREQUISITE_MARKERS.some((marker) => message.includes(marker));
}

export function buildRemoteGitDeltaBundleScript(input: {
  remoteDir: string;
  baseSha: string;
  exportRef: string;
  bundlePath: string;
  statusPath?: string;
  catBundle?: boolean;
  cleanupBundle?: boolean;
  /**
   * Skip the delta boundary entirely and always emit a full, self-contained
   * bundle (no prerequisites). Used as the recovery path when a delta import
   * failed because the host lacked the bundle's prerequisite.
   */
  forceFullBundle?: boolean;
}): string {
  const remoteDir = shellQuote(input.remoteDir);
  const bundlePath = shellQuote(input.bundlePath);
  const exportRef = shellQuote(input.exportRef);
  const baseSha = shellQuote(input.baseSha);
  const statusPath = input.statusPath ? shellQuote(input.statusPath) : null;
  const cleanupParts = [
    `rm -f ${bundlePath}`,
    ...(statusPath ? [`rm -f ${statusPath}`] : []),
    `git -C ${remoteDir} update-ref -d ${exportRef} >/dev/null 2>&1 || true`,
  ];
  return [
    "set -e",
    input.cleanupBundle ? `cleanup() { ${cleanupParts.join("; ")}; }` : "",
    input.cleanupBundle ? "trap cleanup EXIT" : "",
    `mkdir -p ${shellQuote(path.posix.dirname(input.bundlePath))}`,
    `rm -f ${bundlePath}`,
    // Choose the bundle boundary. A thin bundle `HEAD --not <baseSha>` records
    // baseSha as a prerequisite the importer (host) must already hold. That
    // assumption breaks in two real cases, and then `git fetch` on the host
    // hard-fails with "did not send all necessary objects" and the run's work
    // is lost:
    //   1. The sandbox HEAD has diverged from baseSha (e.g. a local-only branch
    //      that forked from an older commit) — the host may still hold baseSha,
    //      but a repo whose history is inconsistent cannot satisfy the walk.
    //   2. The host workspace no longer holds baseSha at import time (a shared
    //      workspace that was reset/re-realized between export and import).
    // Bundle relative to the merge-base of baseSha and HEAD instead: that
    // merge-base is an ancestor of baseSha, so any host that holds baseSha (or
    // an ancestor of it) can satisfy the prerequisite, while the bundle stays a
    // delta. When baseSha is absent from the sandbox — or no merge-base exists,
    // or the caller forces it after a delta import failed on a missing
    // prerequisite — fall back to a full, self-contained bundle with no
    // prerequisites.
    ...(input.forceFullBundle
      ? [`bundle_base=""`]
      : [
        `if git -C ${remoteDir} cat-file -e ${baseSha}^{commit} 2>/dev/null; then`,
        `  bundle_base=$(git -C ${remoteDir} merge-base ${baseSha} HEAD 2>/dev/null || true)`,
        "else",
        `  bundle_base=""`,
        "fi",
      ]),
    `if [ -n "$bundle_base" ]; then`,
    `  commit_count=$(git -C ${remoteDir} rev-list --count HEAD --not "$bundle_base")`,
    "else",
    `  commit_count=$(git -C ${remoteDir} rev-list --count HEAD)`,
    "fi",
    'if [ "$commit_count" -gt 0 ]; then',
    `  git -C ${remoteDir} update-ref ${exportRef} HEAD`,
    `  if [ -n "$bundle_base" ]; then`,
    `    git -C ${remoteDir} bundle create ${bundlePath} ${exportRef} --not "$bundle_base" >/dev/null`,
    "  else",
    `    git -C ${remoteDir} bundle create ${bundlePath} ${exportRef} >/dev/null`,
    "  fi",
    "else",
    `  : > ${bundlePath}`,
    "fi",
    statusPath
      ? [
        `if [ -z "$(git -C ${remoteDir} status --porcelain=v1 --untracked-files=normal)" ]; then`,
        `  printf clean > ${statusPath}`,
        "else",
        `  printf dirty > ${statusPath}`,
        "fi",
      ].join("\n")
      : "",
    input.catBundle ? `cat ${bundlePath}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Preserve imported work whose history does not connect to the local one.
 *
 * The dominant real-world cause is a history rewrite inside a transported
 * workspace: transported clones are depth-1 shallow, so the boundary commit
 * reads as parentless there and `git commit --amend` rewrites it into a root
 * commit that shares no ancestor with the host history. A tree merge is
 * impossible without a common ancestor, and failing the integration would
 * discard the run's work. Instead, squash-graft the imported tree onto the
 * current head as a single commit that reuses the imported head's message,
 * with a trailer recording the graft. Concurrent local-only commits keep
 * their place in history as the graft's ancestry; the imported tree is taken
 * wholesale because no base exists to merge against. The caller advances the
 * branch ref to the returned commit.
 */
export async function createUnrelatedHistoryGraftCommit(input: {
  localDir: string;
  currentHead: string;
  importedHead: string;
  syncLabel: string;
}): Promise<string> {
  const importedTree = (await runLocalGit(input.localDir, ["rev-parse", `${input.importedHead}^{tree}`], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  })).stdout.trim();
  const importedMessage = (await runLocalGit(input.localDir, ["log", "-1", "--format=%B", input.importedHead], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  })).stdout;
  const message = [
    importedMessage.trim(),
    "",
    `(${input.syncLabel} graft ${input.importedHead.slice(0, 12)}: imported history shares no ancestor with ${input.currentHead.slice(0, 12)})`,
  ].join("\n");
  const graftCommit = await runLocalGit(
    input.localDir,
    [...GIT_SYNC_COMMIT_IDENTITY_ARGS, "commit-tree", importedTree, "-p", input.currentHead, "-m", message],
    {
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    },
  );
  return graftCommit.stdout.trim();
}

export async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    // `git merge-base` exits 1 when the commits share no ancestor — the only
    // outcome that authorizes the graft fallback below. Every other failure
    // (timeout, missing object, repository error) must keep failing the
    // integration instead of silently rewriting the tip.
    let noCommonAncestor = false;
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch((error: unknown) => {
      noCommonAncestor = (error as { code?: unknown } | null)?.code === 1;
      return null;
    });
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    if (noCommonAncestor) {
      // No common ancestor — merging is impossible and failing here would
      // discard the imported work. Graft it onto the current head instead;
      // see createUnrelatedHistoryGraftCommit.
      const graftCommit = await createUnrelatedHistoryGraftCommit({
        localDir: input.localDir,
        currentHead,
        importedHead: input.importedHead,
        syncLabel: "Paperclip remote git sync",
      });
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, graftCommit, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent remote git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        ...GIT_SYNC_COMMIT_IDENTITY_ARGS,
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip remote git sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent remote git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

export async function resetLocalGitIndexToHead(input: {
  localDir: string;
  checkWorkingTreeClean?: boolean;
}): Promise<void> {
  try {
    await runLocalGit(input.localDir, ["reset", "--quiet", "HEAD", "--", "."], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = error && typeof error === "object"
      ? [
        (error as { message?: unknown }).message,
        (error as { stderr?: unknown }).stderr,
        (error as { stdout?: unknown }).stdout,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n")
      : String(error);
    throw new Error(`Failed to reset local git index to HEAD after workspace restore: ${detail}`);
  }

  const stagedDiff = await runLocalGit(input.localDir, ["diff", "--cached", "--name-status", "HEAD", "--"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (stagedDiff.stdout.trim().length > 0) {
    throw new Error(
      `Workspace restore left staged git index changes after reset:\n${stagedDiff.stdout.trim()}`,
    );
  }

  if (!input.checkWorkingTreeClean) return;

  const workingTreeDiff = await runLocalGit(input.localDir, ["diff", "--name-status", "HEAD", "--"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (workingTreeDiff.stdout.trim().length > 0) {
    console.warn(
      "[paperclip] Workspace restore preserved local working tree changes after clean sandbox restore.",
    );
  }
}
