import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

type Identity = { path: string; device: string; inode: string };
type Metadata = Identity & { sha256: string; bytes: number };
export type WorkspaceGitSourceRoots = {
  root: string; gitDirectory: Identity; commonDirectory: Identity;
  objectDirectories: Identity[]; metadata: Metadata[]; fingerprint: string;
};
const invalid = () => new Error("workspace_git_source_unproven");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const entry = (target: string) => fs.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null;
  throw error;
});

async function directoryIdentity(target: string): Promise<Identity> {
  const stat = await entry(target);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw invalid();
  const actual = await fs.realpath(target);
  return { path: actual, device: String(stat.dev), inode: String(stat.ino) };
}

async function readMetadata(target: string, limit: number): Promise<{ metadata: Metadata; text: string } | null> {
  const before = await entry(target);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw invalid();
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw invalid();
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true }), current = await entry(target);
    if (!current || bytesRead !== Number(before.size) || bytesRead > limit
      || [opened, after, current].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
        || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)) throw invalid();
    const bytes = buffer.subarray(0, bytesRead);
    return { metadata: { path: target, device: String(before.dev), inode: String(before.ino), bytes: bytesRead, sha256: sha256(bytes) },
      text: bytes.toString("utf8") };
  } finally { await handle.close(); }
}

function metadataPath(text: string): string {
  const value = text.replace(/\r?\n$/, "");
  if (!value || /[\0\r\n]/.test(value)) throw invalid();
  return value;
}

export async function readWorkspaceGitSourceRoots(cwd: string, options: { ancestors?: boolean } = {}): Promise<WorkspaceGitSourceRoots | null> {
  let root = path.resolve(cwd), marker = "", markerEntry: Awaited<ReturnType<typeof entry>>;
  for (let depth = 0; ; depth++) {
    if (depth > 32) throw invalid();
    const source = await entry(root);
    if (!source) return null;
    if (!source.isDirectory() || source.isSymbolicLink()) throw invalid();
    root = await fs.realpath(root);
    marker = path.join(root, ".git"); markerEntry = await entry(marker);
    if (markerEntry) break;
    if (await entry(path.join(root, "objects")) && await entry(path.join(root, "HEAD"))) throw invalid();
    if (!options.ancestors || path.dirname(root) === root) return null;
    root = path.dirname(root);
  }
  const metadata: Metadata[] = [];
  let gitDirectory: Identity;
  if (markerEntry.isDirectory() && !markerEntry.isSymbolicLink()) gitDirectory = await directoryIdentity(marker);
  else {
    const pointer = await readMetadata(marker, 4096);
    if (!pointer || !pointer.text.startsWith("gitdir: ")) throw invalid();
    metadata.push(pointer.metadata);
    gitDirectory = await directoryIdentity(path.resolve(root, metadataPath(pointer.text.slice(8))));
  }
  const commonPointer = await readMetadata(path.join(gitDirectory.path, "commondir"), 4096);
  if (commonPointer) metadata.push(commonPointer.metadata);
  const commonDirectory = commonPointer
    ? await directoryIdentity(path.resolve(gitDirectory.path, metadataPath(commonPointer.text))) : gitDirectory;
  const objectDirectories: Identity[] = [], seen = new Set<string>();
  const visit = async (target: string, depth: number): Promise<void> => {
    if (depth > 4 || seen.size >= 32) throw invalid();
    const directory = await directoryIdentity(target);
    if (seen.has(directory.path)) return;
    seen.add(directory.path); objectDirectories.push(directory);
    if (await entry(path.join(directory.path, "info", "http-alternates"))) throw invalid();
    const alternates = await readMetadata(path.join(directory.path, "info", "alternates"), 64 * 1024);
    if (!alternates) return;
    metadata.push(alternates.metadata);
    const values = alternates.text.split("\n").filter(Boolean);
    if (values.length > 32 || values.some(value => /[\0\r]/.test(value) || value.startsWith('"'))) throw invalid();
    for (const value of values) await visit(path.resolve(directory.path, value), depth + 1);
  };
  await visit(path.join(commonDirectory.path, "objects"), 0);
  objectDirectories.sort((a, b) => a.path.localeCompare(b.path));
  metadata.sort((a, b) => a.path.localeCompare(b.path));
  const result = { root, gitDirectory, commonDirectory, objectDirectories, metadata };
  return { ...result, fingerprint: sha256(JSON.stringify(result)) };
}
