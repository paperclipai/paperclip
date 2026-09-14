import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(value => path.isAbsolute(value) && !value.includes("\0"));
const identity = z.object({ path: absolutePath, dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/),
  birthtimeNs: z.string().regex(/^\d+$/).optional() }).strict();
const pointer = identity.extend({ content: z.string().min(1).max(4096) }).strict();
export const nativeHostWorkspaceReceiptSchema = z.object({
  schema: z.literal("paperclip.native-host-workspace/v1"),
  cwd: absolutePath,
  parent: identity,
  directory: identity,
  git: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }).strict(),
    z.object({ kind: z.literal("embedded"), directory: identity }).strict(),
    z.object({ kind: z.literal("external"), pointer, directory: identity,
      commonDirectory: identity.optional(), commonPointer: pointer.optional(), backPointer: pointer.optional(),
    }).strict(),
  ]),
}).strict();
export type NativeHostWorkspaceReceipt = z.infer<typeof nativeHostWorkspaceReceiptSchema>;
type Identity = z.infer<typeof identity>;
const unavailable = () => new Error("native_host_workspace_identity_unverified");

async function directoryIdentity(directory: string): Promise<Identity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  const canonical = await fs.realpath(directory);
  const after = await fs.lstat(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw unavailable();
  return { path: canonical, dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

async function readPointer(file: string): Promise<z.infer<typeof pointer>> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 4096n) throw unavailable();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (bytesRead !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || !named.isFile() || named.dev !== before.dev || named.ino !== before.ino || content.includes("\0")) throw unavailable();
    return { path: await fs.realpath(file), dev: String(before.dev), ino: String(before.ino), birthtimeNs: String(before.birthtimeNs), content };
  } finally { await handle.close(); }
}

