import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { captureDirectorySnapshot, directoryEntryMatchesBaseline, directorySnapshotSha256, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { GitWorkspaceSnapshot } from "@paperclipai/adapter-utils/git-workspace-sync";
import type { WorkspaceDurableSeedPaths } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { captureNativeHostWorkspaceReceipt, inspectNativeHostWorkspaceReceipt, inspectNativeHostWorkspaceRecoveryRoot,
  nativeHostWorkspaceReceiptSchema, type NativeHostWorkspaceReceipt } from "./native-host-workspace-receipt.js";

const exec = promisify(execFile);
const journalSchema = z.object({ version: z.literal(1), descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  created: nativeHostWorkspaceReceiptSchema }).strict();
type Binding = { receipt: NativeHostWorkspaceReceipt; descriptorSha256: string; journalPath: string };
const unavailable = () => new Error("native_host_workspace_restore_unverified");

async function readRecord(file: string) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw unavailable();
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw unavailable();
    return journalSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally { await handle.close(); }
}

async function readJournal(input: Binding) {
  const journal = await readRecord(input.journalPath);
  if (!journal) return null;
  if (journal.descriptorSha256 !== input.descriptorSha256) throw unavailable();
  await inspectNativeHostWorkspaceRecoveryRoot(input.receipt, journal.created);
  return journal;
}

/** Read-only preflight. A journal never authorizes replacing an existing root. */
export async function inspectNativeHostWorkspaceRestoration(input: Binding): Promise<"present" | "missing" | "recovering"> {
  if (await readJournal(input)) return "recovering";
  return inspectNativeHostWorkspaceReceipt(input.receipt, input.receipt.cwd);
}

async function writeJournal(input: Binding, created: NativeHostWorkspaceReceipt) {
  const temporary = input.journalPath + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, descriptorSha256: input.descriptorSha256, created }));
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.link(temporary, input.journalPath); }
  finally { await fs.unlink(temporary).catch(() => undefined); }
}

/** The allocation lock and controller claim fence this local staging area, too.
 * Remember its inode before writing any seed bytes so a hard crash does not
 * accumulate untracked copies of the workspace beside the host mirror. */
async function clearStaging(input: Binding) {
  const file = input.journalPath + ".staging";
  const record = await readRecord(file);
  if (!record) return;
  const stage = record.created;
  if (record.descriptorSha256 !== input.descriptorSha256 || stage.git.kind !== "absent"
    || path.dirname(stage.directory.path) !== input.receipt.parent.path
    || !path.basename(stage.directory.path).startsWith(".paperclip-mirror-")
    || stage.cwd !== stage.directory.path) throw unavailable();
  if (await inspectNativeHostWorkspaceReceipt(stage, stage.cwd) === "present") {
    await fs.rm(stage.directory.path, { recursive: true, force: true });
  }
  await fs.unlink(file);
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function extractSeed(source: string, expected: string, destination: string, scratch: string, label: string) {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
  const archive = path.join(scratch, label + ".tar");
  await fs.copyFile(source, archive, constants.COPYFILE_EXCL);
  // Hash the exact private copy that tar will read, not an earlier pathname.
  if (await hashFile(archive) !== expected) throw unavailable();
  await fs.mkdir(destination, { mode: 0o700 });
  // These are authenticated host-created seeds, never a remote .git archive.
  // Extract independently so overlay symlinks cannot redirect a later extract.
  // tar's default traversal protections remain enabled.
  await exec("tar", ["--no-same-owner", "-xpf", archive, "-C", destination], { timeout: 60_000, maxBuffer: 1024 * 1024 });
}

async function assertPlainTree(root: string, allowSymlinks: boolean) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) await assertPlainTree(file, allowSymlinks);
    else if (!stat.isFile() && !(allowSymlinks && stat.isSymbolicLink())) throw unavailable();
  }
}

