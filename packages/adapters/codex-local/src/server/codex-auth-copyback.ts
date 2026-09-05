import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readlink, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertNoSymlinkInManagedCredentialPath,
  assertNoSymlinkInManagedCredentialPathAndCaptureAncestors,
  ManagedCredentialHomeRejectedError,
  resolveManagedCredentialHomeBoundary,
} from "@paperclipai/adapter-utils/managed-credential-home";
import type { ManagedCredentialAncestorIdentity } from "@paperclipai/adapter-utils/managed-credential-home";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  isCodexAuthCacheEnabled,
  readSubscriptionAccountId,
  writeCodexAuthCacheEntry,
} from "./codex-auth-cache.js";
import { USE_SOURCE_EXIT, decideCodexAuthMerge } from "./codex-auth-merge-decision.js";

// The outbound copy-back reuses the exact same direction-agnostic decision
// predicate the inbound restore runs, through the shared `decideCodexAuthMerge`
// entry point. The predicate answers one question — "should the caller replace
// `destination` with `source`?" — purely by argument order (first = source,
// second = destination). For the copy-back the sandbox credential is the
// `source` and the shared host credential is the `destination`, so exit 10 (use
// source) means "install the sandbox copy onto the host" and exit 20 (keep
// destination) means "leave the host copy untouched". The predicate only ever
// reads the two files and exits with a code; it never prints token bytes.

/** Outcome of a copy-back attempt. No token material is ever surfaced. */
export type CopyBackCodexAuthOutcome = "copied" | "kept-host";

export interface CopyBackCodexAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-destroyed)
   * sandbox. In production this is bound to the managed-runtime restore
   * context's `readFile` for `${assetDir}/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * Absolute path of the shared host credential to (maybe) overwrite — the
   * symlink *source* the managed Codex homes point their `auth.json` at, never
   * an in-sandbox or per-agent symlink. This path was validated once by a
   * caller before this function ran; that earlier check is not proof enough
   * on its own — see the re-verification note on {@link copyBackCodexAuth}.
   */
  hostAuthPath: string;
  /**
   * The company that owns `hostAuthPath`. When present, this function
   * independently re-resolves the company's containment boundary right
   * before the write, so it does not trust `hostAuthPath` on the strength of
   * an earlier caller's check alone. Omit only for a target this function's
   * caller already guards through a different, unmanaged boundary (for
   * example a run-scoped proof home): the re-verification is skipped, not
   * defaulted to a guess.
   */
  companyId?: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log: (line: string) => void | Promise<void>;
  /**
   * Resolves and ensures the per-identity cache slot path for a sandbox
   * `account_id`. When this is provided AND the cache off-switch is on, the
   * copy-back also writes the fresher, usable subscription credential into its
   * per-identity cache slot as a second, additive write, keyed by the real
   * `account_id`. This is independent of the host default overwrite: it can
   * write a cache slot for a different identity than the host holds (matrix rows
   * 1b, 3), and it never touches the host default store. When absent, no cache
   * write happens.
   */
  resolveCacheEntryPath?: (accountId: string) => Promise<string>;
  /** Environment for the cache off-switch read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Identity of an open credential file: the device and inode its descriptor's
 * own `fstat` reports, plus the inode's change time (`ctime`). `ctime`
 * updates on every write to the file's own content, even one that keeps the
 * same device and inode (an in-place truncate-and-rewrite), and no syscall
 * lets a same-user process set `ctime` back to an earlier value the way
 * `utimes` can forge `mtime` — so a mismatch on any one of the three fields
 * proves the file changed since this identity was captured.
 */
interface CredentialFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
}

/**
 * Opens the host credential with `O_NOFOLLOW`, then reads its bytes back
 * through that SAME descriptor and returns the descriptor's own `fstat`
 * identity alongside those bytes — one atomic open-then-read, so the bytes
 * this hands to the merge decision and the identity checked later by
 * {@link assertHostCredentialIdentityUnchanged} always describe the exact
 * same file object, never two separate reads of a name a local process
 * could repoint in between. Returns `undefined` when the host credential is
 * genuinely absent (`ENOENT`); every other open or read error stays
 * fail-loud, including a symbolic link at the credential's own path
 * (`ELOOP`) — the shared host credential must always be a plain file.
 */
async function readHostCredentialSnapshot(
  hostAuthFilePath: string,
): Promise<{ bytes: Buffer; identity: CredentialFileIdentity } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(hostAuthFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    const bytes = await handle.readFile();
    return { bytes, identity: { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs } };
  } finally {
    await handle.close();
  }
}

