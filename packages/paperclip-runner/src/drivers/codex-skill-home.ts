import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import { materializeNativeRuntimeSkills } from "./runtime-context-materializer.js";

/**
 * A skill home is a sealed, content-addressed directory that a Codex app-server
 * receives as HOME. Codex discovers `$HOME/.agents/skills`, so sessions with the
 * same assigned skills share one copy instead of each copying into its
 * CODEX_HOME. A published home is never edited: a skill change yields a new digest.
 */
export const CODEX_SKILL_HOME_LAYOUT = "paperclip.codex-skill-home.v1";
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

async function hashRegularFile(path: string): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw integrityFailure();
    const bytes = await handle.readFile();
    return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Lists regular files below `root` as sorted POSIX paths; any other entry type fails. */
async function regularFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, relative));
    if (info.isDirectory()) files.push(...(await regularFiles(root, relative)));
    else if (info.isFile()) files.push(relative);
    else throw integrityFailure();
  }
  return files;
}

async function buildManifest(home: string, digest: string): Promise<Manifest> {
  const files: ManifestEntry[] = [];
  for (const path of await regularFiles(home, ".agents")) {
    files.push({ path, ...(await hashRegularFile(join(home, path))) });
  }
  return { layout: CODEX_SKILL_HOME_LAYOUT, digest, files };
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
    for (const entry of manifest.files) {
      const observed = await hashRegularFile(join(home, entry.path));
      if (observed.size !== entry.size || observed.sha256 !== entry.sha256) throw integrityFailure();
    }
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
    const manifest = await buildManifest(staging, digest);
    await writeFile(join(staging, MANIFEST_FILE), JSON.stringify(manifest), { mode: 0o444, flag: "wx" });
    await chmod(join(staging, ".agents", "skills"), 0o555);
    await chmod(join(staging, ".agents"), 0o555);
    await chmod(staging, 0o555);
    try {
      await rename(staging, home);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      // Another launch published the same digest first; its copy is authoritative.
      await verifyCodexSkillHome(home);
      return false;
    }
  } finally {
    await removeCodexSkillHomeTree(staging).catch(() => undefined);
  }
}

export async function ensureCodexSkillHome(input: {
  storeRoot: string;
  context: NativeRuntimeContextSnapshot;
}): Promise<{ home: string; digest: string; created: boolean }> {
  const digest = codexSkillHomeDigest(input.context);
  const home = join(input.storeRoot, digest);
  await mkdir(input.storeRoot, { recursive: true, mode: 0o700 });
  const existing = await lstat(home).catch(() => null);
  if (existing) {
    try {
      if (!existing.isDirectory()) throw integrityFailure();
      await verifyCodexSkillHome(home);
      return { home, digest, created: false };
    } catch {
      await quarantineCodexSkillHome(input.storeRoot, home);
    }
  }
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

/** Recovery keeps the skill set a session launched with, or fails before launch. */
export async function resolveRecordedCodexSkillHome(input: {
  codexHome: string;
  storeRoot: string;
  context: NativeRuntimeContextSnapshot | null;
}): Promise<string> {
  const digest = await readCodexSkillHomeMarker(input.codexHome);
  if (!digest) throw new Error("codex_skill_home_unavailable");
  const home = join(input.storeRoot, digest);
  try {
    await verifyCodexSkillHome(home);
    await touchCodexSkillHome(input.storeRoot, digest);
    return home;
  } catch {
    if (!input.context || codexSkillHomeDigest(input.context) !== digest) {
      throw new Error("codex_skill_home_unavailable");
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

export async function readCodexSkillHomeMarker(codexHome: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(codexHome, MARKER_FILE), "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as { schema?: unknown; digest?: unknown };
    return value.schema === MARKER_SCHEMA && typeof value.digest === "string" && DIGEST_PATTERN.test(value.digest)
      ? value.digest : null;
  } catch {
    return null;
  }
}
