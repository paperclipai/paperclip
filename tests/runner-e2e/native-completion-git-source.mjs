import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

const hydrationDirectory = "runner-e2e-build";
const archiveName = "runner-e2e-build-bundle.tar.gz";
const checksumName = `${archiveName}.sha256`;
const hydrationPaths = [archiveName, checksumName].map(file => `${hydrationDirectory}/${file}`);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** A shallow commit still carries its hash-bound immediate parent in raw bytes. */
export function verifyNativeCompletionParentAnchor({ sha, rawCommit, anchor }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[a-f0-9]{40}$/.test(anchor ?? "")) return false;
  const bytes = Buffer.isBuffer(rawCommit) ? rawCommit : Buffer.from(rawCommit ?? "");
  const observed = createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex");
  const parents = bytes.toString("utf8").split("\n\n", 1)[0].split("\n").filter(line => line.startsWith("parent "));
  return observed === sha && parents.length === 1 && parents[0] === `parent ${anchor}`;
}
function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("entry is not a regular, independently downloaded file");
  return stat;
}
function archiveDigest(path) {
  const before = regularFile(path), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("archive changed during verification");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("archive changed during verification");
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
export function inspectNativeCompletionBuildHydration(repositoryRoot) {
  const directory = join(repositoryRoot, hydrationDirectory), errors = [];
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) {
    if (error.code === "ENOENT") return { present: false, verified: false, archiveSha256: null, checksumSha256: null, errors };
    return { present: true, verified: false, archiveSha256: null, checksumSha256: null, errors: ["build hydration directory is unreadable"] };
  }
  let archiveSha256 = null, checksumSha256 = null;
  try {
    if (!stat.isDirectory()) throw new Error("directory must be a real directory, not a symlink or file");
    const entries = readdirSync(directory).sort();
    if (JSON.stringify(entries) !== JSON.stringify([archiveName, checksumName].sort()))
      throw new Error("directory must contain exactly the archive and its checksum, with no extra entries");
    const checksumPath = join(directory, checksumName), checksumStat = regularFile(checksumPath);
    if (checksumStat.size > 128) throw new Error("checksum record is malformed");
    const checksum = readFileSync(checksumPath), match = /^([a-f0-9]{64}) {2}runner-e2e-build-bundle\.tar\.gz\n?$/.exec(checksum.toString("utf8"));
    if (!match) throw new Error("checksum must be one exact SHA256 record for the downloaded archive");
    checksumSha256 = sha256(checksum); archiveSha256 = archiveDigest(join(directory, archiveName));
    if (archiveSha256 !== match[1]) throw new Error("archive checksum verification failed");
  } catch (error) { errors.push(`build hydration ${error.message}`); }
  return { present: true, verified: errors.length === 0, archiveSha256, checksumSha256, errors };
}

