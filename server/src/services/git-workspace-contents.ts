import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { localRepositoryPath } from "./local-repository-path.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { ensureSavedGitCommit, gitCacheCommand, GitCacheRestorationFailure } from "./git-workspace-restoration.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.local.json";
const SETTINGS_LIMIT = 64 * 1024;
const CHECKOUT_LIMIT = 50;
type Identity = { companyId: string; workspaceId: string };
type Settings = { material: StoredSecretVersionMaterial } | null;
export type ManagedCheckoutSource = { id: string; repoUrl: string; repoRef: string | null; cwd: string | null };
export type ManagedCheckoutContents = {
  name: string; source: ManagedCheckoutSource; commit: string; branchName: string | null;
};
export type GitWorkspaceContents = {
  schema: "paperclip.git-workspace-contents.v1";
  settings: Settings;
  checkouts: Array<ManagedCheckoutContents & { settings: Settings }>;
};

async function entry(target: string) {
  return fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function checkedDirectory(cwd: string, relative: string, create = false) {
  let current = await fs.realpath(cwd);
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await entry(current);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitCacheRestorationFailure();
  }
  return current;
}

async function readSettings(cwd: string) {
  if (!await checkedDirectory(cwd, ".claude")) return null;
  const target = path.join(cwd, CLAUDE_SETTINGS_PATH);
  const initial = await entry(target);
  if (!initial) return null;
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > SETTINGS_LIMIT) throw new Error("unsupported_local_settings");
  if (await gitCacheCommand(cwd, ["ls-files", "--error-unmatch", "--", CLAUDE_SETTINGS_PATH]).then(() => true, () => false)) throw new Error("tracked_local_settings");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SETTINGS_LIMIT) throw new Error("unsupported_local_settings");
    const buffer = Buffer.alloc(SETTINGS_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > SETTINGS_LIMIT) throw new Error("unsupported_local_settings");
    return { mode: stat.mode & 0o777, bytes: buffer.subarray(0, length).toString("base64") };
  } finally { await handle.close(); }
}

async function saveSettings(cwd: string, identity: Identity, relativePath: string): Promise<Settings> {
  const value = await readSettings(cwd);
  if (!value) return null;
  const { material } = await localEncryptedProvider.createVersion({ value: JSON.stringify({ ...identity, relativePath, ...value }) });
  return { material };
}

async function savedSettings(settings: Settings, identity: Identity, relativePath: string) {
  if (settings === null) return null;
  const value = JSON.parse(await localEncryptedProvider.resolveVersion({ material: settings.material, externalRef: null }));
  if (value.companyId !== identity.companyId || value.workspaceId !== identity.workspaceId || value.relativePath !== relativePath
    || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777
    || typeof value.bytes !== "string" || value.bytes.length > Math.ceil(SETTINGS_LIMIT / 3) * 4
    || Buffer.from(value.bytes, "base64").toString("base64") !== value.bytes) throw new GitCacheRestorationFailure();
  return { mode: value.mode as number, bytes: value.bytes as string };
}

export function validateGitWorkspaceContents(contents: GitWorkspaceContents | undefined) {
  if (contents === undefined) return;
  const settingsValid = (settings: Settings) => settings === null || !!settings && typeof settings.material === "object"
    && settings.material !== null && JSON.stringify(settings.material).length <= SETTINGS_LIMIT * 2;
  if (!contents || contents.schema !== "paperclip.git-workspace-contents.v1" || !settingsValid(contents.settings)
    || !Array.isArray(contents.checkouts) || contents.checkouts.length > CHECKOUT_LIMIT) throw new GitCacheRestorationFailure();
  const names = new Set<string>();
  for (const checkout of contents.checkouts) {
    if (!checkout || !checkout.source || typeof checkout.source.id !== "string" || typeof checkout.source.repoUrl !== "string"
      || !(checkout.source.repoRef === null || typeof checkout.source.repoRef === "string")
      || !(checkout.source.cwd === null || typeof checkout.source.cwd === "string")
      || typeof checkout.name !== "string" || !/^[A-Za-z0-9_-]+-[a-f0-9]{12}$/.test(checkout.name)
      || checkout.name !== managedProjectCheckoutName(checkout.source) || names.has(checkout.name)
      || !/^[a-f0-9]{40}$/.test(checkout.commit)
      || !(checkout.branchName === null || typeof checkout.branchName === "string" && checkout.branchName.length > 0
        && checkout.branchName.length <= 1024 && !checkout.branchName.startsWith("-") && !checkout.branchName.includes("\0"))
      || !settingsValid(checkout.settings)) throw new GitCacheRestorationFailure();
    names.add(checkout.name);
  }
}

