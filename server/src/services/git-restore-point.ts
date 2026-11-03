import { execFile as execFileCallback, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { REGENERABLE_WORKSPACE_DIR_NAMES } from "./workspace-compaction.js";

const execFile = promisify(execFileCallback);

export const RESTORE_POINT_PAYLOAD_SCHEMA = "paperclip.git-restore-point-payload.v1";
export const RESTORE_POINT_PAYLOAD_SCHEMA_V2 = "paperclip.git-restore-point-payload.v2";
const PAYLOAD_MAGIC = Buffer.from("PCRP-PLAIN1\n");
const SEALED_MAGIC = Buffer.from("PCRP1");
const KEY_SCHEMA = "paperclip.git-restore-point-key.v1";
const SHA = /^[0-9a-f]{40}$/;
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Paperclip",
  GIT_AUTHOR_EMAIL: "restore-point@paperclip.invalid",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Paperclip",
  GIT_COMMITTER_EMAIL: "restore-point@paperclip.invalid",
  GIT_COMMITTER_DATE: "@0 +0000",
};
const EXCLUDED_UNTRACKED = [":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"];
const MAX_PRESERVED_COMMITS = 50;

export type RestorePointLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCommits: number;
  maxBundleBytes: number;
};

export const DEFAULT_RESTORE_POINT_LIMITS: RestorePointLimits = {
  maxFiles: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCommits: 1_000,
  maxBundleBytes: 256 * 1024 * 1024,
};

export type RestorePointManifest = {
  schema: typeof RESTORE_POINT_PAYLOAD_SCHEMA | typeof RESTORE_POINT_PAYLOAD_SCHEMA_V2;
  head: string;
  index: string | null;
  worktree: string | null;
  ignored?: string;
  preserved: string[];
  prerequisites: string[];
  modes: Array<{ path: string; mode: number }>;
};

export type RestorePointSnapshot = { head: string; index: string | null; worktree: string | null; ignored: string | null;
  modes: Array<{ path: string; mode: number }> };

export function restorePointSavesIgnoredFile(file: string) {
  const parts = file.split("/").filter(Boolean);
  if (parts.length === 0 || /^\.env(\..*)?$/.test(parts[parts.length - 1]!)) return false;
  if (parts[0] === ".paperclip-repositories" || file === ".claude/settings.local.json") return false;
  return !parts.slice(0, -1).some(part => REGENERABLE_WORKSPACE_DIR_NAMES.has(part));
}

async function savedIgnoredFiles(cwd: string, signal?: AbortSignal) {
  return nulList(await git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { signal }))
    .filter(restorePointSavesIgnoredFile).sort();
}

export type RestorePointIdentity = { companyId: string; workspaceId: string; restorePointId: string; generation: number };

export type SealedRestorePoint = {
  ciphertext: Buffer;
  sha256: string;
  key: StoredSecretVersionMaterial;
};

export class RestorePointSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RestorePointSkip";
  }
}

export class RestorePointRestoreFailure extends Error {
  constructor(readonly reason: string) {
    super(`The workspace restore point could not be applied: ${reason}`);
    this.name = "RestorePointRestoreFailure";
  }
}

type GitOptions = { env?: Record<string, string>; input?: Buffer | string; signal?: AbortSignal; maxBuffer?: number };

function isolatedEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  const child = execFile("git", gitArgs(cwd, args), {
    env: isolatedEnv(options.env),
    encoding: "buffer",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: 120_000,
    signal: options.signal,
  });
  if (options.input !== undefined) child.child.stdin?.end(options.input);
  const { stdout } = await child;
  return stdout as Buffer;
}

