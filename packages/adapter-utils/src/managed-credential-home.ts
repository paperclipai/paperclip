import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";

// A credential copy-back writes real token bytes to its destination
// directory. This guard is the containment check that a copy-back target must
// pass before any write. It accepts only a directory under one company's own
// tree (`<instanceRoot>/companies/<companyId>`) and rejects everything else —
// an external path, a path under a different company, or a path that only
// looks contained until a symbolic link is followed.
//
// The rejection message is fixed text with no path and no identifier, so a
// log line built from it can never leak which company or which path a run
// tried to reach.
const REJECTED_CREDENTIAL_HOME_MESSAGE =
  "The credential home is outside the company-managed directory tree.";

/**
 * Thrown only for a containment rejection: a candidate directory outside the
 * company-managed tree, under the wrong company, or reached through a
 * symbolic link. A caller can catch this class alone to treat "not
 * contained" as benign, and let every other error (a permission fault, an
 * unexpected read fault) stay fail-loud. The message is fixed text with no
 * path and no identifier.
 */
export class ManagedCredentialHomeRejectedError extends Error {
  constructor() {
    super(REJECTED_CREDENTIAL_HOME_MESSAGE);
    this.name = "ManagedCredentialHomeRejectedError";
  }
}

function rejectCredentialHome(): never {
  throw new ManagedCredentialHomeRejectedError();
}

/** Splits an absolute path into its root (`/`, or a drive letter such as `C:\`) followed by each directory segment, in order. */
function splitPathIntoSegments(absolutePath: string): string[] {
  const { root } = path.parse(absolutePath);
  const rest = absolutePath.slice(root.length);
  const segments = rest.split(path.sep).filter((segment) => segment.length > 0);
  return [root, ...segments];
}

/**
 * True when `dir` contains exactly one entry whose name matches `name` when
 * both are compared in lower case.
 *
 * On a filesystem that folds case, two spellings that differ only by letter
 * case cannot both exist as separate entries in the same directory — the
 * filesystem stores one entry, addressable by any casing. On a filesystem
 * that does not fold case, an attacker can create a second, distinct entry
 * next to the expected one, differing only by letter case. Counting the
 * matching entries tells these two situations apart directly, without any
 * assumption about the host platform.
 */
async function directoryHasExactlyOneEntryIgnoringCase(dir: string, name: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const target = name.toLowerCase();
  return entries.filter((entry) => entry.toLowerCase() === target).length === 1;
}

/**
 * True when `realPath` (the output of `fs.realpath`) matches `literalPath`
 * (the same path built from configuration, not yet resolved) closely enough
 * to trust as the SAME location, not a redirect to a different one.
 *
 * An exact match always passes. Otherwise this walks both paths segment by
 * segment. A segment pair must match exactly, or match only by letter case —
 * anything else is a real redirect, rejected immediately. For a
 * letter-case-only segment, this checks the real parent directory on disk
 * with {@link directoryHasExactlyOneEntryIgnoringCase}: exactly one matching
 * entry means the filesystem folds case there, so the difference is benign;
 * two or more means a colliding, differently-cased entry exists, so the
 * difference is treated as a redirect and rejected.
 *
 * This does not assume case-folding from the host platform. A non-Linux
 * platform is not proof of a case-insensitive filesystem — macOS and other
 * non-Linux hosts can mount or format a case-sensitive filesystem — so a
 * platform check alone could accept a redirect through a colliding,
 * differently-cased sibling entry. Checking the actual directory entries
 * instead catches that redirect on every platform.
 */
