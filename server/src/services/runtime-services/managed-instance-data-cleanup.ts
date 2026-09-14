import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { z } from "zod";
import type { executionWorkspaces } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { expandHomePrefix, resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { deriveWorktreeInstanceId, stopEmbeddedPostgresIfRunning } from "../workspace-instance-cleanup.js";
import { captureTaskWorkspaceDataTarget, removeTaskWorkspaceData, taskWorkspaceDataTargetSchema } from "./workspace-data-cleanup.js";

type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "mode" | "providerType" | "cwd" | "providerRef" | "branchName" | "metadata">;
const absolutePath = z.string().refine(path.isAbsolute);
const identity = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict();
const directory = identity.extend({ path: absolutePath }).strict();
const file = identity.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const managedInstanceDataTargetSchema = z.object({
  version: z.literal(1), companyId: z.string().guid(), workspaceId: z.string().guid(), instanceId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  workspace: directory, pointer: file, config: file, home: directory,
  filesystem: taskWorkspaceDataTargetSchema, database: directory.nullable(),
}).strict();
export type ManagedInstanceDataTarget = z.infer<typeof managedInstanceDataTargetSchema>;
const fail = () => conflict("The managed instance ownership or configuration could not be verified. Restore its reviewed identity before deleting data.");
const same = (a: z.infer<typeof identity> | null, b: z.infer<typeof identity> | null) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const inside = (root: string, value: string) => value === root || value.startsWith(`${root}${path.sep}`);

async function directoryIdentity(value: string) {
  const stat = await fs.lstat(value, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  return { path: value, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
async function regularFile(value: string) {
  const handle = await fs.open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > 1024n * 1024n) throw fail();
    const contents = await handle.readFile("utf8");
    return { contents, identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), sha256: createHash("sha256").update(contents).digest("hex") } };
  } finally { await handle.close(); }
}
async function protectCurrentInstance() {
  const root = resolvePaperclipInstanceRoot();
  return fs.realpath(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return path.resolve(root); throw error; });
}
async function assertContainedDirectory(root: string, value: unknown, fallback: string) {
  const configured = value === undefined ? fallback : value;
  if (typeof configured !== "string" || !path.isAbsolute(configured)) throw fail();
  const resolved = path.resolve(expandHomePrefix(configured));
  if (!inside(root, resolved)) throw fail();
  // Resolve each existing ancestor; a missing leaf below a symlink must not
  // make external data look as though it belongs to this instance directory.
  let existing = resolved;
  while (!(await fs.lstat(existing).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }))) {
    if (existing === root || path.dirname(existing) === existing) throw fail();
    existing = path.dirname(existing);
  }
  if (await fs.realpath(existing) !== existing) throw fail();
}

/** This captures filesystem custody only. The caller must separately review
 * every service/run and any resources created by the nested instance, commit a
 * durable deletion intent and fence new work before calling removal. */
export async function captureManagedInstanceDataTarget(workspace: Workspace, input: {
  protectedRoots: string[]; worktreesDir?: string;
}): Promise<ManagedInstanceDataTarget | null> {
  const originalWorkspacePath = workspace.providerRef ?? workspace.cwd;
  const persisted = workspace.metadata?.worktreeInstanceRoot;
  if (!originalWorkspacePath || !path.isAbsolute(originalWorkspacePath)) throw fail();
  const workspacePath = await fs.realpath(originalWorkspacePath);
  const envPath = path.join(workspacePath, ".paperclip", ".env");
  const pointerExists = await fs.lstat(envPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!pointerExists && !persisted) return null;
  if (workspace.mode !== "isolated_workspace" || workspace.providerType !== "git_worktree" || typeof persisted !== "string" || !path.isAbsolute(persisted)) throw fail();
  const repoConfigDir = path.join(workspacePath, ".paperclip");
  if (await fs.realpath(repoConfigDir) !== repoConfigDir || !await directoryIdentity(repoConfigDir)) throw fail();
  const pointer = await regularFile(envPath), env = parseEnv(pointer.contents);
  const instanceId = deriveWorktreeInstanceId(originalWorkspacePath);
  if (env.PAPERCLIP_INSTANCE_ID !== instanceId || !env.PAPERCLIP_HOME || env.DATABASE_URL) throw fail();
  const configuredHome = path.resolve(expandHomePrefix(env.PAPERCLIP_HOME));
  const expectedHome = path.resolve(expandHomePrefix(input.worktreesDir?.trim() || process.env.PAPERCLIP_WORKTREES_DIR?.trim() || path.join(os.homedir(), ".paperclip-worktrees")));
  if (!path.isAbsolute(expandHomePrefix(env.PAPERCLIP_HOME)) || configuredHome !== expectedHome || path.resolve(persisted) !== path.join(configuredHome, "instances", instanceId)) throw fail();
  const homePath = await fs.realpath(configuredHome), home = await directoryIdentity(homePath), rootPath = path.join(homePath, "instances", instanceId);
  if (!home || await fs.realpath(path.join(configuredHome, "instances")) !== path.join(homePath, "instances") || await fs.realpath(persisted) !== rootPath) throw fail();
  // The last instance path segment itself must be a directory, not an alias to
  // another instance whose files happen to live under the same managed home.
  if (!await directoryIdentity(persisted)) throw fail();
  const configPath = path.join(repoConfigDir, "config.json");
  if (env.PAPERCLIP_CONFIG && path.resolve(env.PAPERCLIP_CONFIG) !== configPath) throw fail();
  const configFile = await regularFile(configPath), config = JSON.parse(configFile.contents);
  if (config.database?.mode !== "embedded-postgres" || config.database?.connectionString || config.database?.url ||
      (env.PAPERCLIP_STORAGE_PROVIDER ?? config.storage?.provider ?? "local_disk") !== "local_disk") throw fail();
  const dbPath = path.join(rootPath, "db");
  if (path.resolve(config.database.embeddedPostgresDataDir ?? "") !== dbPath) throw fail();
  for (const [value, fallback] of [
    [env.PAPERCLIP_STORAGE_LOCAL_DIR ?? config.storage?.localDisk?.baseDir, path.join(rootPath, "data", "storage")],
    [env.PAPERCLIP_DB_BACKUP_DIR ?? config.database?.backup?.dir, path.join(rootPath, "data", "backups")],
    [config.logging?.logDir, path.join(rootPath, "logs")],
    [env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ?? config.secrets?.localEncrypted?.keyFilePath, path.join(rootPath, "secrets", "master.key")],
    [dbPath, dbPath],
  ]) await assertContainedDirectory(rootPath, value, fallback as string);
  const protectedRoots = [...new Set([...input.protectedRoots, workspacePath, await protectCurrentInstance()])];
  if (protectedRoots.some((value) => inside(rootPath, value))) throw fail();
  const existingProtected: string[] = [];
  for (const value of protectedRoots) if (await fs.stat(value).catch(() => null)) existingProtected.push(await fs.realpath(value));
  const filesystem = await captureTaskWorkspaceDataTarget({ ...workspace, providerType: "local_fs", cwd: persisted, providerRef: persisted, branchName: null,
    metadata: { createdByRuntime: true } }, existingProtected);
  const workspaceIdentity = await directoryIdentity(workspacePath), database = await directoryIdentity(dbPath);
  if (!workspaceIdentity) throw fail();
  return managedInstanceDataTargetSchema.parse({ version: 1, companyId: workspace.companyId, workspaceId: workspace.id, instanceId,
    workspace: workspaceIdentity, pointer: pointer.identity, config: configFile.identity, home, filesystem, database });
}

