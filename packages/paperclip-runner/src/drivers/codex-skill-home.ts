import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { NativeProviderStateIncompatibleError } from "../contracts/native-session-backend.js";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import {
  materializeNativeRuntimeSkills,
  releaseMaterializedNativeRuntimeSkills,
  removeAbandonedSkillStaging,
} from "./runtime-context-materializer.js";

/**
 * A skill home is a sealed, content-addressed directory that a Codex app-server
 * receives as HOME. Codex discovers `$HOME/.agents/skills`, so sessions with the
 * same assigned skills share one copy instead of each copying into its
 * CODEX_HOME. A published home is never edited: a skill change yields a new digest.
 */
export const CODEX_SKILL_HOME_LAYOUT = "paperclip.codex-skill-home.v2";
/** Claude shows plugin skills as `<plugin name>:<skill>`. */
export const CLAUDE_SKILL_PLUGIN_NAME = "paperclip";
const CLAUDE_SKILL_PLUGIN = { name: CLAUDE_SKILL_PLUGIN_NAME, version: "2.0.0", description: "Skills assigned by Paperclip" };

/** The local plugin directory Claude loads a skill home from. */
export function claudeSkillPluginDirectory(home: string): string {
  return join(home, ".agents");
}

/**
 * Points a provider home at the shared skill home for `context`: removes the
 * provider's own skills copy and abandoned staging, records the reference
 * before publishing (so cleanup sees it), then publishes or reuses the home.
 */
export async function prepareSharedSkillHome(input: {
  providerHome: string;
  storeRoot: string;
  context: NativeRuntimeContextSnapshot;
  skillsDirectory?: string;
}): Promise<{ home: string; digest: string }> {
  await releaseMaterializedNativeRuntimeSkills(join(input.providerHome, input.skillsDirectory ?? "skills"));
  await removeAbandonedSkillStaging(input.providerHome, { olderThanMs: 60 * 60 * 1000 });
  await writeCodexSkillHomeMarker(input.providerHome, codexSkillHomeDigest(input.context));
  const ensured = await ensureCodexSkillHome({ storeRoot: input.storeRoot, context: input.context });
  await touchCodexSkillHome(input.storeRoot, ensured.digest);
  return { home: ensured.home, digest: ensured.digest };
}
const MARKER_SCHEMA = "paperclip.codex-skill-home-ref.v1";
const MARKER_FILE = "paperclip-skill-home.json";
const MANIFEST_FILE = "manifest.json";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

type ManifestEntry = { path: string; size: number; sha256: string };
type Manifest = { layout: string; digest: string; files: ManifestEntry[] };

export function codexSkillHomeDigest(context: NativeRuntimeContextSnapshot): string {
  const skills = context.skills
    .map((skill) => ({ runtimeName: skill.runtimeName, bundleDigest: skill.bundle.digest }))
    .sort((left, right) => (left.runtimeName < right.runtimeName ? -1 : left.runtimeName > right.runtimeName ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ layout: CODEX_SKILL_HOME_LAYOUT, skills })).digest("hex");
}

function integrityFailure(): Error {
  return new Error("codex_skill_home_integrity_failed");
}

/*
 * Skill sets reach tens of thousands of small files. Per-file promise I/O costs
 * ~0.7 ms per file there (measured: 18-22 s for 25k files), so files are read
 * synchronously in short slices that yield to the event loop between batches.
 */
const FILES_PER_SLICE = 200;
const READ_BUFFER = Buffer.allocUnsafe(1 << 20);
const yieldToEventLoop = () => new Promise<void>((resolveYield) => setImmediate(resolveYield));

function hashRegularFileSync(path: string): { size: number; sha256: string } {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw integrityFailure();
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const read = readSync(descriptor, READ_BUFFER, 0, READ_BUFFER.length, size);
      if (read === 0) break;
      hash.update(READ_BUFFER.subarray(0, read));
      size += read;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

/** Lists regular files below `root` as sorted POSIX paths; any other entry type fails. */
async function regularFiles(root: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  let sinceYield = 0;
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = readdirSync(join(root, relativeDirectory), { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
      else throw integrityFailure();
      if (++sinceYield >= FILES_PER_SLICE) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  };
  await visit(prefix);
  return files;
}

async function hashAll(home: string, paths: string[]): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const [index, path] of paths.entries()) {
    entries.push({ path, ...hashRegularFileSync(join(home, path)) });
    if (index % FILES_PER_SLICE === FILES_PER_SLICE - 1) await yieldToEventLoop();
  }
  return entries;
}