async function realPathMatchesLiteral(realPath: string, literalPath: string): Promise<boolean> {
  if (realPath === literalPath) return true;

  const realSegments = splitPathIntoSegments(realPath);
  const literalSegments = splitPathIntoSegments(literalPath);
  if (realSegments.length !== literalSegments.length) return false;

  let realPrefix = "";
  for (let i = 0; i < realSegments.length; i++) {
    const realSegment = realSegments[i];
    const literalSegment = literalSegments[i];
    if (realSegment !== literalSegment) {
      if (realSegment.toLowerCase() !== literalSegment.toLowerCase()) return false;
      // The root segment (a drive letter or the POSIX "/") has no parent
      // directory to hold a colliding sibling, so a case-only difference
      // there is tolerated directly, with no directory check to run.
      if (i > 0 && !(await directoryHasExactlyOneEntryIgnoringCase(realPrefix, realSegment))) {
        return false;
      }
    }
    realPrefix = i === 0 ? realSegment : path.join(realPrefix, realSegment);
  }
  return true;
}

/** True when `segment` is exactly one path component: not empty, not `.` or `..`, and free of a path separator. */
function isSafePathSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment === "." || segment === "..") return false;
  return !segment.includes("/") && !segment.includes("\\");
}

export interface AssertManagedCredentialHomeInput {
  env?: NodeJS.ProcessEnv;
  companyId: string;
  candidateDir: string;
}

export interface ManagedCredentialHomeBoundaryInput {
  env?: NodeJS.ProcessEnv;
  companyId: string;
}

/**
 * Resolves the real (symbolic-link-free) path of `candidateDir`. When the
 * directory does not exist yet, this walks up to the nearest existing
 * ancestor, resolves that ancestor's real path, and joins the still-missing
 * segments back on. This way a candidate a caller has not created yet still
 * gets a real prefix to check, and a symbolic link anywhere on an EXISTING
 * part of the path still resolves to its true target.
 */