export const NATIVE_COMPLETION_RUNNERD_PATH = "packages/paperclip-runner/runner/target/debug/paperclip-runnerd";
/** Mirror the production default selector, and reject staged binaries that would take precedence. */
export function inspectNativeCompletionRunnerd({ repositoryRoot, sourceSha, sourceFingerprint, environment }) {
  const errors = [], hosted = environment.GITHUB_ACTIONS === "true";
  const selectedPath = `${NATIVE_COMPLETION_RUNNERD_PATH}${process.platform === "win32" ? ".exe" : ""}`;
  const staged = join(repositoryRoot, `packages/paperclip-runner/dist/bin/paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`);
  let binarySha256 = null, binaryBytes = null, archiveSha256 = null, archiveMemberBytes = null;
  try {
    try { lstatSync(staged); throw new Error("staged dist/bin runnerd would override the admitted debug executable"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let directory = repositoryRoot;
    for (const part of selectedPath.split("/").slice(0, -1)) {
      directory = join(directory, part);
      if (!lstatSync(directory).isDirectory()) throw new Error("selected runnerd ancestor must be a real directory");
    }
    const binary = join(repositoryRoot, selectedPath), stat = regularFile(binary);
    if (process.platform !== "win32" && !(stat.mode & 0o111)) throw new Error("selected runnerd is not executable");
    binaryBytes = stat.size;
    binarySha256 = archiveDigest(binary);
    if (hosted) {
      if (environment.PAPERCLIP_RUNNER_E2E_SOURCE_SHA !== sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha ?? ""))
        throw new Error("trusted hosted target SHA does not match admitted Git HEAD");
      if (![environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT].every(value => typeof value === "string" && value === value.trim() && /^[1-9]\d*$/.test(value)))
        throw new Error("trusted hosted workflow run and attempt are unavailable");
      const hydration = inspectNativeCompletionBuildHydration(repositoryRoot);
      if (!hydration.verified) throw new Error(`hosted build archive is unverified: ${hydration.errors.join("; ")}`);
      archiveSha256 = hydration.archiveSha256;
      const archive = join(repositoryRoot, hydrationDirectory, archiveName);
      const tar = args => spawnSync("tar", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      const names = tar(["-tzf", archive]);
      if (names.status !== 0) throw new Error("hosted build archive cannot be listed");
      const matching = names.stdout.split(/\r?\n/).filter(name => name && posix.normalize(name.replace(/^\/+/, "")) === selectedPath);
      if (matching.length !== 1 || matching[0] !== selectedPath)
        throw new Error("hosted archive must contain exactly one canonical selected runnerd member");
      const details = tar(["-tvzf", archive, selectedPath]);
      const rows = details.stdout.trim().split(/\r?\n/);
      if (details.status !== 0 || rows.length !== 1 || !rows[0].startsWith("-") || !rows[0].endsWith(` ${selectedPath}`))
        throw new Error("hosted selected runnerd member must be a regular file");
      // Keep daemon bytes out of JavaScript memory; the selected executable supplies the exact expected size.
      const temporary = mkdtempSync(join(tmpdir(), "native-completion-runnerd-member-")), member = join(temporary, "runnerd");
      let fd;
      try {
        fd = openSync(member, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        const extracted = spawnSync("tar", ["-xOzf", archive, selectedPath], { timeout: 120_000, stdio: ["ignore", fd, "pipe"] });
        archiveMemberBytes = fstatSync(fd).size;
        closeSync(fd); fd = undefined;
        if (extracted.status !== 0 || archiveMemberBytes !== binaryBytes || archiveDigest(member) !== binarySha256)
          throw new Error("selected runnerd byte count or hash differs from the verified hosted archive member");
      } finally {
        if (fd !== undefined) closeSync(fd);
        rmSync(temporary, { recursive: true, force: true });
      }
      if (archiveDigest(archive) !== archiveSha256) throw new Error("hosted build archive changed during runnerd verification");
    }
  } catch (error) { errors.push(`runnerd provenance ${error.message}`); }
  return { schema: "paperclip.native-completion-runnerd-provenance.v1", mode: hosted ? "trusted_hosted_archive" : "fresh_local_build",
    passed: errors.length === 0, selectedPath, binarySha256, binaryBytes, archiveMemberBytes, sourceSha, sourceFingerprint, archiveSha256,
    workflowRunId: hosted ? environment.GITHUB_RUN_ID ?? null : null,
    workflowRunAttempt: hosted ? environment.GITHUB_RUN_ATTEMPT ?? null : null,
    artifactName: hosted ? `runner-e2e-build-${sourceSha}-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}` : null,
    errors };
}

/** Preserve tracked-source cleanliness; allow only the verified workflow download. */
export function inspectNativeCompletionSourceMetadata({ repositoryRoot, sourceFiles, baseSha, variant, shallowParentAnchors }) {
  const git = (args, raw = false) => spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: repositoryRoot, encoding: raw ? undefined : "utf8", timeout: 30_000,
  });
  const head = git(["rev-parse", "--verify", "HEAD"]), sha = head.status === 0 ? head.stdout.trim() : null;
  const ancestor = git(["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  const shallow = git(["rev-parse", "--is-shallow-repository"]), isShallow = shallow.status === 0 && shallow.stdout.trim() === "true";
  const errors = [];
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) errors.push("Git HEAD is unavailable or is not an immutable SHA1 commit");
  let layering = ancestor.status === 0, strategy = layering ? "full_ancestry" : null;
  const anchor = shallowParentAnchors?.[variant] ?? null;
  if (!layering && isShallow && anchor && sha) {
    const commit = git(["cat-file", "commit", "HEAD"], true);
    layering = commit.status === 0 && verifyNativeCompletionParentAnchor({ sha, rawCommit: commit.stdout, anchor });
    if (layering) strategy = "shallow_immediate_parent_anchor";
  }
  if (!layering) errors.push(isShallow
    ? "shallow Git HEAD does not have the sole hash-verified immediate parent admitted for this source variant"
    : "full Git history does not prove the declared master base is an ancestor of HEAD");
  const tracked = git(["ls-files", "--error-unmatch", "--", ...sourceFiles]);
  const clean = git(["diff", "--quiet", "HEAD", "--"]);
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = status.status === 0 ? status.stdout.split("\0").filter(Boolean) : [];
  const unexpected = entries.filter(entry => entry.slice(0, 3) !== "?? " || !hydrationPaths.includes(entry.slice(3)));
  const hydration = inspectNativeCompletionBuildHydration(repositoryRoot);
  if (tracked.status !== 0) errors.push("one or more admitted source paths are not tracked at HEAD");
  if (clean.status !== 0) errors.push("tracked source differs from HEAD");
  if (status.status !== 0) errors.push("Git worktree status is unavailable");
  if (unexpected.length) errors.push(`unexpected worktree entries: ${unexpected.join(", ")}`);
  errors.push(...hydration.errors);
  const immutable = tracked.status === 0 && clean.status === 0 && status.status === 0 && unexpected.length === 0 &&
    (!hydration.present || hydration.verified);
  const metadata = { schema: "paperclip.native-completion-source-metadata.v1",
    lineage: { strategy, shallow: isShallow, sha, baseSha, anchor: strategy === "shallow_immediate_parent_anchor" ? anchor : null },
    hydration: { present: hydration.present, verified: hydration.verified, archiveSha256: hydration.archiveSha256, checksumSha256: hydration.checksumSha256 },
    worktreeEntries: entries, errors };
  return { sha, layering, immutable, sourceMetadata: metadata, sourceMetadataErrors: errors,
    sourceMetadataFingerprint: sha256(JSON.stringify(metadata)) };
}