export async function removeManagedInstanceData(input: {
  companyId: string; workspaceId: string; deletionId: string; target: ManagedInstanceDataTarget;
  assertAuthorized: () => Promise<void>;
}) {
  z.string().guid().parse(input.deletionId);
  const target = managedInstanceDataTargetSchema.parse(input.target);
  if (target.companyId !== input.companyId || target.workspaceId !== input.workspaceId || target.filesystem.companyId !== input.companyId ||
      target.filesystem.workspaceId !== input.workspaceId || target.filesystem.providerType !== "local_fs" || target.filesystem.root.path !== path.join(target.home.path, "instances", target.instanceId)) throw fail();
  const assertOwner = async () => {
    await input.assertAuthorized();
    if (await fs.realpath(target.home.path) !== target.home.path || !same(await directoryIdentity(target.home.path), target.home) ||
        await fs.realpath(target.filesystem.parent.path) !== target.filesystem.parent.path || !same(await directoryIdentity(target.filesystem.parent.path), target.filesystem.parent) ||
        await fs.realpath(target.workspace.path) !== target.workspace.path || !same(await directoryIdentity(target.workspace.path), target.workspace) ||
        inside(target.filesystem.root.path, await protectCurrentInstance())) throw fail();
    const directory = path.join(target.workspace.path, ".paperclip");
    if (await fs.realpath(directory) !== directory) throw fail();
    for (const [name, expected] of [[".env", target.pointer], ["config.json", target.config]] as const) {
      const current = await regularFile(path.join(directory, name));
      if (!same(current.identity, expected) || current.identity.sha256 !== expected.sha256) throw fail();
    }
  };
  await assertOwner();
  const original = await directoryIdentity(target.filesystem.root.path);
  const quarantine = path.join(target.filesystem.parent.path, ".paperclip-service-deletions", input.deletionId, input.workspaceId);
  const source = original ? target.filesystem.root.path : quarantine;
  if (original && !same(original, target.filesystem.root)) throw fail();
  const assertDatabaseStopped = async (root: string) => {
    const database = await directoryIdentity(path.join(root, "db"));
    if (database && !same(database, target.database)) throw fail();
    const record = await regularFile(path.join(root, "db", "postmaster.pid")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!record) return;
    const [pidText, recordedPath] = record.contents.split(/\r?\n/), pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 1 || !recordedPath || path.resolve(recordedPath) !== target.database?.path) throw fail();
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    throw conflict("Stop the managed instance database before deleting its files.");
  };
  if (await directoryIdentity(source)) {
    const database = await directoryIdentity(path.join(source, "db"));
    if (database && !same(database, target.database)) throw fail();
    if (database) {
      await assertOwner();
      if (source === quarantine) {
        // The original path moves only after PostgreSQL has stopped. A process
        // receipt appearing in quarantine is new activity, not a retry signal.
        await assertDatabaseStopped(quarantine);
      } else await stopEmbeddedPostgresIfRunning(database.path);
    }
  }
  await removeTaskWorkspaceData({ companyId: input.companyId, workspaceId: input.workspaceId, deletionId: input.deletionId, target: target.filesystem,
    assertAuthorized: async () => {
      await assertOwner();
      // A restarted database must not follow the checkout into quarantine.
      for (const root of [target.filesystem.root.path, quarantine]) await assertDatabaseStopped(root);
    } });
  return { state: "deleted" as const, instanceId: target.instanceId };
}