async function resolveRealPathAllowingMissingSegments(candidateDir: string): Promise<string> {
  const resolved = path.resolve(candidateDir);
  const missingSegments: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const realAncestor = await fs.realpath(current);
      return missingSegments.length > 0
        ? path.join(realAncestor, ...missingSegments.reverse())
        : realAncestor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves and verifies the one real directory a company's credential writes
 * may land under: `<realCompaniesRoot>/<companyId>`.
 *
 * Anchors on the real `companies` directory itself, not on the company
 * directory. An earlier design resolved the company directory in isolation;
 * when the logical company directory was itself a symbolic link, that
 * resolution and a candidate's resolution both landed on the same link
 * target, so containment passed when it should not have. Anchoring one
 * level up removes that blind spot: `companyId` is validated as one path
 * segment and then checked with a no-follow `lstat`, so a symbolic link AT
 * the company-root segment is caught directly.
 *
 * Rejects with {@link REJECTED_CREDENTIAL_HOME_MESSAGE} when:
 * - the instance root does not exist.
 * - `PAPERCLIP_HOME`, its `instances` directory, or the instance root itself
 *   is a symbolic link, or sits anywhere other than its own literal,
 *   unresolved path once resolved — this stops a redirected ancestor from
 *   being silently adopted as the credential-write boundary. A redirected
 *   ancestor moves BOTH the instance root and the `companies` directory
 *   through the same target, so the `companies`-only check below cannot
 *   catch it on its own; this check must run first. A same-location
 *   difference of letter case only, the kind a case-insensitive filesystem's
 *   `fs.realpath` can return, is not a redirect and does not reject — see
 *   {@link realPathMatchesLiteral}.
 * - the `companies` directory does not exist.
 * - the `companies` directory is a symbolic link, or sits anywhere other
 *   than `<realInstanceRoot>/companies` once resolved — this stops a
 *   redirected `companies` entry from being silently adopted as the
 *   credential-write boundary.
 * - `companyId` is empty, is `.` or `..`, or contains a path separator.
 * - `<realCompaniesRoot>/<companyId>` is missing, is not a directory, or is
 *   a symbolic link.
 *
 * Call this again immediately before a write that uses the result. Do not
 * carry a boundary computed earlier across an `await` that the write does
 * not need — a mutable ancestor can be rebound while that write waits.
 */
export async function resolveManagedCredentialHomeBoundary(
  input: ManagedCredentialHomeBoundaryInput,
): Promise<string> {
  const env = input.env ?? process.env;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({ env });
  const companiesRoot = path.resolve(instanceRoot, "companies");

  let realInstanceRoot: string;
  try {
    realInstanceRoot = await fs.realpath(instanceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") rejectCredentialHome();
    throw error;
  }

  // A symbolic link anywhere up the ancestor chain — `PAPERCLIP_HOME`, its
  // `instances` directory, or the instance root itself — redirects
  // `realInstanceRoot` to an external location. The `companies`-root check
  // below re-derives its expected value from `realInstanceRoot`, so it
  // resolves through the SAME redirect on both sides and cannot detect this
  // on its own. Require the resolved instance root to match the literal,
  // unresolved `instanceRoot` (tolerating a letter-case-only difference the
  // real filesystem itself confirms is benign — see
  // {@link realPathMatchesLiteral}); anything else means some ancestor
  // component is a symbolic link, so reject before it can be adopted as the
  // boundary.
  if (!(await realPathMatchesLiteral(realInstanceRoot, instanceRoot))) {
    rejectCredentialHome();
  }

  let realCompaniesRoot: string;
  try {
    realCompaniesRoot = await fs.realpath(companiesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") rejectCredentialHome();
    throw error;
  }

  // A symbolic link at (or above) the `companies` segment can redirect
  // `realCompaniesRoot` to any external location `fs.realpath` is willing to
  // follow. Require it to land at `<realInstanceRoot>/companies` — the only
  // location a managed `companies` directory may occupy, tolerating a
  // letter-case-only difference the same way as the instance-root check
  // above — so a redirected companies root is rejected instead of silently
  // adopted as the credential-write boundary.
  if (!(await realPathMatchesLiteral(realCompaniesRoot, path.join(realInstanceRoot, "companies")))) {
    rejectCredentialHome();
  }

  if (!isSafePathSegment(input.companyId)) rejectCredentialHome();

  const companyDir = path.join(realCompaniesRoot, input.companyId);
  let companyStat;
  try {
    companyStat = await fs.lstat(companyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") rejectCredentialHome();
    throw error;
  }
  if (companyStat.isSymbolicLink() || !companyStat.isDirectory()) {
    rejectCredentialHome();
  }

  return companyDir;
}

/** The device and inode `fs.lstat` reported for one existing ancestor directory segment, at the moment a containment walk checked it. */
export interface ManagedCredentialAncestorIdentity {
  path: string;
  dev: number;
  ino: number;
}

/**
 * Verifies every EXISTING directory segment between `boundary` (a path
 * {@link resolveManagedCredentialHomeBoundary} already verified) and
 * `target` with a no-follow `lstat`, so a symbolic link anywhere in the
 * existing part of the chain is caught. Stops at the first segment that
 * does not exist yet — a copy-back may still create it, and a missing
 * segment carries no symbolic link to check.
 *
 * Returns the device and inode this walk recorded for every checked
 * segment EXCEPT `target` itself — every existing ANCESTOR of `target`, in
 * order. A caller that separately pins `target` behind a directory
 * descriptor can re-`lstat` these same ancestor paths after that open call
 * succeeds and compare identities, to catch a symbolic link substituted
 * into an ancestor segment in the gap between this walk and that open call,
 * then LEFT in place: `open`'s own `O_NOFOLLOW` flag only refuses a
 * symbolic link at the FINAL path segment, so it cannot see that swap, and
 * neither can a plain `lstat` of `target` alone — resolved through the same
 * swapped ancestor, it reports the same identity as the (attacker-pointing)
 * pinned descriptor. `target` itself is excluded because a caller re-checks
 * it a different way: against the pinned descriptor's own identity,
 * immediately before each write, not against a value this walk recorded
 * before the open call ran.
 *
 * Node.js exposes no `openat`, `mkdirat`, or `renameat`, so this walk
 * cannot pin a directory file descriptor across the segments the way a
 * single kernel-level containment check would. Calling this immediately
 * before the write it guards — with no other `await` in between — is the
 * strongest containment the standard library supports; a segment could
 * still be rebound in the gap between this call returning and the write
 * that follows it.
 */
export async function assertNoSymlinkInManagedCredentialPathAndCaptureAncestors(
  boundary: string,
  target: string,
): Promise<ManagedCredentialAncestorIdentity[]> {
  const relative = path.relative(boundary, target);
  if (relative === "") return [];
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    rejectCredentialHome();
  }

  const segments = relative.split(path.sep);
  const ancestorIdentities: ManagedCredentialAncestorIdentity[] = [];
  let current = boundary;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ancestorIdentities;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      rejectCredentialHome();
    }
    const isTargetItself = i === segments.length - 1;
    if (!isTargetItself) {
      ancestorIdentities.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
  }
  return ancestorIdentities;
}

/**
 * Verifies every EXISTING directory segment between `boundary` and `target`,
 * the same way as {@link assertNoSymlinkInManagedCredentialPathAndCaptureAncestors},
 * for a caller that only needs the pass/reject outcome.
 */
export async function assertNoSymlinkInManagedCredentialPath(
  boundary: string,
  target: string,
): Promise<void> {
  await assertNoSymlinkInManagedCredentialPathAndCaptureAncestors(boundary, target);
}

/**
 * Guards a Codex/Grok credential copy-back target. Call this with the
 * directory a copy-back is about to write into, before any file write.
 *
 * Verifies the company boundary with {@link resolveManagedCredentialHomeBoundary},
 * then walks the ORIGINAL, unresolved `candidateDir` against the literal
 * boundary text with a no-follow `lstat` through
 * {@link assertNoSymlinkInManagedCredentialPath}, so a symbolic link
 * anywhere in the candidate — even one whose target is still inside the
 * company tree — is rejected before it can be followed. Only then resolves
 * the real path of `candidateDir`, requires the candidate to equal the
 * boundary or sit under it, and re-checks every existing segment between
 * them a second time. Rejects every other candidate — a path outside the
 * instance root, a path under a different company, a symbolic link anywhere
 * on the chain, and a relative path that escapes with `..` — with the fixed
 * {@link REJECTED_CREDENTIAL_HOME_MESSAGE}.
 *
 * Returns the resolved, real candidate directory on success. A caller that
 * uses the result for a write must not treat it as still valid after an
 * unrelated `await` — re-verify with {@link assertNoSymlinkInManagedCredentialPath}
 * right before that write.
 */
export async function assertManagedCredentialHome(
  input: AssertManagedCredentialHomeInput,
): Promise<string> {
  const boundary = await resolveManagedCredentialHomeBoundary(input);

  // Reject a symbolic link anywhere in the ORIGINAL candidate path before any
  // symlink-following resolution runs. Compare against the LITERAL boundary
  // text (`<instanceRoot>/companies/<companyId>`, not yet real-pathed) — a
  // caller always builds a managed candidate directory with that same
  // literal text, so an honest candidate still passes. The resolution below
  // calls `fs.realpath`, which follows a symbolic link and adopts its
  // target — including an in-tree link that points at a different, equally
  // in-tree location, for example another account's credential home. A
  // no-follow walk over the ALREADY-RESOLVED path can never see a link the
  // resolution already followed, so this walk must run first, on the
  // unresolved path.
  const env = input.env ?? process.env;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({ env });
  const literalBoundary = path.resolve(instanceRoot, "companies", input.companyId);
  await assertNoSymlinkInManagedCredentialPath(literalBoundary, path.resolve(input.candidateDir));

  const realCandidateDir = await resolveRealPathAllowingMissingSegments(input.candidateDir);

  const isContained =
    realCandidateDir === boundary || realCandidateDir.startsWith(boundary + path.sep);
  if (!isContained) {
    rejectCredentialHome();
  }

  await assertNoSymlinkInManagedCredentialPath(boundary, realCandidateDir);

  return realCandidateDir;
}
