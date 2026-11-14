import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";

const ownerFile = ".volume-free-owner.json";
const ownerSchema = "paperclip.volume-free-controller-state.v1";

export type VolumeFreeControllerStateClaim = "owned" | "claimed" | "unclaimed" | "released" | "absent";

export function isVolumeFreeControllerStateOwnerEntry(name: string) {
  return name === ownerFile || name.startsWith(`${ownerFile}.`);
}

async function regularOwnerFile(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return undefined;
    throw error;
  });
  return Boolean(entry?.isFile());
}

export async function volumeFreeControllerStateOwned(base = nativeHarnessStateBase()): Promise<boolean> {
  const path = join(base, ownerFile);
  if (!await regularOwnerFile(path)) return false;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) return undefined;
    throw error;
  });
  if (!handle) return false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return false;
    const marker = JSON.parse(await handle.readFile("utf8")) as unknown;
    return Boolean(marker && typeof marker === "object" && (marker as Record<string, unknown>).schema === ownerSchema);
  } catch { return false; }
  finally { await handle.close(); }
}

function claimWriterAlive(name: string) {
  const pid = Number(name.slice(ownerFile.length + 1).split(".")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function removeAbandonedClaims(base: string, listed: string[]) {
  const marker = await lstat(join(base, ownerFile)).catch(() => undefined);
  for (const name of listed.filter(name => name.startsWith(`${ownerFile}.`))) {
    const entry = await lstat(join(base, name)).catch(() => undefined);
    if (!entry?.isFile()) continue;
    const published = marker?.isFile() && marker.ino === entry.ino && marker.dev === entry.dev;
    if (published || !claimWriterAlive(name)) await rm(join(base, name), { force: true });
  }
}

export async function claimVolumeFreeControllerState(volumeFree: boolean, base = nativeHarnessStateBase()): Promise<VolumeFreeControllerStateClaim> {
  if (!volumeFree) {
    const owned = await volumeFreeControllerStateOwned(base);
    if (await regularOwnerFile(join(base, ownerFile))) await rm(join(base, ownerFile), { force: true });
    return owned ? "released" : "absent";
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const listed = await readdir(base).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    await removeAbandonedClaims(base, listed);
    if (await volumeFreeControllerStateOwned(base)) return "owned";
    const entries = listed.filter(name => !name.startsWith(`${ownerFile}.`));
    if (entries.some(name => !isVolumeFreeControllerStateOwnerEntry(name))) return "unclaimed";
    if (entries.includes(ownerFile) && !await regularOwnerFile(join(base, ownerFile))) return "unclaimed";
    await mkdir(base, { recursive: true, mode: 0o700 });
    const temporary = join(base, `${ownerFile}.${process.pid}.${randomUUID()}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schema: ownerSchema, claimedAt: new Date().toISOString(), pid: process.pid }));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await link(temporary, join(base, ownerFile));
    } catch (error) {
      await rm(temporary, { force: true });
      if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      continue;
    }
    await rm(temporary, { force: true });
    const directory = await open(base, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return "claimed";
  }
  return await volumeFreeControllerStateOwned(base) ? "owned" : "unclaimed";
}