async function buildManifest(home: string, digest: string): Promise<Manifest> {
  return { layout: CODEX_SKILL_HOME_LAYOUT, digest, files: await hashAll(home, await regularFiles(home, ".agents")) };
}

/*
 * After sealing, each file's inode, size and ctime are recorded next to the home.
 * ctime cannot be set back by an unprivileged process and changes on any write,
 * chmod or replacement, so a matching record proves the bytes were not touched
 * since they were hashed. Reuse then needs only a walk and lstat; any mismatch
 * falls back to a full content verification.
 */
type StatEntry = [path: string, inode: string, size: string, ctimeNs: string];

const statRecordPath = (storeRoot: string, digest: string) => join(storeRoot, `${digest}.stat.json`);

async function currentStatEntries(home: string): Promise<StatEntry[]> {
  const topLevel = readdirSync(home).sort();
  if (topLevel.join("/") !== [".agents", MANIFEST_FILE].join("/")) throw integrityFailure();
  const entries: StatEntry[] = [];
  for (const [index, path] of [...(await regularFiles(home, ".agents")), MANIFEST_FILE].entries()) {
    const info = lstatSync(join(home, path), { bigint: true });
    if (!info.isFile()) throw integrityFailure();
    entries.push([path, String(info.ino), String(info.size), String(info.ctimeNs)]);
    if (index % FILES_PER_SLICE === FILES_PER_SLICE - 1) await yieldToEventLoop();
  }
  return entries;
}