async function stageSeed(input: Binding & { baseline: DirectorySnapshot; gitSnapshot: GitWorkspaceSnapshot | null; seed: WorkspaceDurableSeedPaths }, scratch: string) {
  const overlay = path.join(scratch, "overlay"), gitTree = path.join(scratch, "git"), stage = path.join(scratch, "ready");
  if (!input.seed.workspaceArchiveSha256 || Boolean(input.gitSnapshot) !== (input.receipt.git.kind !== "absent")) throw unavailable();
  await extractSeed(input.seed.workspaceArchivePath, input.seed.workspaceArchiveSha256, overlay, scratch, "workspace");
  if (input.gitSnapshot) {
    if (!input.seed.gitArchivePath || !input.seed.gitArchiveSha256) throw unavailable();
    await extractSeed(input.seed.gitArchivePath, input.seed.gitArchiveSha256, gitTree, scratch, "history");
  }
  await fs.mkdir(stage, { mode: 0o700 });
  // Select only attested baseline entries. Deleted paths, excluded data,
  // dependencies and runtime credentials cannot leak in from a seed archive.
  const entries = [...input.baseline.entries].sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const [relative, entry] of entries) {
    if (relative !== path.posix.normalize(relative) || relative.includes("\\") || relative.includes("\0")
      || relative === "." || relative.split("/").includes("..") || path.isAbsolute(relative)
      || relative === ".git" || relative.startsWith(".git/")) throw unavailable();
    const parent = path.posix.dirname(relative);
    if (parent !== "." && input.baseline.entries.get(parent)?.kind !== "dir") throw unavailable();
    const target = path.join(stage, relative);
    if (entry.kind === "dir") await fs.mkdir(target, { mode: 0o700 });
    else if (entry.kind === "symlink") await fs.symlink(entry.target, target);
    else {
      // An overlay symlink must never redirect a source read outside the seed.
      let selected: string | null = null;
      for (const root of [overlay, ...(input.gitSnapshot ? [gitTree] : [])]) {
        let safe = true;
        for (let current = parent; current !== "."; current = path.posix.dirname(current)) {
          const stat = await fs.lstat(path.join(root, current)).catch(() => null);
          if (!stat?.isDirectory() || stat.isSymbolicLink()) { safe = false; break; }
        }
        if (safe && await directoryEntryMatchesBaseline(root, relative, entry)) { selected = path.join(root, relative); break; }
      }
      if (!selected) throw unavailable();
      await fs.copyFile(selected, target, constants.COPYFILE_EXCL);
      await fs.chmod(target, entry.mode);
    }
  }
  if (directorySnapshotSha256(await captureDirectorySnapshot(stage, { exclude: input.baseline.exclude })) !== directorySnapshotSha256(input.baseline)) throw unavailable();
  if (input.receipt.git.kind === "external") {
    await fs.writeFile(path.join(stage, ".git"), input.receipt.git.pointer.content, { flag: "wx", mode: 0o600 });
  } else if (input.receipt.git.kind === "embedded") {
    const git = path.join(gitTree, ".git");
    const stat = await fs.lstat(git);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    await assertPlainTree(git, false);
    await fs.cp(git, path.join(stage, ".git"), { recursive: true, force: false, errorOnExist: true });
  }
  await assertPlainTree(stage, true);
  return stage;
}

/** Rebuild only a proven missing launch mirror. The caller fences the original
 * allocation/controller and publishes the receipt before run admission.
 * No command or source upload runs in the surviving sandbox. */
export async function restoreNativeHostWorkspace(input: Binding & {
  baseline: DirectorySnapshot; gitSnapshot: GitWorkspaceSnapshot | null; seed: WorkspaceDurableSeedPaths;
  assertAuthorized: () => Promise<void>;
}): Promise<NativeHostWorkspaceReceipt> {
  const state = await inspectNativeHostWorkspaceRestoration(input);
  if (state === "present") return input.receipt;
  await input.assertAuthorized();
  await clearStaging(input);
  // A sibling keeps publication hard links on the target filesystem. Files
  // appear complete with link(2); neither a crash nor EEXIST overwrites a file.
  const scratch = await fs.mkdtemp(path.join(input.receipt.parent.path, ".paperclip-mirror-"));
  const scratchReceipt = await captureNativeHostWorkspaceReceipt(scratch);
  let recorded = false;
  try {
    await writeJournal({ ...input, journalPath: input.journalPath + ".staging" }, scratchReceipt);
    recorded = true;
    const stage = await stageSeed(input, scratch);
    let journal = await readJournal(input);
    if (!journal) {
      if (await inspectNativeHostWorkspaceReceipt(input.receipt, input.receipt.cwd) !== "missing") throw unavailable();
      await input.assertAuthorized();
      await fs.mkdir(input.receipt.directory.path, { mode: 0o700 });
      const created = await captureNativeHostWorkspaceReceipt(input.receipt.cwd);
      await writeJournal(input, created);
      journal = await readJournal(input);
    }
    if (!journal) throw unavailable();
    await input.assertAuthorized();
    await inspectNativeHostWorkspaceRecoveryRoot(input.receipt, journal.created);
    await assertPlainTree(input.receipt.directory.path, true);
    const expected = await captureDirectorySnapshot(stage);
    const current = await captureDirectorySnapshot(input.receipt.directory.path);
    for (const [relative, entry] of current.entries) {
      if (JSON.stringify(entry) !== JSON.stringify(expected.entries.get(relative))) throw unavailable();
    }
    for (const [relative, entry] of [...expected.entries].sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
      await inspectNativeHostWorkspaceRecoveryRoot(input.receipt, journal.created);
      if (current.entries.has(relative)) continue;
      for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) {
        const stat = await fs.lstat(path.join(input.receipt.directory.path, parent));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      }
      const target = path.join(input.receipt.directory.path, relative);
      if (entry.kind === "dir") await fs.mkdir(target, { mode: 0o700 });
      else if (entry.kind === "symlink") await fs.symlink(entry.target, target);
      else await fs.link(path.join(stage, relative), target);
    }
    await input.assertAuthorized();
    await inspectNativeHostWorkspaceRecoveryRoot(input.receipt, journal.created);
    if (directorySnapshotSha256(await captureDirectorySnapshot(input.receipt.directory.path)) !== directorySnapshotSha256(expected)) throw unavailable();
    return await captureNativeHostWorkspaceReceipt(input.receipt.cwd);
  } finally {
    if (recorded) await clearStaging(input);
    else if (await inspectNativeHostWorkspaceReceipt(scratchReceipt, scratch) === "present") await fs.rm(scratch, { recursive: true, force: true });
  }
}