async function optionalPointer(file: string) {
  try { return await readPointer(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function assertAbsent(file: string) {
  try { await fs.lstat(file); throw unavailable(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function pointerTarget(from: string, value: string) {
  const target = value.trim();
  if (!target || /[\r\n\0]/.test(target)) throw unavailable();
  return path.resolve(path.dirname(from), target);
}

async function sameDirectory(expected: Identity) {
  const current = await directoryIdentity(expected.path);
  if (current.path !== expected.path || current.dev !== expected.dev || current.ino !== expected.ino
    || (expected.birthtimeNs !== undefined && current.birthtimeNs !== expected.birthtimeNs)) throw unavailable();
}

async function samePointer(expected: z.infer<typeof pointer>) {
  const current = await readPointer(expected.path);
  if (current.path !== expected.path || current.dev !== expected.dev || current.ino !== expected.ino || current.content !== expected.content
    || (expected.birthtimeNs !== undefined && current.birthtimeNs !== expected.birthtimeNs)) throw unavailable();
}

/** Read-only launch evidence. It contains no Git configuration, credentials,
 * source contents, or provider authority. The descriptor authenticates it. */
export async function captureNativeHostWorkspaceReceipt(cwd: string): Promise<NativeHostWorkspaceReceipt> {
  if (!path.isAbsolute(cwd)) throw unavailable();
  cwd = path.resolve(cwd);
  const parent = await directoryIdentity(path.dirname(cwd));
  const directory = await directoryIdentity(cwd);
  if (path.join(parent.path, path.basename(cwd)) !== directory.path) throw unavailable();
  const markerPath = path.join(directory.path, ".git");
  const marker = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let git: NativeHostWorkspaceReceipt["git"] = { kind: "absent" };
  if (marker?.isDirectory()) {
    git = { kind: "embedded", directory: await directoryIdentity(markerPath) };
  } else if (marker) {
    if (!marker.isFile() || marker.isSymbolicLink()) throw unavailable();
    const captured = await readPointer(markerPath);
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(captured.content);
    if (!match) throw unavailable();
    const gitDirectory = await directoryIdentity(pointerTarget(markerPath, match[1]!));
    const commonPointer = await optionalPointer(path.join(gitDirectory.path, "commondir"));
    const backPointer = await optionalPointer(path.join(gitDirectory.path, "gitdir"));
    const commonDirectory = commonPointer ? await directoryIdentity(pointerTarget(commonPointer.path, commonPointer.content)) : undefined;
    if (backPointer && ![markerPath, path.join(cwd, ".git")].includes(pointerTarget(backPointer.path, backPointer.content))) throw unavailable();
    git = { kind: "external", pointer: captured, directory: gitDirectory,
      ...(commonPointer ? { commonPointer, commonDirectory } : {}), ...(backPointer ? { backPointer } : {}) };
  }
  const receipt: NativeHostWorkspaceReceipt = { schema: "paperclip.native-host-workspace/v1", cwd, parent, directory, git };
  await inspectNativeHostWorkspaceReceipt(receipt, cwd);
  return receipt;
}

/** A missing root and a replacement root are different recovery decisions.
 * Never authorize a write merely because the pathname matches an old run. */
export async function inspectNativeHostWorkspaceReceipt(value: unknown, cwd: string): Promise<"present" | "missing"> {
  const parsed = nativeHostWorkspaceReceiptSchema.safeParse(value);
  if (!parsed.success || !path.isAbsolute(cwd)) throw unavailable();
  const receipt = parsed.data;
  if (path.resolve(cwd) !== receipt.cwd || receipt.directory.path !== path.join(receipt.parent.path, path.basename(receipt.cwd))) throw unavailable();
  const present = await inspectRoot(receipt);
  await inspectGit(receipt, present);
  return present ? "present" : "missing";
}

async function inspectRoot(receipt: NativeHostWorkspaceReceipt): Promise<boolean> {
  const currentParent = await directoryIdentity(path.dirname(receipt.cwd));
  if (currentParent.path !== receipt.parent.path || currentParent.dev !== receipt.parent.dev || currentParent.ino !== receipt.parent.ino
    || (receipt.parent.birthtimeNs !== undefined && currentParent.birthtimeNs !== receipt.parent.birthtimeNs)) throw unavailable();
  let present = true;
  try { await sameDirectory(receipt.directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false; else throw error; }
  return present;
}

async function inspectGit(receipt: NativeHostWorkspaceReceipt, present: boolean) {
  const markerPath = path.join(receipt.directory.path, ".git");
  if (receipt.git.kind === "external") {
    const git = receipt.git;
    if (git.pointer.path !== markerPath || Boolean(git.commonPointer) !== Boolean(git.commonDirectory)) throw unavailable();
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(git.pointer.content);
    if (!match || await fs.realpath(pointerTarget(markerPath, match[1]!)) !== git.directory.path) throw unavailable();
    await sameDirectory(git.directory);
    if (git.commonPointer && git.commonDirectory) {
      if (git.commonPointer.path !== path.join(git.directory.path, "commondir")) throw unavailable();
      await samePointer(git.commonPointer); await sameDirectory(git.commonDirectory);
      if (await fs.realpath(pointerTarget(git.commonPointer.path, git.commonPointer.content)) !== git.commonDirectory.path) throw unavailable();
    } else await assertAbsent(path.join(git.directory.path, "commondir"));
    if (git.backPointer) {
      if (git.backPointer.path !== path.join(git.directory.path, "gitdir") || ![markerPath, path.join(receipt.cwd, ".git")].includes(pointerTarget(git.backPointer.path, git.backPointer.content))) throw unavailable();
      await samePointer(git.backPointer);
    } else await assertAbsent(path.join(git.directory.path, "gitdir"));
    if (present) await samePointer(git.pointer);
  } else if (receipt.git.kind === "embedded") {
    if (receipt.git.directory.path !== markerPath) throw unavailable();
    if (present) await sameDirectory(receipt.git.directory);
  } else if (present && receipt.git.kind === "absent") {
    await assertAbsent(markerPath);
  }
}

/** An interrupted copy may contain some of the saved seed. Only a private
 * recovery journal can attest its newly created root; Git administration
 * outside that root must still belong to the original working copy. */
export async function inspectNativeHostWorkspaceRecoveryRoot(original: NativeHostWorkspaceReceipt, created: NativeHostWorkspaceReceipt) {
  nativeHostWorkspaceReceiptSchema.parse(original);
  nativeHostWorkspaceReceiptSchema.parse(created);
  if (created.git.kind !== "absent" || created.cwd !== original.cwd
    || JSON.stringify(created.parent) !== JSON.stringify(original.parent)
    || created.directory.path !== original.directory.path) throw unavailable();
  if (!(await inspectRoot(created))) throw unavailable();
  await inspectGit(original, false);
}