export function selectRestoredProjectRepositories<T extends { id: string; repoUrl: string | null; repoRef: string | null; cwd?: string | null }>(sources: T[], contents?: GitWorkspaceContents): T[] {
  validateGitWorkspaceContents(contents);
  for (const checkout of contents?.checkouts ?? []) {
    if (!sources.some(source => source.id === checkout.source.id && source.repoUrl === checkout.source.repoUrl)) throw new GitCacheRestorationFailure();
  }
  return sources.map(source => {
    const saved = contents?.checkouts.find(checkout => checkout.source.id === source.id)?.source;
    return saved ? { ...source, repoRef: saved.repoRef, cwd: saved.cwd } : source;
  });
}

export async function readManagedCheckoutContents(checkout: string, name: string, source: ManagedCheckoutSource, signal?: AbortSignal): Promise<ManagedCheckoutContents> {
  const commit = (await gitCacheCommand(checkout, ["rev-parse", "HEAD"], signal)).trim();
  const branchName = (await gitCacheCommand(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch(() => "")).trim() || null;
  return { name, source, commit, branchName };
}

export async function captureGitWorkspaceContents(cwd: string, identity: Identity, checkouts: ManagedCheckoutContents[]): Promise<GitWorkspaceContents> {
  if (checkouts.length > CHECKOUT_LIMIT) throw new Error("managed_checkout_budget");
  const contents: GitWorkspaceContents = { schema: "paperclip.git-workspace-contents.v1",
    settings: await saveSettings(cwd, identity, CLAUDE_SETTINGS_PATH), checkouts: [] };
  for (const checkout of checkouts.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${PROJECT_REPOSITORIES_DIR}/${checkout.name}`;
    if (!await checkedDirectory(cwd, relative)) throw new GitCacheRestorationFailure();
    contents.checkouts.push({ ...checkout, settings: await saveSettings(path.join(cwd, relative), identity, `${relative}/${CLAUDE_SETTINGS_PATH}`) });
  }
  validateGitWorkspaceContents(contents);
  return contents;
}

export async function assertGitWorkspaceContentsUnchanged(cwd: string, identity: Identity, contents: GitWorkspaceContents | undefined, checkouts: ManagedCheckoutContents[]) {
  validateGitWorkspaceContents(contents);
  const recorded = contents?.checkouts.map(({ settings: _settings, ...checkout }) => checkout) ?? [];
  if (!isDeepStrictEqual(recorded, checkouts.sort((a, b) => a.name.localeCompare(b.name)))) throw new Error("managed_checkouts_changed");
  const assertSettings = async (root: string, saved: Settings, relative: string) => {
    if (!isDeepStrictEqual(await readSettings(root), await savedSettings(saved, identity, relative))) throw new Error("local_settings_changed");
  };
  await assertSettings(cwd, contents?.settings ?? null, CLAUDE_SETTINGS_PATH);
  for (const checkout of contents?.checkouts ?? []) {
    const relative = `${PROJECT_REPOSITORIES_DIR}/${checkout.name}`;
    if (!await checkedDirectory(cwd, relative)) throw new Error("managed_checkouts_changed");
    await assertSettings(path.join(cwd, relative), checkout.settings, `${relative}/${CLAUDE_SETTINGS_PATH}`);
  }
}

async function restoreSettings(cwd: string, settings: Settings, identity: Identity, relative: string) {
  const saved = await savedSettings(settings, identity, relative);
  const directory = await checkedDirectory(cwd, ".claude", saved !== null);
  if (!directory) return;
  const target = path.join(directory, "settings.local.json");
  const temporary = path.join(directory, `.settings-restore-${createHash("sha256").update(JSON.stringify(settings)).digest("hex")}`);
  const pending = await entry(temporary);
  if (pending) {
    if (!saved || !pending.isFile() || pending.isSymbolicLink() || pending.size > SETTINGS_LIMIT) throw new GitCacheRestorationFailure();
    const current = await entry(target);
    const expected = Buffer.from(saved.bytes, "base64");
    const bytes = await fs.readFile(temporary);
    const unpublished = pending.nlink === 1 && !current && bytes.length <= expected.length
      && bytes.equals(expected.subarray(0, bytes.length)) && [0o600, saved.mode].includes(pending.mode & 0o777);
    const published = pending.nlink === 2 && current?.ino === pending.ino && current.dev === pending.dev
      && bytes.equals(expected) && (pending.mode & 0o777) === saved.mode;
    if (!unpublished && !published) throw new GitCacheRestorationFailure();
    await fs.unlink(temporary);
  }
  const current = await readSettings(cwd);
  if (current) {
    if (!isDeepStrictEqual(current, saved)) throw new GitCacheRestorationFailure();
    return;
  }
  if (!saved) return;
  try {
    await fs.writeFile(temporary, Buffer.from(saved.bytes, "base64"), { flag: "wx", mode: 0o600 });
    await fs.chmod(temporary, saved.mode);
    await fs.link(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function restoreGitWorkspaceContents(input: Identity & { cwd: string; contents?: GitWorkspaceContents;
  prepareLocalSource?: (sourceCwd: string) => Promise<() => Promise<void>>;
  resolveGitAuth: GitRemoteAuthProvider; authorizeSource: (source: ManagedCheckoutSource) => Promise<void> }) {
  if (!input.contents) return;
  validateGitWorkspaceContents(input.contents);
  try {
    for (const checkout of input.contents.checkouts) {
      await input.authorizeSource(checkout.source);
      const localSource = localRepositoryPath(checkout.source.repoUrl);
      if (localSource && !input.prepareLocalSource) throw new GitCacheRestorationFailure();
      const recheck = localSource ? await input.prepareLocalSource!(localSource) : undefined;
      const root = await checkedDirectory(input.cwd, PROJECT_REPOSITORIES_DIR, true);
      const destination = path.join(root!, checkout.name);
      const relative = `${PROJECT_REPOSITORIES_DIR}/${checkout.name}/${CLAUDE_SETTINGS_PATH}`;
      const existing = await entry(destination);
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink() || !(await entry(path.join(destination, ".git")))?.isDirectory()
          || (await fs.realpath(path.join(destination, ".git"))) !== path.join(destination, ".git")) throw new GitCacheRestorationFailure();
        if ((await gitCacheCommand(destination, ["rev-parse", "--show-toplevel"])).trim() !== destination
          || (await gitCacheCommand(destination, ["config", "--local", "--null", "--get-all", "remote.origin.url"])) !== `${checkout.source.repoUrl}\0`) throw new GitCacheRestorationFailure();
        const actual = await readManagedCheckoutContents(destination, checkout.name, checkout.source);
        if (actual.commit !== checkout.commit || actual.branchName !== checkout.branchName) throw new GitCacheRestorationFailure();
        await restoreSettings(destination, checkout.settings, input, relative);
        continue;
      }
      const result = await materializeManagedProjectWorkspace(destination, { repoUrl: checkout.source.repoUrl,
        resolveGitAuth: input.resolveGitAuth, beforePublish: async temporary => {
          await ensureSavedGitCommit(temporary, checkout.source.repoUrl, checkout.commit, input.resolveGitAuth);
          if (checkout.branchName) await gitCacheCommand(temporary, ["check-ref-format", "--branch", checkout.branchName]);
          await gitCacheCommand(temporary, checkout.branchName
            ? ["checkout", "-B", checkout.branchName, checkout.commit] : ["checkout", "--detach", checkout.commit]);
          await gitCacheCommand(temporary, ["reflog", "expire", "--expire=now", "--all"]);
          await restoreSettings(temporary, checkout.settings, input, relative);
          await input.authorizeSource(checkout.source);
          await recheck?.();
        } });
      if (result.warning) throw new GitCacheRestorationFailure();
    }
    await restoreSettings(input.cwd, input.contents.settings, input, CLAUDE_SETTINGS_PATH);
  } catch { throw new GitCacheRestorationFailure(); }
}