/**
 * Thrown only when the host credential FILE's identity no longer matches
 * the identity {@link readHostCredentialSnapshot} captured when it fed the
 * merge decision. The directory-identity checks elsewhere in this module
 * prove the ENCLOSING DIRECTORY was not replaced; they say nothing about
 * `auth.json` itself. A same-user process can replace it with a decoy right
 * after the decision read, let the decision compare the sandbox copy
 * against that decoy, then restore the original file before the write that
 * follows — a restore that a directory-only identity check cannot see,
 * because the directory itself never changed. A caller must not catch this
 * as benign; it must stay fail-loud like every other unexpected write
 * error.
 */
export class CopyBackCredentialReplacedError extends Error {
  constructor() {
    super(
      "Codex auth copy-back: the host credential changed identity between the decision read and the write.",
    );
    this.name = "CopyBackCredentialReplacedError";
  }
}

/**
 * Compares a fresh, no-follow read of the host credential's identity against
 * the identity {@link readHostCredentialSnapshot} captured when it fed the
 * merge decision. A device, inode, or `ctime` mismatch — or the credential
 * turning into a symbolic link, or existing now when it was absent then, or
 * the reverse — all mean something replaced `auth.json` since the decision
 * read it, so this rejects instead of letting the write below proceed on a
 * decision made against a different file. Call this immediately before the
 * write that follows, with no other `await` in between.
 */
async function assertHostCredentialIdentityUnchanged(
  hostAuthFilePath: string,
  expectedIdentity: CredentialFileIdentity | undefined,
): Promise<void> {
  let liveStat;
  try {
    liveStat = await lstat(hostAuthFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      if (expectedIdentity !== undefined) {
        throw new CopyBackCredentialReplacedError();
      }
      return;
    }
    throw error;
  }
  if (
    expectedIdentity === undefined ||
    liveStat.isSymbolicLink() ||
    liveStat.dev !== expectedIdentity.dev ||
    liveStat.ino !== expectedIdentity.ino ||
    liveStat.ctimeMs !== expectedIdentity.ctimeMs
  ) {
    throw new CopyBackCredentialReplacedError();
  }
}

/**
 * Thrown only when the host directory's identity no longer matches what an
 * earlier check approved:
 * - the pinned descriptor's device and inode no longer match a fresh,
 *   no-follow read of the same path, taken immediately before a write; or
 * - (Linux only) the descriptor's own kernel-resolved real path, read back
 *   right after it was opened, does not match the directory the containment
 *   walk approved; or
 * - (every other platform) one of the containment walk's recorded ancestor
 *   segments no longer matches a fresh, no-follow read of that same
 *   ancestor path, taken right after the directory-pin open call succeeded.
 *
 * Each case means something replaced a directory — the target itself, or
 * one of its ancestors — since the last check, a directory-replacement
 * race, not a benign "target is outside the managed tree" outcome. A caller
 * must not catch this as benign; it must stay fail-loud like every other
 * unexpected write error.
 */
export class CopyBackDirectoryReplacedError extends Error {
  constructor() {
    super(
      "Codex auth copy-back: the host directory changed identity between the last check and the write.",
    );
    this.name = "CopyBackDirectoryReplacedError";
  }
}

/**
 * Compares the pinned directory descriptor's identity to a fresh, no-follow
 * read of the plain directory path. A Linux write addresses the pinned
 * descriptor itself (through its `/proc/self/fd` alias), so a later swap of
 * the plain path text cannot redirect it; a non-Linux write still addresses
 * that plain path text directly, so it needs this last check. A directory
 * removed and recreated under the same name carries a new device/inode pair
 * even though it is a plain directory, not a symbolic link — a check for
 * "not a symbolic link" alone cannot see that swap, so this call compares
 * identity instead. Call this immediately before each write that follows,
 * with no other `await` in between.
 */
async function assertPinnedDirectoryStillLive(pinnedDir: FileHandle, plainDirPath: string): Promise<void> {
  const [pinnedStat, liveStat] = await Promise.all([pinnedDir.stat(), lstat(plainDirPath)]);
  if (pinnedStat.dev !== liveStat.dev || pinnedStat.ino !== liveStat.ino) {
    throw new CopyBackDirectoryReplacedError();
  }
}