function gitArgs(cwd: string, args: string[]) {
  return ["-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args];
}

async function gitPipe(cwd: string, from: string[], to: string[], signal?: AbortSignal) {
  const options = { env: isolatedEnv(), signal, timeout: 15 * 60_000 };
  const source = spawn("git", gitArgs(cwd, from), { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const sink = spawn("git", gitArgs(cwd, to), { ...options, stdio: ["pipe", "ignore", "pipe"] });
  source.stdout.pipe(sink.stdin);
  sink.stdin.on("error", () => {});
  const finished = (child: ReturnType<typeof spawn>) => new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`git exited with ${code}`), { code, stderr })));
  });
  const done = [finished(source), finished(sink)];
  try { await Promise.all(done); }
  catch (error) {
    source.kill("SIGKILL");
    sink.kill("SIGKILL");
    await Promise.allSettled(done);
    throw error;
  }
}

async function gitText(cwd: string, args: string[], options: GitOptions = {}) {
  return (await git(cwd, args, options)).toString("utf8").trim();
}

function nulList(output: Buffer) {
  return output.toString("utf8").split("\0").filter(Boolean);
}

async function objectsDirectory(cwd: string) {
  const common = await gitText(cwd, ["rev-parse", "--git-common-dir"]);
  return path.resolve(cwd, common, "objects");
}

