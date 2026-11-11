import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";

const ownerFile = ".volume-free-owner.json";
const ownerSchema = "paperclip.volume-free-controller-state.v1";

export type VolumeFreeControllerStateClaim = "owned" | "claimed" | "unclaimed" | "released" | "absent";

export function isVolumeFreeControllerStateOwnerEntry(name: string) {
  return name === ownerFile || name.startsWith(`${ownerFile}.`);
}

export async function volumeFreeControllerStateOwned(base = nativeHarnessStateBase()): Promise<boolean> {
  const handle = await open(join(base, ownerFile), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
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

export async function claimVolumeFreeControllerState(volumeFree: boolean, base = nativeHarnessStateBase()): Promise<VolumeFreeControllerStateClaim> {
  if (!volumeFree) {
    const owned = await volumeFreeControllerStateOwned(base);
    await rm(join(base, ownerFile), { force: true });
    return owned ? "released" : "absent";
  }
  if (await volumeFreeControllerStateOwned(base)) return "owned";
  const entries = await readdir(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  if (entries.some(name => !isVolumeFreeControllerStateOwnerEntry(name))) return "unclaimed";
  await mkdir(base, { recursive: true, mode: 0o700 });
  const temporary = join(base, `${ownerFile}.${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schema: ownerSchema, claimedAt: new Date().toISOString(), pid: process.pid }));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, join(base, ownerFile));
  const directory = await open(base, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return "claimed";
}