/**
 * Verifies, on Linux only, that an `O_NOFOLLOW`-opened directory descriptor
 * actually addresses `expectedRealDir` — the exact real path a containment
 * walk already approved.
 *
 * `open(path, O_NOFOLLOW)` still resolves every ANCESTOR segment of `path`
 * by re-walking the plain path text from the root; `O_NOFOLLOW` only refuses
 * a symbolic link at the FINAL segment. A symbolic link substituted into an
 * ancestor segment in the gap between a containment walk and this open call
 * is silently followed by the kernel, so the open call can succeed while
 * `pinnedDir` addresses a directory outside the managed tree entirely — an
 * outcome the open call's own success cannot reveal.
 *
 * `/proc/self/fd/<fd>` is a kernel-maintained record of what the descriptor
 * actually addresses, built from the same dentry the open call resolved to —
 * not a second re-walk of the same attacker-reachable path text — so reading
 * it back and comparing against the approved real path closes that gap:
 * whatever the open call actually landed on, this either confirms it is the
 * approved directory or rejects it. `/proc` does not exist on a non-Linux
 * platform, so this additional proof is Linux-only; the pinned-identity
 * re-checks before each write remain the containment there.
 */
async function assertOpenedDirectoryMatchesRealPath(
  pinnedDir: FileHandle,
  expectedRealDir: string,
): Promise<void> {
  const openedRealDir = await readlink(`/proc/self/fd/${pinnedDir.fd}`);
  if (openedRealDir !== expectedRealDir) {
    throw new CopyBackDirectoryReplacedError();
  }
}

/**
 * Verifies, on a non-Linux platform only, that every ancestor segment
 * {@link assertNoSymlinkInManagedCredentialPathAndCaptureAncestors} recorded
 * during the lock-time containment walk still carries the SAME device and
 * inode.
 *
 * `open(path, O_NOFOLLOW)` still resolves every ANCESTOR segment of `path`
 * by re-walking the plain path text from the root; `O_NOFOLLOW` only
 * refuses a symbolic link at the FINAL segment. A symbolic link substituted
 * into an ancestor segment in the gap between the containment walk and the
 * directory-pin open call is silently followed by the kernel, so that open
 * call can succeed while the pinned descriptor addresses a directory
 * outside the managed tree — an outcome its own success cannot reveal. When
 * the attacker LEAVES that ancestor swapped in place, a plain `lstat` of
 * the LEAF path alone cannot see it either: resolved through the same
 * swapped ancestor, it reports the same identity as the (attacker-pointing)
 * pinned descriptor, so a leaf-only identity check agrees with the pin and
 * passes. Comparing each ANCESTOR segment's identity instead catches this:
 * a symbolic link substituted into an ancestor reports the symbolic link's
 * OWN identity here, not the real directory's it stood in for, so the
 * comparison fails and this rejects. An ancestor swap that is instead
 * RESTORED before a write is caught the other way: the pinned descriptor
 * still addresses the attacker's directory while the leaf path now resolves
 * through the restored ancestor to the real one, so the leaf identity check
 * a caller runs before each write (see the module-level `copyBackCodexAuth`
 * documentation) rejects that case. Call this once, immediately after the
 * pin `open` call succeeds, with no other `await` in between.
 */