async function snapshotStore(cwd: string, temporary: string) {
  const store = path.join(temporary, "store.git");
  await execFile("git", ["init", "-q", "--bare", store], { env: isolatedEnv() });
  const repositoryObjects = await objectsDirectory(cwd);
  await fs.writeFile(path.join(store, "objects", "info", "alternates"), `${repositoryObjects}\n`);
  return {
    store,
    env: {
      GIT_OBJECT_DIRECTORY: path.join(store, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
      ...SNAPSHOT_IDENTITY,
    },
  };
}

async function copyIndex(cwd: string, target: string) {
  const indexPath = path.resolve(cwd, await gitText(cwd, ["rev-parse", "--git-path", "index"]));
  await fs.copyFile(indexPath, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function scanChangedPaths(cwd: string, limits: RestorePointLimits, signal?: AbortSignal) {
  const changed = new Set([
    ...nulList(await git(cwd, ["ls-files", "-z", "--modified"], { signal })),
    ...nulList(await git(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"], { signal })),
    ...nulList(await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...EXCLUDED_UNTRACKED], { signal })),
    ...await savedIgnoredFiles(cwd, signal),
  ]);
  if (changed.size > limits.maxFiles) throw new RestorePointSkip("restore_point_too_large");
  let totalBytes = 0;
  const modes: Array<{ path: string; mode: number }> = [];
  for (const relative of changed) {
    if (relative.endsWith("/")) throw new RestorePointSkip("untracked_nested_repository");
    const stat = await fs.lstat(path.join(cwd, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isDirectory()) throw new RestorePointSkip("untracked_nested_repository");
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new RestorePointSkip("unsupported_special_file");
    if (stat.isFile()) {
      if (stat.size > limits.maxFileBytes) throw new RestorePointSkip("restore_point_too_large");
      totalBytes += stat.size;
      const mode = stat.mode & 0o777;
      if (mode !== 0o644 && mode !== 0o755) modes.push({ path: relative, mode });
    }
    if (totalBytes > limits.maxTotalBytes) throw new RestorePointSkip("restore_point_too_large");
  }
  if (changed.size > 0) {
    const attributes = nulList(await git(cwd, ["check-attr", "-z", "--stdin", "filter"], { input: [...changed].join("\0"), signal }));
    for (let index = 2; index < attributes.length; index += 3) {
      if (attributes[index] !== "unspecified" && attributes[index] !== "unset") throw new RestorePointSkip("filtered_paths");
    }
  }
  return { modes: modes.sort((a, b) => a.path.localeCompare(b.path)) };
}

function quoteGitPath(file: string) {
  let quoted = "\"";
  for (const byte of Buffer.from(file, "utf8")) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}

async function rawIgnoredTree(cwd: string, env: Record<string, string>, temporary: string, files: string[], signal?: AbortSignal) {
  if (files.length === 0) return null;
  const entries: string[] = [];
  const regular: string[] = [];
  for (const file of files) {
    if (file.endsWith("/")) throw new RestorePointSkip("untracked_nested_repository");
    if (/[\n\r]/.test(file)) throw new RestorePointSkip("unsupported_path");
    const stat = await fs.lstat(path.join(cwd, file));
    if (stat.isSymbolicLink()) {
      const blob = await gitText(cwd, ["hash-object", "-w", "--no-filters", "--stdin"], { env, signal,
        input: await fs.readlink(path.join(cwd, file), { encoding: "buffer" }) });
      entries.push(`120000 ${blob}\t${file}`);
    } else if (stat.isFile()) regular.push(file);
    else if (stat.isDirectory()) throw new RestorePointSkip("untracked_nested_repository");
    else throw new RestorePointSkip("unsupported_special_file");
  }
  if (regular.length > 0) {
    const blobs = (await gitText(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { env, signal,
      input: regular.map(quoteGitPath).join("\n") + "\n" })).split("\n");
    if (blobs.length !== regular.length || blobs.some(blob => !SHA.test(blob))) throw new RestorePointSkip("unsupported_path");
    for (const [index, file] of regular.entries()) {
      const mode = (await fs.lstat(path.join(cwd, file))).mode & 0o111 ? "100755" : "100644";
      entries.push(`${mode} ${blobs[index]}\t${file}`);
    }
  }
  const ignoredEnv = { ...env, GIT_INDEX_FILE: path.join(temporary, "ignored-index") };
  await git(cwd, ["update-index", "-z", "--index-info"], { env: ignoredEnv, signal, input: entries.join("\0") + "\0" });
  return await gitText(cwd, ["write-tree"], { env: ignoredEnv, signal });
}

async function writeIgnoredFiles(cwd: string, commit: string, signal?: AbortSignal) {
  const listing = nulList(await git(cwd, ["ls-tree", "-r", "-z", "--long", `${commit}^{tree}`], { signal }));
  const entries = listing.map((line) => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s.exec(line);
    if (!match) throw new RestorePointRestoreFailure("invalid_payload");
    const target = path.join(cwd, match[4]!);
    if (path.isAbsolute(match[4]!) || match[4]!.split("/").includes("..") || !target.startsWith(`${cwd}${path.sep}`)) {
      throw new RestorePointRestoreFailure("invalid_payload");
    }
    return { mode: match[1]!, blob: match[2]!, size: Number(match[3]), target };
  });
  for (const entry of entries) {
    if (await fs.lstat(entry.target).then(() => true, () => false)) throw new RestorePointRestoreFailure("ignored_files_conflict");
  }
  const contents = await git(cwd, ["cat-file", "--batch"], { signal, input: entries.map((entry) => entry.blob).join("\n") + "\n",
    maxBuffer: entries.reduce((total, entry) => total + entry.size + 128, 4096) });
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = contents.subarray(offset, contents.indexOf(0x0a, offset)).toString("utf8");
    const [sha, type, size] = header.split(" ");
    if (sha !== entry.blob || type !== "blob" || !/^\d+$/.test(size ?? "")) throw new RestorePointRestoreFailure("invalid_payload");
    const start = offset + header.length + 1;
    blobs.push(contents.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  const written: string[] = [];
  try {
    for (const [index, entry] of entries.entries()) {
      await fs.mkdir(path.dirname(entry.target), { recursive: true });
      const parent = await fs.realpath(path.dirname(entry.target));
      if (parent !== cwd && !parent.startsWith(`${cwd}${path.sep}`)) throw new RestorePointRestoreFailure("invalid_payload");
      if (entry.mode === "120000") await fs.symlink(blobs[index]!, entry.target);
      else await fs.writeFile(entry.target, blobs[index]!, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
      written.push(entry.target);
    }
  } catch (error) {
    for (const target of written.reverse()) await fs.rm(target, { force: true });
    throw error instanceof RestorePointRestoreFailure ? error : new RestorePointRestoreFailure("ignored_files_conflict");
  }
}

async function snapshotTrees(cwd: string, env: Record<string, string>, temporary: string, signal?: AbortSignal) {
  const indexCopy = path.join(temporary, "index");
  await copyIndex(cwd, indexCopy);
  const indexTree = await gitText(cwd, ["write-tree"], { env: { ...env, GIT_INDEX_FILE: indexCopy }, signal })
    .catch(() => { throw new RestorePointSkip("unmerged_index"); });
  const worktreeIndex = path.join(temporary, "worktree-index");
  const worktreeEnv = { ...env, GIT_INDEX_FILE: worktreeIndex };
  await git(cwd, ["read-tree", "HEAD"], { env: worktreeEnv, signal });
  await git(cwd, ["add", "-u", "--", "."], { env: worktreeEnv, signal });
  await git(cwd, ["add", "-A", "--", ".", ...EXCLUDED_UNTRACKED], { env: worktreeEnv, signal });
  const worktreeTree = await gitText(cwd, ["write-tree"], { env: worktreeEnv, signal });
  const gitlinks = await gitText(cwd, ["ls-tree", "-r", worktreeTree], { env, signal });
  if (/^160000 /m.test(gitlinks)) throw new RestorePointSkip("submodules_unsupported");
  const ignoredTree = await rawIgnoredTree(cwd, env, temporary, await savedIgnoredFiles(cwd, signal), signal);
  return { indexTree, worktreeTree, ignoredTree };
}

async function snapshotCommits(cwd: string, env: Record<string, string>, temporary: string, modes: RestorePointSnapshot["modes"], signal?: AbortSignal): Promise<RestorePointSnapshot> {
  const head = await gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], { signal });
  const headTree = await gitText(cwd, ["rev-parse", "HEAD^{tree}"], { signal });
  const { indexTree, worktreeTree, ignoredTree } = await snapshotTrees(cwd, env, temporary, signal);
  const ignored = ignoredTree
    ? await gitText(cwd, ["commit-tree", ignoredTree, "-p", head, "-m", "paperclip restore point ignored files"], { env, signal }) : null;
  if (indexTree === headTree && worktreeTree === headTree) return { head, index: null, worktree: null, ignored, modes: ignored ? modes : [] };
  const index = await gitText(cwd, ["commit-tree", indexTree, "-p", head, "-m", "paperclip restore point index"], { env, signal });
  const worktree = await gitText(cwd, ["commit-tree", worktreeTree, "-p", head, "-p", index, "-m", "paperclip restore point worktree"], { env, signal });
  return { head, index, worktree, ignored, modes };
}

const UNBOUNDED_LIMITS: RestorePointLimits = {
  maxFiles: Number.POSITIVE_INFINITY,
  maxFileBytes: Number.POSITIVE_INFINITY,
  maxTotalBytes: Number.POSITIVE_INFINITY,
  maxCommits: Number.POSITIVE_INFINITY,
  maxBundleBytes: Number.POSITIVE_INFINITY,
};

export async function currentRestorePointSnapshot(input: string, signal?: AbortSignal): Promise<RestorePointSnapshot> {
  const cwd = await fs.realpath(input);
  const { modes } = await scanChangedPaths(cwd, UNBOUNDED_LIMITS, signal);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restore-point-"));
  try {
    const { env } = await snapshotStore(cwd, temporary);
    return await snapshotCommits(cwd, env, temporary, modes, signal);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function existingCommits(cwd: string, commits: readonly string[], signal?: AbortSignal) {
  const present: string[] = [];
  for (const commit of commits) {
    if (!SHA.test(commit)) continue;
    if (await git(cwd, ["cat-file", "-e", `${commit}^{commit}`], { signal }).then(() => true, () => false)) present.push(commit);
  }
  return present;
}

async function presentCommits(cwd: string, commits: readonly string[], signal?: AbortSignal) {
  const unique = [...new Set(commits.filter((commit) => SHA.test(commit)))];
  if (unique.length === 0) return [];
  const output = await gitText(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { signal, input: unique.join("\n") + "\n" });
  return output.split("\n").map((line) => line.split(" ")).filter(([sha, type]) => SHA.test(sha ?? "") && type === "commit").map(([sha]) => sha!);
}

async function unpreservedHistory(cwd: string, head: string, boundary: readonly string[], signal?: AbortSignal, extra: readonly string[] = []) {
  if (new Set(extra).size > MAX_PRESERVED_COMMITS) throw new RestorePointSkip("restore_point_history_too_large");
  const candidates = new Set<string>(await presentCommits(cwd, extra, signal));
  const reflog = await gitText(cwd, ["reflog", "show", "--format=%H", "HEAD"], { signal }).catch(() => "");
  for (const line of reflog.split("\n")) if (SHA.test(line)) candidates.add(line);
  const original = await gitText(cwd, ["rev-parse", "--verify", "-q", "ORIG_HEAD^{commit}"], { signal }).catch(() => "");
  if (SHA.test(original)) candidates.add(original);
  candidates.delete(head);
  if (candidates.size === 0) return [];
  const unreachable = new Set((await gitText(cwd, ["rev-list", "--stdin"], {
    signal, input: [...candidates, `^${head}`, ...boundary.map((commit) => `^${commit}`)].join("\n") + "\n",
  })).split("\n").filter((line) => SHA.test(line)));
  const preserved = [...candidates].filter((commit) => unreachable.has(commit));
  if (preserved.length > MAX_PRESERVED_COMMITS) throw new RestorePointSkip("restore_point_history_too_large");
  return preserved.sort();
}

function bundlePrerequisites(bundle: Buffer) {
  const headerEnd = bundle.indexOf("\n\n");
  if (headerEnd < 0) throw new RestorePointSkip("invalid_bundle");
  return bundle.subarray(0, headerEnd).toString("utf8").split("\n").slice(1)
    .filter((line) => line.startsWith("-")).map((line) => line.slice(1, 41)).filter((sha) => SHA.test(sha)).sort();
}

function encodePayload(manifest: RestorePointManifest, bundle: Buffer) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length);
  return Buffer.concat([PAYLOAD_MAGIC, length, manifestBytes, bundle]);
}

export function decodeRestorePointPayload(payload: Buffer): { manifest: RestorePointManifest; bundle: Buffer } {
  if (payload.length < PAYLOAD_MAGIC.length + 4 || !payload.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) {
    throw new RestorePointRestoreFailure("invalid_payload");
  }
  const length = payload.readUInt32BE(PAYLOAD_MAGIC.length);
  const start = PAYLOAD_MAGIC.length + 4;
  if (start + length > payload.length) throw new RestorePointRestoreFailure("invalid_payload");
  const manifest = JSON.parse(payload.subarray(start, start + length).toString("utf8")) as RestorePointManifest;
  const shas = [manifest.head, ...(manifest.index ? [manifest.index] : []), ...(manifest.worktree ? [manifest.worktree] : []),
    ...(manifest.ignored !== undefined ? [manifest.ignored] : []), ...manifest.preserved, ...manifest.prerequisites];
  const schemaValid = manifest.schema === RESTORE_POINT_PAYLOAD_SCHEMA ? manifest.ignored === undefined
    : manifest.schema === RESTORE_POINT_PAYLOAD_SCHEMA_V2 && typeof manifest.ignored === "string";
  if (!schemaValid || shas.some((sha) => typeof sha !== "string" || !SHA.test(sha))
    || (manifest.index === null) !== (manifest.worktree === null)
    || manifest.modes.some((entry) => typeof entry.path !== "string" || path.isAbsolute(entry.path)
      || entry.path.split("/").includes("..") || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) {
    throw new RestorePointRestoreFailure("invalid_payload");
  }
  return { manifest, bundle: payload.subarray(start + length) };
}

export async function captureRestorePoint(input: {
  cwd: string;
  upstreamCommits: readonly string[];
  preserveCommits?: readonly string[];
  limits?: Partial<RestorePointLimits>;
  signal?: AbortSignal;
}): Promise<{ payload: Buffer; manifest: RestorePointManifest } | null> {
  const limits = { ...DEFAULT_RESTORE_POINT_LIMITS, ...input.limits };
  const cwd = await fs.realpath(input.cwd);
  const { modes } = await scanChangedPaths(cwd, limits, input.signal);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restore-point-"));
  try {
    const { store, env } = await snapshotStore(cwd, temporary);
    const snapshot = await snapshotCommits(cwd, env, temporary, modes, input.signal);
    const boundary = await existingCommits(cwd, input.upstreamCommits, input.signal);
    const preserved = await unpreservedHistory(cwd, snapshot.head, boundary, input.signal, input.preserveCommits);
    const headOnUpstream = await (async () => {
      for (const tip of boundary) {
        if (await git(cwd, ["merge-base", "--is-ancestor", snapshot.head, tip], { signal: input.signal }).then(() => true, () => false)) return true;
      }
      return false;
    })();
    if (headOnUpstream && snapshot.worktree === null && snapshot.ignored === null && preserved.length === 0) return null;
    const refs: Array<[string, string]> = [["refs/restore/head", snapshot.head]];
    if (snapshot.index && snapshot.worktree) refs.push(["refs/restore/index", snapshot.index], ["refs/restore/worktree", snapshot.worktree]);
    if (snapshot.ignored) refs.push(["refs/restore/ignored", snapshot.ignored]);
    preserved.forEach((commit, index) => refs.push([`refs/restore/preserved/${index}`, commit]));
    for (const [ref, commit] of refs) await git(store, ["update-ref", ref, commit], { env, signal: input.signal });
    const exclusions = boundary.map((commit) => `^${commit}`);
    const commitCount = Number(await gitText(store, ["rev-list", "--count", ...refs.map(([ref]) => ref), ...exclusions], { env, signal: input.signal }));
    if (commitCount > limits.maxCommits) throw new RestorePointSkip("restore_point_too_large");
    if (commitCount === 0) return null;
    const bundlePath = path.join(temporary, "restore.bundle");
    await git(store, ["bundle", "create", "-q", bundlePath, "--stdin"], {
      env, signal: input.signal, input: [...refs.map(([ref]) => ref), ...exclusions].join("\n") + "\n",
    });
    const bundle = await fs.readFile(bundlePath);
    if (bundle.length > limits.maxBundleBytes) throw new RestorePointSkip("restore_point_too_large");
    const prerequisites = bundlePrerequisites(bundle);
    const manifest: RestorePointManifest = {
      schema: snapshot.ignored ? RESTORE_POINT_PAYLOAD_SCHEMA_V2 : RESTORE_POINT_PAYLOAD_SCHEMA,
      head: snapshot.head,
      index: snapshot.index,
      worktree: snapshot.worktree,
      ...(snapshot.ignored ? { ignored: snapshot.ignored } : {}),
      preserved,
      prerequisites,
      modes: snapshot.modes,
    };
    return { payload: encodePayload(manifest, bundle), manifest };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function importRestorePoint(input: { repositoryCwd: string; payload: Buffer; signal?: AbortSignal }) {
  const { manifest, bundle } = decodeRestorePointPayload(input.payload);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restore-point-"));
  try {
    const bundlePath = path.join(temporary, "restore.bundle");
    await fs.writeFile(bundlePath, bundle, { mode: 0o600 });
    await git(input.repositoryCwd, ["bundle", "verify", "-q", bundlePath], { signal: input.signal })
      .catch(() => { throw new RestorePointRestoreFailure("bundle_prerequisites_missing"); });
    const heads = (await gitText(input.repositoryCwd, ["bundle", "list-heads", bundlePath], { signal: input.signal }))
      .split("\n").filter(Boolean).map((line) => line.split(" "));
    const expected = new Map<string, string>([["refs/restore/head", manifest.head]]);
    if (manifest.index && manifest.worktree) {
      expected.set("refs/restore/index", manifest.index);
      expected.set("refs/restore/worktree", manifest.worktree);
    }
    if (manifest.ignored) expected.set("refs/restore/ignored", manifest.ignored);
    manifest.preserved.forEach((commit, index) => expected.set(`refs/restore/preserved/${index}`, commit));
    if (heads.some(([sha, ref]) => expected.get(ref ?? "") !== sha)) throw new RestorePointRestoreFailure("bundle_manifest_mismatch");
    const listed = new Set(heads.map(([, ref]) => ref));
    for (const [ref, commit] of expected) {
      if (listed.has(ref)) continue;
      const present = await git(input.repositoryCwd, ["cat-file", "-e", `${commit}^{commit}`], { signal: input.signal }).then(() => true, () => false);
      if (!present) throw new RestorePointRestoreFailure("bundle_manifest_mismatch");
    }
    if (listed.size > 0) {
      await git(input.repositoryCwd, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", bundlePath,
        ...[...listed].map((ref) => `${ref}:refs/paperclip-restore-import/${ref!.slice("refs/restore/".length)}`)], { signal: input.signal });
    }
    await git(input.repositoryCwd, ["for-each-ref", "--format=delete %(refname)", "refs/paperclip-restore-import/"], { signal: input.signal })
      .then((output) => git(input.repositoryCwd, ["update-ref", "--stdin"], { input: output, signal: input.signal }));
    return manifest;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function applyRestorePoint(input: { cwd: string; manifest: RestorePointManifest; signal?: AbortSignal }) {
  const { manifest } = input;
  const cwd = await fs.realpath(input.cwd);
  const head = await gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], { signal: input.signal });
  if (head !== manifest.head) throw new RestorePointRestoreFailure("head_mismatch");
  if (manifest.index && manifest.worktree) {
    const changed = await git(cwd, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", manifest.worktree], { signal: input.signal }).then(() => false, (error: { code?: unknown }) => {
      if (error.code === 1) return true;
      throw error;
    });
    if (changed) await gitPipe(cwd, ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", manifest.worktree],
      ["apply", "--binary", "--whitespace=nowarn", "-"], input.signal);
    await git(cwd, ["read-tree", `${manifest.index}^{tree}`], { signal: input.signal });
  }
  if (manifest.ignored) await writeIgnoredFiles(cwd, manifest.ignored, input.signal);
  for (const entry of manifest.modes) {
    const target = path.join(cwd, entry.path);
    if (path.relative(cwd, target).startsWith("..")) throw new RestorePointRestoreFailure("invalid_payload");
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isFile()) await fs.chmod(target, entry.mode);
  }
  const restored = await currentRestorePointSnapshot(cwd, input.signal);
  if (restored.head !== manifest.head || restored.index !== manifest.index || restored.worktree !== manifest.worktree
    || restored.ignored !== (manifest.ignored ?? null) || JSON.stringify(restored.modes) !== JSON.stringify(manifest.modes)) {
    throw new RestorePointRestoreFailure("restored_contents_mismatch");
  }
}

function additionalData(identity: RestorePointIdentity) {
  return Buffer.from(JSON.stringify([identity.companyId, identity.workspaceId, identity.restorePointId, identity.generation]));
}

export async function sealRestorePoint(payload: Buffer, identity: RestorePointIdentity): Promise<SealedRestorePoint> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(additionalData(identity));
  const ciphertext = Buffer.concat([SEALED_MAGIC, iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const { material } = await localEncryptedProvider.createVersion({
    value: JSON.stringify({
      schema: KEY_SCHEMA,
      ...identity,
      dataKey: dataKey.toString("base64"),
      plaintextSha256: createHash("sha256").update(payload).digest("hex"),
      plaintextBytes: payload.length,
    }),
  } as Parameters<typeof localEncryptedProvider.createVersion>[0]);
  return { ciphertext, sha256: createHash("sha256").update(ciphertext).digest("hex"), key: material };
}

export async function openRestorePoint(input: {
  ciphertext: Buffer;
  sha256: string;
  key: StoredSecretVersionMaterial;
  identity: RestorePointIdentity;
}): Promise<Buffer> {
  if (createHash("sha256").update(input.ciphertext).digest("hex") !== input.sha256) {
    throw new RestorePointRestoreFailure("ciphertext_hash_mismatch");
  }
  const minimum = SEALED_MAGIC.length + 12 + 16;
  if (input.ciphertext.length < minimum || !input.ciphertext.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) {
    throw new RestorePointRestoreFailure("invalid_ciphertext");
  }
  const unwrapped = JSON.parse(await localEncryptedProvider.resolveVersion({ material: input.key, externalRef: null } as Parameters<typeof localEncryptedProvider.resolveVersion>[0]));
  const { identity } = input;
  if (unwrapped.schema !== KEY_SCHEMA || unwrapped.companyId !== identity.companyId || unwrapped.workspaceId !== identity.workspaceId
    || unwrapped.restorePointId !== identity.restorePointId || unwrapped.generation !== identity.generation) {
    throw new RestorePointRestoreFailure("key_identity_mismatch");
  }
  const iv = input.ciphertext.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + 12);
  const tag = input.ciphertext.subarray(input.ciphertext.length - 16);
  const body = input.ciphertext.subarray(SEALED_MAGIC.length + 12, input.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(unwrapped.dataKey, "base64"), iv);
  decipher.setAAD(additionalData(identity));
  decipher.setAuthTag(tag);
  let payload: Buffer;
  try {
    payload = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new RestorePointRestoreFailure("ciphertext_authentication_failed");
  }
  if (payload.length !== unwrapped.plaintextBytes || createHash("sha256").update(payload).digest("hex") !== unwrapped.plaintextSha256) {
    throw new RestorePointRestoreFailure("plaintext_hash_mismatch");
  }
  return payload;
}

export async function restorePointHistoryDigest(input: string, signal?: AbortSignal): Promise<string> {
  const cwd = await fs.realpath(input);
  const reflog = await gitText(cwd, ["reflog", "show", "--format=%H", "HEAD"], { signal }).catch(() => "");
  const original = await gitText(cwd, ["rev-parse", "--verify", "-q", "ORIG_HEAD^{commit}"], { signal }).catch(() => "");
  const linked = (await fs.lstat(path.join(cwd, ".git")).catch(() => null))?.isFile() ?? false;
  const nested = linked ? await import("./nested-repository-worktrees.js") : null;
  const scope = nested ? `refs/heads/${await nested.nestedWorktreeBranchPrefix(cwd)}` : "refs/remotes";
  const remotes = await gitText(cwd, ["for-each-ref", ...nested ? [`--count=${nested.OWNED_NESTED_REF_LIMIT + 1}`] : [],
    "--format=%(objectname) %(refname)", scope], { signal }).catch(() => "");
  const remoteReflogs: string[] = [];
  if (nested) {
    if (remotes.split("\n").filter(Boolean).length > nested.OWNED_NESTED_REF_LIMIT) throw new Error("managed_checkout_local_tip_budget");
    for (const ref of remotes.split("\n").map((line) => line.split(" ")[1]).filter(Boolean)) {
      remoteReflogs.push(...(await gitText(cwd, ["reflog", "show", "--format=%H", ref!], { signal }).catch(() => "")).split("\n").filter((line) => SHA.test(line)).map((sha) => `${sha} ${ref}`));
    }
  } else {
    remoteReflogs.push(...(await gitText(cwd, ["reflog", "show", "--all", "--format=%H %gD"], { signal }).catch(() => ""))
      .split("\n").filter((line) => / refs\/remotes\//.test(line)));
  }
  return createHash("sha256").update(JSON.stringify([reflog.split("\n").filter((line) => SHA.test(line)), SHA.test(original) ? original : null,
    remotes.split("\n").filter(Boolean), remoteReflogs])).digest("hex");
}
