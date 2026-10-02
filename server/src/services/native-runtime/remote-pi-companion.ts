/** Explicit operator-imported Linux authority. No downloads or executable probes. */
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { createHash } from "node:crypto";
import { type Stats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveQualifiedAcpxProfile } from "../../vendor/paperclip-runner/index.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const MAX_BYTES = 4 * 1024 ** 3;
const MAX_FILE = 512 * 1024 ** 2;
const MANIFEST = "companion.json";
const AUTHORITY = ".import-authority.json";
type Entry = { path: string; mode: number; kind: "directory" } | { path: string; mode: number; kind: "file"; size: number; sha256: string } | { path: string; mode: number; kind: "symlink"; target: string };
export interface RemotePiCompanionManifest { schema: "paperclip.remote-pi-companion/v1"; sourceRevision: string; target: "linux-x64"; profileDigest: string; providerPackDigest: string; daemonSha256: string; entries: Entry[] }
function require(value: unknown, reason: string): asserts value { if (!value) throw new Error(`runner_remote_companion_invalid: ${reason}`); }
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const safe = (path: string) => path.length > 0 && path.length < 4096 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/u.test(path) && path.split("/").every(p => p !== "" && p !== "." && p !== "..");
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
type Checkpoint = () => Promise<void>;
function checkpoints(cancel?: () => void): Checkpoint {
  const deadline = Date.now() + 600_000;
  return async () => { await yieldToSignals(); cancel?.(); require(Date.now() < deadline, "import deadline exceeded"); };
}
async function directory(path: string) { const st = await fs.lstat(path); require(st.isDirectory() && !st.isSymbolicLink() && await fs.realpath(path) === path, "directory is linked or noncanonical"); return st; }
/** One descriptor and 1MiB buffer; no whole executable allocation or sync hashing. */
async function readStable(path: string, maximum: number, privateFile: boolean, check: Checkpoint, consume?: (chunk: Buffer) => Promise<void>) {
  require(await fs.realpath(dirname(path)) === dirname(path), "linked parent");
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat(); require(before.isFile() && before.size <= maximum && (!privateFile || before.nlink === 1), "file type, link or byte bound");
    const hash = createHash("sha256"); let size = 0; const buffer = Buffer.alloc(1024 * 1024); let header = Buffer.alloc(0);
    for (;;) {
      await check(); const { bytesRead } = await file.read(buffer); if (!bytesRead) break;
      size += bytesRead; require(size <= maximum && size <= before.size, "file grew beyond bound");
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); if (!header.length) header = Buffer.from(chunk.subarray(0, 64));
      await consume?.(chunk);
    }
    require(size === before.size && same(before, await file.stat()) && same(before, await fs.lstat(path)), "file changed during read");
    return { size, sha256: hash.digest("hex"), header, stat: before };
  } finally { await file.close(); }
}
async function readOwned(path: string, maximum: number, check: Checkpoint, privateFile = false): Promise<Buffer> {
  const chunks: Buffer[] = []; await readStable(path, maximum, privateFile, check, async chunk => { chunks.push(Buffer.from(chunk)); }); return Buffer.concat(chunks);
}
/** Complete no-follow inventory, including modes and contained symbolic links. */
export async function inventoryRemoteCompanion(root: string, check = checkpoints()): Promise<Entry[]> {
  await directory(root); const entries: Entry[] = []; const links = new Map<string, { count: number; links: number }>(); let total = 0;
  const visit = async (path: string): Promise<void> => {
    const before = await directory(path);
    for (const name of (await fs.readdir(path)).sort()) {
      await check();
      if (path === root && [MANIFEST, AUTHORITY].includes(name)) continue;
      const file = join(path, name); const rel = relative(root, file); require(safe(rel), "unsafe path");
      const st = await fs.lstat(file); const mode = st.mode & 0o7777;
      require(entries.length < 100_000 && (st.isSymbolicLink() || (mode & 0o7022) === 0), "entry count or unsafe mode");
      if (st.isDirectory()) { require((mode & 0o700) === 0o700, "directory requires owner read/write/search for owned cleanup"); entries.push({ path: rel, mode, kind: "directory" }); await visit(file); }
      else if (st.isFile()) {
        total += st.size; require(total <= MAX_BYTES, "tree byte bound"); const read = await readStable(file, MAX_FILE, false, check);
        require(same(st, read.stat), "discovered file changed");
        entries.push({ path: rel, mode, kind: "file", size: read.size, sha256: read.sha256 });
        const key = `${st.dev}:${st.ino}`; const group = links.get(key) ?? { count: 0, links: st.nlink }; group.count++; require(group.links === st.nlink, "hardlink identity drift"); links.set(key, group);
      } else if (st.isSymbolicLink()) {
        const target = await fs.readlink(file); require(!isAbsolute(target) && !/[\x00-\x1f\x7f]/u.test(target) && inside(root, resolve(dirname(file), target)) && inside(root, await fs.realpath(file)), "escaping symbolic link");
        require(same(st, await fs.lstat(file)), "link changed"); entries.push({ path: rel, mode, kind: "symlink", target });
      } else throw new Error("runner_remote_companion_invalid: special entry");
    }
    const after = await directory(path); require(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, "directory changed");
  };
  await visit(root); require([...links.values()].every(g => g.count === g.links), "external hardlink");
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function installedIdentity(serverRoot: string, check: Checkpoint) {
  require(process.platform === "darwin" || process.platform === "linux", "companion import supports macOS and Linux controllers");
  await directory(serverRoot); const pkg = JSON.parse((await readOwned(join(serverRoot, "package.json"), 65536, check, true)).toString()); require(pkg.name === "@paperclipai/server", "public server package required");
  const source = JSON.parse((await readOwned(join(serverRoot, "dist/build-info.json"), 65536, check, true)).toString()).commit;
  require(typeof source === "string" && /^[a-f0-9]{40}$/u.test(source), "installed build source is missing");
  const profile = resolveQualifiedAcpxProfile("pi", MODEL); require(profile.qualificationStatus !== "pending", "Pi is not qualified");
  return { source, profileDigest: profile.commandDigest };
}
async function validate(root: string, manifest: RemotePiCompanionManifest, identity: Awaited<ReturnType<typeof installedIdentity>>, check: Checkpoint) {
  require(manifest.schema === "paperclip.remote-pi-companion/v1" && manifest.target === "linux-x64" && manifest.sourceRevision === identity.source && manifest.profileDigest === identity.profileDigest, "source/profile/target mismatch");
  require(JSON.stringify(await inventoryRemoteCompanion(root, check)) === JSON.stringify(manifest.entries), "complete inventory mismatch");
  const daemon = manifest.entries.find(e => e.path === "bin/paperclip-runnerd");
  require(daemon?.kind === "file" && daemon.size > 64 && (daemon.mode & 0o111) !== 0 && daemon.sha256 === manifest.daemonSha256, "daemon identity");
  const elf = (await readStable(join(root, daemon.path), MAX_FILE, false, check)).header; require(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && elf[4] === 2 && elf[5] === 1 && elf.readUInt16LE(18) === 62, "Linux x64 ELF required");
  const pack = JSON.parse((await readOwned(join(root, "provider-pack/provider-pack.json"), 16 * 1024 ** 2, check)).toString());
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
  require(pack.schema === "paperclip-runner/remote-provider-pack/v1" && pack.digest === manifest.providerPackDigest && pack.digest === `sha256:${digest(canonical(pack.payload))}`, "pack manifest digest");
  require(pack.payload.runnerSourceRevision === identity.source && pack.payload.target.platform === "linux" && pack.payload.target.architecture === "x64", "pack source/target");
  const pi = pack.payload.candidateProviders?.pi; require(pi?.qualification === "qualified" && pi.profileDigest === identity.profileDigest && pi.path === "provider-assets/pi/linux-x64", "normal Pi pack required");
}
/** Release-side command uses this same inventory contract before publication. */
export async function createRemotePiCompanionManifest(root: string, sourceRevision: string): Promise<RemotePiCompanionManifest> {
  const check = checkpoints();
  const profile = resolveQualifiedAcpxProfile("pi", MODEL); const pack = JSON.parse((await readOwned(join(root, "provider-pack/provider-pack.json"), 16 * 1024 ** 2, check)).toString()); const entries = await inventoryRemoteCompanion(root, check);
  const daemon = entries.find(e => e.path === "bin/paperclip-runnerd"); require(daemon?.kind === "file", "daemon missing");
  const manifest: RemotePiCompanionManifest = { schema: "paperclip.remote-pi-companion/v1", sourceRevision, target: "linux-x64", profileDigest: profile.commandDigest, providerPackDigest: pack.digest, daemonSha256: daemon.sha256, entries };
  require(/^[a-f0-9]{40}$/u.test(sourceRevision), "release source"); await validate(root, manifest, { source: sourceRevision, profileDigest: profile.commandDigest }, check); return manifest;
}
function cacheParent(serverRoot: string) { return join(serverRoot, "remote-companions"); }
async function removeOwned(path: string, owned: Stats) { const st = await fs.lstat(path); require(st.dev === owned.dev && st.ino === owned.ino && !st.isSymbolicLink(), "cleanup root ownership changed"); await fs.rm(path, { recursive: true }); }
export async function importRemotePiCompanion(input: { directory: string; sha256: string; serverRoot?: string; checkCancelled?: () => void }) {
  const checkpoint = checkpoints(input.checkCancelled);
  await checkpoint();
  const serverRoot = input.serverRoot ?? SERVER_ROOT; const identity = await installedIdentity(serverRoot, checkpoint); const source = await fs.realpath(input.directory); require(source === resolve(input.directory), "linked import root"); await directory(source);
  require(/^[a-f0-9]{64}$/u.test(input.sha256), "expected manifest SHA256 required"); const bytes = await readOwned(join(source, MANIFEST), 32 * 1024 ** 2, checkpoint); require(digest(bytes) === input.sha256, "operator manifest digest mismatch");
  const manifest = JSON.parse(bytes.toString()) as RemotePiCompanionManifest; await validate(source, manifest, identity, checkpoint); await checkpoint();
  const parent = cacheParent(serverRoot); try { await fs.mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Remote companion setup requires a writable installed server package", { cause: error }); }
  const parentInfo = await directory(parent); require((parentInfo.mode & 0o077) === 0 && parentInfo.uid === process.getuid?.(), "cache must be private and operator-owned");
  const lockPath = join(parent, ".import-linux-x64.lock"); const lock = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); const lockInfo = await lock.stat();
  let staging: string | undefined; let stagingInfo: Stats | undefined; let outputInfo: Stats | undefined; let committed = false; const output = join(parent, "linux-x64");
  try {
    await checkpoint();
    try { await fs.lstat(output); const existing = await resolveRemotePiCompanion({ serverRoot, checkpoint }); require(existing?.manifestSha256 === input.sha256, "existing companion differs; remove only after stopping all runs"); await checkpoint(); return { status: "verified_existing", ...existing }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    staging = await fs.mkdtemp(join(parent, ".import-")); stagingInfo = await fs.lstat(staging);
    for (const entry of manifest.entries.filter(e => e.kind === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length)) await fs.mkdir(join(staging, entry.path), { mode: 0o700 });
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") continue;
      const file = join(staging, entry.path); const outputFile = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const read = await readStable(join(source, entry.path), MAX_FILE, false, checkpoint, async chunk => {
          let offset = 0; while (offset < chunk.length) { await checkpoint(); offset += (await outputFile.write(chunk, offset)).bytesWritten; }
        });
        require(read.size === entry.size && read.sha256 === entry.sha256, "source changed while copied");
      } finally { await outputFile.close(); }
      await fs.chmod(file, entry.mode); await checkpoint();
    }
    for (const entry of manifest.entries) if (entry.kind === "symlink") await fs.symlink(entry.target, join(staging, entry.path));
    for (const entry of manifest.entries.filter(e => e.kind === "directory").reverse()) await fs.chmod(join(staging, entry.path), entry.mode);
    await fs.writeFile(join(staging, MANIFEST), bytes, { flag: "wx", mode: 0o600 }); await validate(staging, manifest, identity, checkpoint); await validate(source, manifest, identity, checkpoint); await checkpoint();
    // Claim the final path exclusively; no rename may replace a concurrent directory.
    await fs.mkdir(output, { mode: 0o700 }); outputInfo = await fs.lstat(output);
    for (const name of await fs.readdir(staging)) { const now = await directory(output); require(now.dev === outputInfo.dev && now.ino === outputInfo.ino, "publication ownership changed"); await fs.rename(join(staging, name), join(output, name)); }
    await fs.writeFile(join(output, AUTHORITY), JSON.stringify({ sha256: input.sha256 }) + "\n", { flag: "wx", mode: 0o600 });
    const result = await resolveRemotePiCompanion({ serverRoot, checkpoint }); require(result?.manifestSha256 === input.sha256, "publication verification"); await checkpoint(); committed = true; return { status: "imported_verified", ...result };
  } finally {
    const failures: unknown[] = []; const cleanup = async (fn: () => Promise<void>) => { try { await fn(); } catch (error) { failures.push(error); } };
    if (outputInfo && !committed) await cleanup(() => removeOwned(output, outputInfo!));
    if (staging && stagingInfo) await cleanup(() => removeOwned(staging!, stagingInfo!));
    await cleanup(async () => { const now = await fs.lstat(lockPath); require(now.dev === lockInfo.dev && now.ino === lockInfo.ino, "lock ownership changed"); await fs.unlink(lockPath); }); await lock.close();
    if (failures.length) throw new AggregateError(failures, "Remote companion cleanup incomplete; inspect owned paths before retrying");
  }
}
export async function resolveRemotePiCompanion(input: { serverRoot?: string; workspaceRoot?: string; checkpoint?: Checkpoint } = {}) {
  const check = input.checkpoint ?? checkpoints();
  const serverRoot = input.serverRoot ?? SERVER_ROOT; const parent = cacheParent(serverRoot); const root = join(parent, "linux-x64");
  try { await fs.lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parentInfo = await directory(parent); require((parentInfo.mode & 0o077) === 0 && parentInfo.uid === process.getuid?.(), "cache privacy"); await directory(root);
  if (input.workspaceRoot) { const workspace = await fs.realpath(input.workspaceRoot); require(!inside(workspace, root) && !inside(root, workspace), "companion cache cannot overlap a workspace"); }
  const authority = JSON.parse((await readOwned(join(root, AUTHORITY), 65536, check, true)).toString()); const bytes = await readOwned(join(root, MANIFEST), 32 * 1024 ** 2, check, true); require(digest(bytes) === authority.sha256, "installed authority changed");
  const manifest = JSON.parse(bytes.toString()) as RemotePiCompanionManifest; await validate(root, manifest, await installedIdentity(serverRoot, check), check);
  return { root, runnerBinary: join(root, "bin/paperclip-runnerd"), providerPack: join(root, "provider-pack"), manifestSha256: authority.sha256 as string, sourceRevision: manifest.sourceRevision, target: manifest.target };
}

/** Explicit legacy overrides remain authoritative; C/C never gain this Pi path. */
export async function selectRemotePiCompanion(input: { provider: { kind: string; agent?: string }; remote: boolean; binaryOverride?: string | null; packOverride?: string | null; workspaceRoot: string; serverRoot?: string }) {
  if (!input.remote || input.provider.kind !== "acpx" || input.provider.agent !== "pi" || input.binaryOverride?.trim() || input.packOverride?.trim()) return null;
  return resolveRemotePiCompanion({ serverRoot: input.serverRoot, workspaceRoot: input.workspaceRoot });
}