async function writeStatRecord(storeRoot: string, home: string, digest: string): Promise<void> {
  const temporary = join(storeRoot, `.${digest}.stat.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ files: await currentStatEntries(home) }), { mode: 0o600, flag: "wx" });
    await rename(temporary, statRecordPath(storeRoot, digest));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function matchesStatRecord(storeRoot: string, home: string, digest: string): Promise<boolean> {
  try {
    const recorded = JSON.parse(await readFile(statRecordPath(storeRoot, digest), "utf8")) as { files?: unknown };
    return JSON.stringify(recorded.files) === JSON.stringify(await currentStatEntries(home));
  } catch {
    return false;
  }
}

/** True when an existing home may be reused; a content check refreshes a stale stat record. */
async function reusableCodexSkillHome(storeRoot: string, home: string, digest: string): Promise<boolean> {
  if (await matchesStatRecord(storeRoot, home, digest)) return true;
  try {
    await verifyCodexSkillHome(home);
  } catch {
    return false;
  }
  await writeStatRecord(storeRoot, home, digest);
  return true;
}

async function setTreeMode(root: string, directoryMode: number, fileMode: number): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    if (info.isFile()) await chmod(root, fileMode);
    return;
  }
  // Open directories before descending when unsealing, seal them after.
  if (directoryMode & 0o200) await chmod(root, directoryMode);
  for (const name of await readdir(root)) await setTreeMode(join(root, name), directoryMode, fileMode);
  if (!(directoryMode & 0o200)) await chmod(root, directoryMode);
}

/** Restores write bits inside a sealed tree, never following links, then removes it. */
export async function removeCodexSkillHomeTree(path: string): Promise<void> {
  await setTreeMode(path, 0o700, 0o600);
  await rm(path, { recursive: true, force: true });
}

export async function verifyCodexSkillHome(home: string): Promise<void> {
  try {
    const manifestInfo = await lstat(join(home, MANIFEST_FILE));
    if (!manifestInfo.isFile()) throw integrityFailure();
    const manifest = JSON.parse(await readFile(join(home, MANIFEST_FILE), "utf8")) as Manifest;
    if (manifest.layout !== CODEX_SKILL_HOME_LAYOUT || manifest.digest !== basename(home)
      || !Array.isArray(manifest.files)) throw integrityFailure();
    const topLevel = (await readdir(home)).sort();
    if (topLevel.join("/") !== [".agents", MANIFEST_FILE].join("/")) throw integrityFailure();
    const actual = await regularFiles(home, ".agents");
    if (actual.join("\n") !== manifest.files.map((entry) => entry.path).join("\n")) throw integrityFailure();
    const observed = await hashAll(home, actual);
    manifest.files.forEach((entry, index) => {
      if (observed[index]!.size !== entry.size || observed[index]!.sha256 !== entry.sha256) throw integrityFailure();
    });
  } catch {
    throw integrityFailure();
  }
}

async function quarantineCodexSkillHome(storeRoot: string, home: string): Promise<void> {
  const quarantine = join(storeRoot, "quarantine");
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  // Moving a directory to another parent rewrites its "..": it must be writable.
  await chmod(home, 0o700);
  await rename(home, join(quarantine, `${basename(home)}.${Date.now()}.${randomUUID()}`));
  await rm(statRecordPath(storeRoot, basename(home)), { force: true });
}

async function publishCodexSkillHome(
  storeRoot: string,
  home: string,
  digest: string,
  context: NativeRuntimeContextSnapshot,
): Promise<boolean> {
  // Staging lives inside the store root so the final rename stays on one filesystem.
  const staging = join(storeRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await materializeNativeRuntimeSkills(context, join(staging, ".agents", "skills"));
    // Claude loads `.agents` as a local plugin; its skills appear as `paperclip:<name>`.
    const pluginManifest = join(staging, ".agents", ".claude-plugin");
    await mkdir(pluginManifest, { mode: 0o700 });
    await writeFile(join(pluginManifest, "plugin.json"), JSON.stringify(CLAUDE_SKILL_PLUGIN), { mode: 0o444, flag: "wx" });
    await chmod(pluginManifest, 0o555);
    const manifest = await buildManifest(staging, digest);
    await writeFile(join(staging, MANIFEST_FILE), JSON.stringify(manifest), { mode: 0o444, flag: "wx" });
    await chmod(join(staging, ".agents", "skills"), 0o555);
    await chmod(join(staging, ".agents"), 0o555);
    await chmod(staging, 0o555);
    try {
      await rename(staging, home);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      // Another launch published the same digest first; its copy is authoritative.
      if (!(await reusableCodexSkillHome(storeRoot, home, digest))) throw integrityFailure();
      return false;
    }
    await writeStatRecord(storeRoot, home, digest);
    return true;
  } finally {
    await removeCodexSkillHomeTree(staging).catch(() => undefined);
  }
}

export async function ensureCodexSkillHome(
  input: {
    storeRoot: string;
    context: NativeRuntimeContextSnapshot;
  },
  /** Test seam for launches and cleanup that interleave with this one. */
  dependencies: { beforeQuarantine?: () => Promise<void> } = {},
): Promise<{ home: string; digest: string; created: boolean }> {
  const digest = codexSkillHomeDigest(input.context);
  const home = join(input.storeRoot, digest);
  await mkdir(input.storeRoot, { recursive: true, mode: 0o700 });
  let existing = await lstat(home).catch(() => null);
  // Another launch may replace a damaged home, or cleanup may remove it, while
  // this one checks it. Quarantine only the exact directory judged damaged.
  for (let attempt = 0; existing && attempt < 2; attempt++) {
    if (existing.isDirectory() && await reusableCodexSkillHome(input.storeRoot, home, digest)) {
      return { home, digest, created: false };
    }
    await dependencies.beforeQuarantine?.();
    const current = await lstat(home).catch(() => null);
    if (current && current.ino === existing.ino && current.dev === existing.dev) {
      await quarantineCodexSkillHome(input.storeRoot, home).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      existing = null;
    } else {
      existing = current;
    }
  }
  if (existing) throw integrityFailure();
  const created = await publishCodexSkillHome(input.storeRoot, home, digest, input.context);
  return { home, digest, created };
}

/**
 * Shared skill homes reach Codex through HOME, which Codex honours on Mac and
 * Linux only. Preconfigured (user-owned) homes and remote Runner filesystems
 * keep the per-session copy until they are qualified separately.
 */
export function usesCodexSkillHome(
  options: {
    provider?: string;
    homeMode?: "isolated" | "preconfigured";
    runnerFilesystemRoot?: string;
    codexSkillHomeStoreRoot?: string;
  },
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  return (options.provider ?? "codex") === "codex"
    && options.homeMode !== "preconfigured"
    && !options.runnerFilesystemRoot
    && Boolean(options.codexSkillHomeStoreRoot)
    && platform !== "win32";
}

/** A legacy isolated home can share its skills only when the complete assigned
 * tree still matches. A mismatch keeps the existing launch layout. */
export async function resolveLegacyCodexSkillHome(input: {
  codexHome: string;
  storeRoot: string;
  context: NativeRuntimeContextSnapshot;
  retire?: boolean;
  expectedHome?: string;
}): Promise<string | null> {
  const oldSkills = join(input.codexHome, "skills");
  try {
    if (!lstatSync(oldSkills).isDirectory()) return null;
    const entries = readdirSync(oldSkills).filter(name => name !== ".system").sort();
    const home = (await ensureCodexSkillHome(input)).home;
    if (input.retire && home !== input.expectedHome) return null;
    const sharedSkills = join(home, ".agents", "skills");
    const sharedEntries = readdirSync(sharedSkills).sort();
    if (input.retire ? entries.some(entry => !sharedEntries.includes(entry))
      : JSON.stringify(entries) !== JSON.stringify(sharedEntries)) return null;
    const legacyFiles: string[] = [];
    const sharedFiles: string[] = [];
    for (const entry of entries) {
      for (const [root, files] of [[oldSkills, legacyFiles], [sharedSkills, sharedFiles]] as const) {
        const info = lstatSync(join(root, entry));
        if (!info.isDirectory()) return null;
        files.push(...await regularFiles(root, entry));
      }
    }
    if (JSON.stringify(legacyFiles) !== JSON.stringify(sharedFiles)) return null;
    const legacy = await hashAll(oldSkills, legacyFiles);
    const shared = await hashAll(sharedSkills, sharedFiles);
    if (JSON.stringify(legacy) !== JSON.stringify(shared)) return null;
    if (legacyFiles.some(file => {
      const privateFile = lstatSync(join(oldSkills, file));
      const sharedFile = lstatSync(join(sharedSkills, file));
      return privateFile.nlink !== 1 || (privateFile.mode & 0o111) !== (sharedFile.mode & 0o111);
    })) return null;
    if (input.retire) {
      await recordRecoveredCodexSkillHome({ ...input, home });
      for (const entry of entries) {
        await releaseMaterializedNativeRuntimeSkills(join(oldSkills, entry));
      }
    }
    return home;
  } catch {
    // Old snapshots can outlive their source bundle. Keep their private copy.
    return null;
  }
}

/** Commit the reference only once the recovery launch has been recorded. */
export async function recordRecoveredCodexSkillHome(input: {
  codexHome: string;
  storeRoot: string;
  home: string;
}): Promise<void> {
  const digest = basename(input.home);
  if (dirname(input.home) !== input.storeRoot) throw integrityFailure();
  await touchCodexSkillHome(input.storeRoot, digest);
  await writeCodexSkillHomeMarker(input.codexHome, digest);
}

/** Recovery keeps the skill set a session launched with, or fails before launch. */
export async function resolveRecordedCodexSkillHome(input: {
  codexHome: string;
  storeRoot: string;
  context: NativeRuntimeContextSnapshot | null;
}): Promise<string> {
  const digest = await readCodexSkillHomeMarker(input.codexHome);
  if (!digest) throw new NativeProviderStateIncompatibleError("codex_skill_home_unavailable");
  const home = join(input.storeRoot, digest);
  try {
    if (!(await reusableCodexSkillHome(input.storeRoot, home, digest))) throw integrityFailure();
    await touchCodexSkillHome(input.storeRoot, digest);
    return home;
  } catch {
    if (!input.context || codexSkillHomeDigest(input.context) !== digest) {
      throw new NativeProviderStateIncompatibleError("codex_skill_home_unavailable");
    }
  }
  const ensured = await ensureCodexSkillHome({ storeRoot: input.storeRoot, context: input.context });
  await touchCodexSkillHome(input.storeRoot, digest);
  return ensured.home;
}

export async function touchCodexSkillHome(storeRoot: string, digest: string): Promise<void> {
  if (!DIGEST_PATTERN.test(digest)) throw new Error("codex_skill_home_digest_invalid");
  await writeFile(join(storeRoot, `${digest}.last-used`), "", { mode: 0o600 });
}

export async function writeCodexSkillHomeMarker(codexHome: string, digest: string): Promise<void> {
  if (!DIGEST_PATTERN.test(digest)) throw new Error("codex_skill_home_digest_invalid");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const temporary = join(codexHome, `.${MARKER_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ schema: MARKER_SCHEMA, digest }), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(codexHome, MARKER_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A marker holds a schema and a digest; anything larger was not written by the runner. */
const MAX_MARKER_BYTES = 4096;

/**
 * Reads the skill home a provider home references. The provider home belongs to
 * the agent process, so a link, a non-regular file or an oversized file is
 * treated as no marker rather than followed or read in full.
 */
export async function readCodexSkillHomeMarker(codexHome: string): Promise<string | null> {
  let raw: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(codexHome, MARKER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MARKER_BYTES) return null;
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MARKER_BYTES) return null;
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    const value = JSON.parse(raw) as { schema?: unknown; digest?: unknown };
    return value.schema === MARKER_SCHEMA && typeof value.digest === "string" && DIGEST_PATTERN.test(value.digest)
      ? value.digest : null;
  } catch {
    return null;
  }
}