async function assertManagedCredentialAncestorsStillLive(
  ancestorIdentities: readonly ManagedCredentialAncestorIdentity[],
): Promise<void> {
  const liveStats = await Promise.all(ancestorIdentities.map((identity) => lstat(identity.path)));
  for (const [index, identity] of ancestorIdentities.entries()) {
    const liveStat = liveStats[index];
    // A symbolic link substituted at this ancestor is rejected on file type
    // alone, never on device/inode alone: a freshly created filesystem
    // object CAN be handed back the exact device/inode pair a just-removed
    // directory held (some filesystems reuse a just-freed inode number
    // immediately), so a symbolic link swapped in could coincidentally
    // match the recorded identity even though it is no longer a directory
    // at all. Checking the live entry is still a plain directory closes
    // that gap independently of any such reuse.
    if (
      liveStat.isSymbolicLink() ||
      !liveStat.isDirectory() ||
      liveStat.dev !== identity.dev ||
      liveStat.ino !== identity.ino
    ) {
      throw new CopyBackDirectoryReplacedError();
    }
  }
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Codex
 * `auth.json` onto the shared host credential at teardown.
 *
 * Sequence, all under `withDirectoryMergeLock` on the host target's directory
 * so a concurrent inbound restore or another copy-back can't interleave:
 *   1. Read the sandbox credential bytes. A genuinely absent sandbox
 *      `auth.json` (ENOENT) means there is simply nothing to copy back, so it
 *      resolves to `kept-host` (benign no-op, host untouched); every other read
 *      error stays fail-loud.
 *   2. When the caller passes `companyId`, re-verify `hostAuthPath`'s
 *      directory right before the write. A caller validates `hostAuthPath`
 *      before it calls this function, but time passes between that check
 *      and this write — the sandbox read above and the directory-lock wait
 *      both await. A mutable ancestor directory can be rebound to a symbolic
 *      link in that window, so this function re-resolves the company
 *      boundary and re-walks every existing path segment with a no-follow
 *      `lstat` immediately before it creates anything. A caller that omits
 *      `companyId` guards its target through a different, unmanaged
 *      boundary, so this step is skipped.
 *   3. Inside the lock, re-verify a THIRD time against the real path
 *      `withDirectoryMergeLock` itself just resolved (`fs.realpath` on
 *      `hostDir`, taken at lock-acquisition time). Immediately after — with
 *      no further `await` in between — open that real directory with
 *      `O_DIRECTORY | O_NOFOLLOW` and pin it behind the returned file
 *      descriptor, on every platform. This single open call is itself a
 *      fourth, atomic re-check: it fails outright instead of opening a
 *      non-directory or a symbolic link at the FINAL path segment, so a
 *      swap of that final segment in the gap the third check cannot see
 *      (between that check returning and this open running) is still
 *      caught. `O_NOFOLLOW` says nothing about an ANCESTOR segment, though:
 *      the open call still re-walks the full path from the root, so a
 *      symbolic link substituted into an ancestor segment in that same gap
 *      is silently followed, and the open call can succeed while the
 *      descriptor addresses a directory outside the managed tree. On Linux,
 *      a fifth check closes that gap: read the descriptor's own
 *      kernel-resolved real path back from `/proc/self/fd/<fd>` and reject
 *      unless it still names the exact directory the third check approved —
 *      a record built from the same dentry the open call resolved to, not a
 *      second re-walk of the same attacker-reachable path text. Only once
 *      that check passes do writes below resolve through this descriptor's
 *      `/proc/self/fd/<fd>` alias, never through the plain directory path
 *      string again, so a LATER swap of that string cannot redirect a write
 *      the way it could when a write only ever re-used a path already
 *      re-walked from the root. `/proc` does not exist on a non-Linux
 *      platform, so there the fifth check instead re-verifies every ancestor
 *      segment the second check (step 2) recorded the device and inode of,
 *      with a fresh, no-follow `lstat` of each: an ancestor symbolic link
 *      substituted in the same gap and LEFT in place reports its own
 *      identity here, not the real directory's, so this still catches it
 *      even though the leaf path alone — resolved through that same swapped
 *      ancestor — would report the same identity as the (attacker-pointing)
 *      descriptor and so cannot. The writes below then still address the
 *      plain `hostDir` text — but immediately before each of those writes,
 *      with no other `await` in between, the pinned descriptor's identity
 *      (device and inode) is compared against a fresh, no-follow read of
 *      that same plain text. A directory removed and recreated under the
 *      same name is still caught this way even though it is a plain
 *      directory, not a symbolic link, and so cannot be caught by a
 *      symbolic-link-only check; an ancestor swap that is RESTORED before a
 *      write — the case the fifth check's one-time, right-after-open
 *      comparison cannot see — is caught here instead, because the pinned
 *      descriptor still addresses the attacker's directory while the leaf
 *      path now resolves through the restored ancestor to the real one.
 *      Node.js exposes no `openat` or `renameat`, so together these two
 *      identity checks are the strongest containment the standard library
 *      supports without a Linux-only descriptor pin.
 *   4. Stage the bytes to a `0600` temp file inside the pinned directory
 *      (same filesystem as the host target, which doubles as the predicate
 *      `source`). The open uses `O_EXCL` so it fails instead of following or
 *      overwriting an existing entry, and `O_NOFOLLOW` so it refuses outright
 *      if the temp name is (or became) a symbolic link.
 *   5. On every platform, snapshot the CURRENT host credential bytes into a
 *      second private temp file, together with the identity
 *      {@link readHostCredentialSnapshot} reads back from the very
 *      descriptor it read those bytes through, and hand the predicate that
 *      frozen snapshot instead of the live host path — see the module-level
 *      note after this list for why. Then run the newer-wins decision
 *      predicate (`source` = sandbox temp, `destination` = the snapshot).
 *      Exit 10 → adopt the sandbox copy; exit 20 → keep the host copy.
 *   6. On exit 10, re-verify the host credential's identity — device, inode,
 *      and `ctime` — against the one step 5 captured, with no other `await`
 *      in between; see {@link assertHostCredentialIdentityUnchanged}. Only
 *      once that passes, `rename` the staged temp over the host target, both
 *      addressed through the pinned directory's descriptor alias. `rename`
 *      never follows a destination symbolic link — it replaces the link
 *      entry itself — so even a `hostAuthPath` swapped to a symbolic link in
 *      this window is overwritten in place, never written through. This is
 *      an atomic same-directory swap that preserves mode `0600`. On exit 20,
 *      discard the temp file.
 * The staged temp and the destination snapshot are always removed (rename
 * consumes the staged temp on the copy path; the finally cleans up both
 * otherwise), so a failure never leaves a partial file. Never logs token
 * bytes — only the decision outcome.
 *
 * The decision predicate (step 5) runs in a separate `node` child process, so
 * it cannot use this process's `/proc/self/fd` alias — `self` inside that
 * child would name the CHILD's own descriptor table, not this parent's. On
 * Linux the predicate's sandbox-side read argument instead names the pinned
 * descriptor through this parent process's real pid, `/proc/<pid>/fd/<fd>`, a
 * kernel-maintained record any process with the same user id can read — so
 * the read side resolves through the exact same pinned directory the write
 * side (step 4's create and step 6's `rename`) already uses, and a later swap
 * of the plain directory path text cannot make the two sides disagree. The
 * predicate's destination-side read argument is the frozen snapshot from
 * step 5, on every platform.
 *
 * On a non-Linux platform, the predicate's read of the sandbox temp still
 * uses the plain, re-verified directory path text — safe, because the temp's
 * name is a value this function only just generated with a random id, so a
 * local process cannot pre-stage a decoy under that exact name before this
 * function creates the real one; substituting the whole directory to defeat
 * that name check breaks the temp lookup outright, which the predicate
 * treats as an unusable source and fails closed to "keep destination".
 *
 * The predicate's read of the HOST credential is different in kind, on every
 * platform: `hostAuthPath` is a fixed, standing name a local process already
 * knows, so it cannot rely on an unguessable name the way the sandbox temp
 * does. Reading it live, by name, at whatever moment the predicate's own
 * child process happens to open it, would let a swap-and-restore around that
 * read compare the predicate against a decoy while the write side, re-
 * verified right before the `rename`, ends up addressing the genuine,
 * restored target — so the decision and the write would silently disagree
 * about which host credential they each saw. This applies at two different
 * levels: a non-Linux platform can have its ENCLOSING DIRECTORY swapped and
 * restored around the read (a gap the pinned descriptor alone does not
 * close there); on every platform, `auth.json` itself can be swapped and
 * restored around the read without the enclosing directory ever changing
 * identity at all — a gap no directory-identity check, on any platform, was
 * ever positioned to see. Step 5 above closes both by reading the host
 * credential itself, through an opened descriptor, immediately next to an
 * `fstat` read of that same descriptor, and handing the predicate a frozen
 * snapshot in place of the live path; step 6 then re-verifies that captured
 * identity — not just the enclosing directory's — right before the write
 * that follows, so a later swap-and-restore, of the directory or of the
 * credential file alone, can no longer make the decision and the write
 * silently disagree about which host credential they each saw.
 */
export async function copyBackCodexAuth(input: CopyBackCodexAuthInput): Promise<CopyBackCodexAuthOutcome> {
  const { readSandboxAuth, hostAuthPath, companyId, log, resolveCacheEntryPath, env } = input;

  // Read first (outside the lock) — a read never mutates the host, so there is
  // nothing to serialize yet. A genuinely absent sandbox `auth.json` (ENOENT —
  // e.g. Codex removed it mid-run, or a non-provisioned edge) is a "nothing to
  // copy back" no-op, not a teardown failure: return `kept-host` and log the
  // benign outcome. Every other read error stays fail-loud so a real read fault
  // is never silently mistaken for "nothing to copy back".
  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await log(
        "[paperclip] Codex auth copy-back: no sandbox credential to copy back (absent auth.json); host credential kept.",
      );
      return "kept-host";
    }
    throw error;
  }

  const hostDir = path.dirname(hostAuthPath);
  const hostAuthFileName = path.basename(hostAuthPath);

  const skippedOutsideTreeLog =
    "[paperclip] Codex auth copy-back: skipped (the configured Codex home is outside the managed directory tree).";

  // Re-verify right before the write. Do not trust `hostAuthPath` on the
  // strength of a caller's earlier check alone — re-resolve the boundary and
  // re-walk the path with a no-follow `lstat` here, as close to the `mkdir`
  // below as possible. Only a containment rejection is a benign "outside the
  // managed tree" outcome; every other error stays fail-loud, matching the
  // sandbox-read handling above. A caller that omits `companyId` guards its
  // target through a different, unmanaged boundary, so there is no company
  // containment to re-check here.
  let boundary: string | undefined;
  if (companyId) {
    try {
      boundary = await resolveManagedCredentialHomeBoundary({ env, companyId });
      await assertNoSymlinkInManagedCredentialPath(boundary, hostDir);
    } catch (error) {
      if (!(error instanceof ManagedCredentialHomeRejectedError)) {
        throw error;
      }
      await log(skippedOutsideTreeLog);
      return "kept-host";
    }
  }

  await mkdir(hostDir, { recursive: true });
  const hostOutcome = await withDirectoryMergeLock(
    hostDir,
    async (canonicalHostDir) => {
      // `withDirectoryMergeLock` resolved `hostDir`'s real path to compute
      // the lock key, at the instant the lock was acquired. Re-verify
      // against that fresh resolution — not the literal `hostDir` above —
      // with no `await` in between, and use it for every write below. This
      // catches a symbolic-link swap that happened during the `mkdir` call
      // or the lock-acquisition wait, the gap the check above cannot see.
      // Recording the ancestor identities here, alongside the symlink
      // re-check, lets the pinned-open path below re-verify each of them
      // after the open succeeds — see
      // `assertManagedCredentialAncestorsStillLive`. A caller that omits
      // `companyId` has no `boundary`, so `ancestorIdentities` stays empty
      // and that later re-check becomes a no-op for it, same as this walk.
      let ancestorIdentities: ManagedCredentialAncestorIdentity[] = [];
      if (boundary) {
        try {
          ancestorIdentities = await assertNoSymlinkInManagedCredentialPathAndCaptureAncestors(
            boundary,
            canonicalHostDir,
          );
        } catch (error) {
          if (!(error instanceof ManagedCredentialHomeRejectedError)) {
            throw error;
          }
          await log(skippedOutsideTreeLog);
          return "kept-host";
        }
      }

      // Pin `canonicalHostDir` behind a file descriptor on every platform,
      // immediately, with no further `await` before it is used. `O_DIRECTORY
      // | O_NOFOLLOW` makes this open call a fourth, atomic re-check: it
      // fails with `ELOOP` or `ENOTDIR` instead of opening a symbolic link or
      // a non-directory, so a swap that lands in the gap the check above
      // cannot see is still caught here.
      let pinnedDir: FileHandle;
      try {
        pinnedDir = await open(
          canonicalHostDir,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== "ELOOP" && code !== "ENOTDIR") {
          throw error;
        }
        await log(skippedOutsideTreeLog);
        return "kept-host";
      }

      try {
        // `open()` still resolves every ANCESTOR segment of `canonicalHostDir`
        // by re-walking the plain path text from the root; `O_NOFOLLOW` above
        // only refused a symbolic link at the FINAL segment. A symbolic link
        // substituted into an ancestor segment in the gap between the
        // containment walk above and the open call just now would be
        // silently followed by the kernel, so the open call above could have
        // succeeded while `pinnedDir` addresses a directory outside the
        // managed tree — an outcome the open call's own success cannot
        // reveal. Close that gap on Linux by reading the descriptor's own
        // kernel-resolved real path back and rejecting unless it is still
        // the exact directory the containment walk approved. `/proc` does
        // not exist on a non-Linux platform, so there this instead
        // re-verifies every ancestor segment the containment walk above
        // recorded: a symbolic link substituted into an ancestor and LEFT in
        // place carries its own identity, not the real directory's, so that
        // comparison still catches it even though a plain `lstat` of the
        // LEAF path alone — resolved through the same swapped ancestor —
        // cannot. See `assertManagedCredentialAncestorsStillLive`.
        if (process.platform === "linux") {
          await assertOpenedDirectoryMatchesRealPath(pinnedDir, canonicalHostDir);
        } else {
          await assertManagedCredentialAncestorsStillLive(ancestorIdentities);
        }

        // On Linux, every write below resolves through this descriptor's
        // `/proc/self/fd/<fd>` alias, not the plain `canonicalHostDir` text
        // used until now, so a swap of that text AFTER this point can no
        // longer redirect a write. `/proc` does not exist on a non-Linux
        // platform, so there `writeDirPath` stays the plain `canonicalHostDir`
        // text, and each write below calls {@link assertPinnedDirectoryStillLive}
        // immediately beforehand to re-verify that text still names the
        // SAME directory `pinnedDir` was opened against.
        const writeDirPath =
          process.platform === "linux" ? `/proc/self/fd/${pinnedDir.fd}` : canonicalHostDir;

        // The decision predicate below runs in a separate `node` child
        // process, so `/proc/self/fd` would name that CHILD's own descriptor
        // table, not this parent's — `writeDirPath` above is unusable for a
        // path this process hands to a different process. `/proc/<pid>/fd/<fd>`
        // (this process's own real pid, not `self`) is a kernel-maintained
        // record any process with the same user id can read, so it lets the
        // child address the exact directory `pinnedDir` was opened against.
        // On Linux this makes both predicate read arguments below resolve
        // through the pinned descriptor, the same as every write above — a
        // swap of the plain `canonicalHostDir` text after this point can no
        // longer make the read side see a different directory than the write
        // side. `/proc` does not exist on a non-Linux platform, so there
        // `readDirPath` stays the plain `canonicalHostDir` text, unchanged
        // from the write side's own non-Linux behavior.
        const readDirPath =
          process.platform === "linux" ? `/proc/${process.pid}/fd/${pinnedDir.fd}` : canonicalHostDir;

        const canonicalHostAuthPath = path.join(readDirPath, hostAuthFileName);

        // Stage on the same filesystem as the host target so both the predicate read
        // and the final rename stay device-local (rename across devices is not
        // atomic and would fail with EXDEV). Both the create below and the rename
        // that follows address the file through `writeDirPath`; the predicate read
        // below addresses it through `readDirPath` instead — the pinned directory
        // descriptor on Linux for both, the plain re-verified directory text
        // everywhere else.
        const tempFileName = `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`;
        const stagedTempPath = path.join(readDirPath, tempFileName);
        const writeStagedTempPath = path.join(writeDirPath, tempFileName);
        const writeHostAuthPath = path.join(writeDirPath, hostAuthFileName);

        // A non-Linux write addresses `canonicalHostDir` by plain text, not
        // through `pinnedDir` itself, so re-verify the text still names the
        // directory `pinnedDir` was opened against, immediately before the
        // first write that uses it. Linux writes through `pinnedDir`'s own
        // `/proc/self/fd` alias, so this check is unnecessary there.
        if (process.platform !== "linux") {
          await assertPinnedDirectoryStillLive(pinnedDir, canonicalHostDir);
        }

        // `O_CREAT | O_EXCL` creates the temp private and fails instead of
        // following or overwriting an existing entry; `O_NOFOLLOW` additionally
        // refuses outright if that entry is a symbolic link.
        const handle = await open(
          writeStagedTempPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        // The decision predicate reads its two arguments inside a separate
        // `node` child process, at whatever moment THAT process happens to
        // open them — real elapsed time no identity check in this parent can
        // bracket, because the read never happens here. On a non-Linux
        // platform a local process could swap `canonicalHostDir` for a
        // directory holding a decoy host credential, let the predicate read
        // the decoy, then restore the exact original directory (same device
        // and inode) before a directory-only re-check — a check that only
        // compares directory identity, so a perfectly restored original
        // passes it even though the predicate compared against the decoy. On
        // every platform, independent of any directory-level swap, a local
        // process could instead replace just `auth.json` itself with a decoy
        // and restore it afterward: the directory never changes at all, so a
        // directory-identity check cannot see this either — on Linux, the
        // pinned descriptor's own `/proc/<pid>/fd/<fd>` alias still performs
        // a fresh by-name lookup of `auth.json` inside that directory on
        // every read, so it is no defense against a swap of the entry itself.
        // `readHostCredentialSnapshot` closes both gaps at once: it opens the
        // host credential once, reads its bytes back through that same
        // descriptor, and returns the descriptor's own `fstat` identity
        // alongside those bytes, so the bytes handed to the predicate and the
        // identity {@link assertHostCredentialIdentityUnchanged} checks later
        // always describe one same file, on every platform. Freeze those
        // bytes into a private, unguessable temp file and hand the predicate
        // that frozen snapshot instead of the live host path: a later
        // swap-and-restore, of the directory or of the credential file alone,
        // can then no longer change what the predicate reads, because it no
        // longer reads the live path at all.
        let destinationSnapshotPath: string | undefined;
        let destinationIdentity: CredentialFileIdentity | undefined;
        try {
          await handle.writeFile(sandboxAuthBytes);
          await handle.close();

          if (process.platform !== "linux") {
            await assertPinnedDirectoryStillLive(pinnedDir, canonicalHostDir);
          }

          const destinationSnapshot = await readHostCredentialSnapshot(canonicalHostAuthPath);
          destinationIdentity = destinationSnapshot?.identity;
          // Built from `readDirPath`, not `writeDirPath`: the decision
          // predicate below reads this path from a separate `node` CHILD
          // process, where `/proc/self/fd` would name the CHILD's own
          // descriptor table, not this parent's. `readDirPath` names this
          // parent process's real pid on Linux, so the child reads through
          // the same pinned descriptor this parent just wrote through; this
          // parent can read and remove the same path just as well, since
          // its own real pid resolves for it exactly as `/proc/self` would.
          destinationSnapshotPath = path.join(
            readDirPath,
            `.auth.json.copyback-dest-${process.pid}-${randomUUID()}.tmp`,
          );
          if (destinationSnapshot !== undefined) {
            const destinationHandle = await open(
              destinationSnapshotPath,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
              0o600,
            );
            try {
              await destinationHandle.writeFile(destinationSnapshot.bytes);
            } finally {
              await destinationHandle.close();
            }
          }
          // Else genuinely absent: leave `destinationSnapshotPath` unwritten
          // so the predicate's own read of it also reports absent, matching
          // the live path's true state without reading the live path again.

          // The decision predicate runs in a separate `node` child process, so
          // it cannot address `writeDirPath`'s `/proc/self/fd` alias — `self`
          // would name the CHILD's own descriptor table. `stagedTempPath`
          // instead uses `readDirPath`, which on Linux names this parent
          // process's real pid, so the child reads through the same pinned
          // descriptor every write above uses; `destinationSnapshotPath` is
          // the frozen snapshot above instead of the live path, on every
          // platform. That read only feeds a comparison; it can skew which
          // side the predicate picks but never places attacker-controlled
          // bytes anywhere on its own.
          const decision = await decideCodexAuthMerge(stagedTempPath, destinationSnapshotPath, {
            errorLabel: "codex auth copy-back",
          });
          if (decision === USE_SOURCE_EXIT) {
            // The decision predicate above awaited a separate child process —
            // real time enough for a directory swap or a credential-file swap
            // the earlier checks could not see. Re-verify both immediately
            // before this write, with no other `await` in between.
            if (process.platform !== "linux") {
              await assertPinnedDirectoryStillLive(pinnedDir, canonicalHostDir);
            }
            await assertHostCredentialIdentityUnchanged(writeHostAuthPath, destinationIdentity);
            // Atomic same-directory swap through `writeDirPath`; rename
            // preserves the temp's 0600 mode.
            await rename(writeStagedTempPath, writeHostAuthPath);
            await log(
              "[paperclip] Codex auth copy-back: sandbox credential is strictly newer for the same subscription identity; installed to the host at mode 0600.",
            );
            return "copied";
          }

          await log(
            "[paperclip] Codex auth copy-back: host credential kept (sandbox copy is not a strictly-newer same-identity subscription credential).",
          );
          return "kept-host";
        } finally {
          // Close is idempotent-safe to skip after an explicit close; the temp is the
          // thing that must never linger. On the copy path rename already consumed it
          // (force makes the removal a no-op); on every other path this deletes the
          // staged credential bytes.
          await handle.close().catch(() => undefined);
          await rm(writeStagedTempPath, { force: true }).catch(() => undefined);
          if (destinationSnapshotPath) {
            await rm(destinationSnapshotPath, { force: true }).catch(() => undefined);
          }
        }
      } finally {
        await pinnedDir?.close().catch(() => undefined);
      }
    },
    env,
  );

  // Additive cache write. Independent of the host default overwrite above: it
  // runs on its own directory lock, keys the slot by the real sandbox
  // `account_id`, and can write a slot for a different identity than the host
  // holds. It never touches the host default store. The off-switch (default on)
  // makes this a no-op when disabled. Only a usable subscription credential has
  // an identity to key; an api-key or unusable sandbox credential is skipped.
  //
  // The cache write is best-effort. The host copy-back above already finished
  // and set `hostOutcome`, so a failure of this additive write must not replace
  // that successful result. Catch the error, log it, and return `hostOutcome`.
  // The cache stays a hint: the next teardown re-attempts the write.
  if (resolveCacheEntryPath && isCodexAuthCacheEnabled(env)) {
    try {
      const sandboxAccountId = readSubscriptionAccountId(sandboxAuthBytes);
      if (sandboxAccountId) {
        const cacheEntryPath = await resolveCacheEntryPath(sandboxAccountId);
        await writeCodexAuthCacheEntry({ sandboxAuthBytes, cacheEntryPath, log, env });
      }
    } catch (error) {
      // Log only the errno code, never the error message. The message embeds the
      // cache slot path, and the slot path embeds the raw `account_id`; the code
      // (for example EACCES or ENOSPC) makes the failure diagnosable without a
      // leak. Token bytes never reach the log.
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
      // The host copy-back above already finished and set `hostOutcome`. This
      // diagnostic log is the last step, so a rejecting logger must not throw
      // and turn that successful result into a failed copy-back. Guard the log:
      // a rejection here is swallowed, and the function still returns
      // `hostOutcome` below.
      await Promise.resolve(
        log(
          `[paperclip] Codex auth cache: additive cache write failed (${code}); host copy-back result kept.`,
        ),
      ).catch(() => undefined);
    }
  }

  return hostOutcome;
}
