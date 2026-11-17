import { execFile } from "node:child_process";
import { join, win32 } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
let identity: Promise<string> | undefined;
const volumesWithoutAcls = new Set<string>();
export type WindowsRuntimeAclResult = "acl" | "no_persistent_acls";

async function volumeIdentity(root: string) {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Runtime snapshot directory changed");
  const canonical = await realpath(root), resolved = await lstat(canonical);
  if (entry.dev !== resolved.dev || entry.ino !== resolved.ino) throw new Error("Runtime snapshot directory changed");
  return { canonical, dev: resolved.dev, ino: resolved.ino, key: `${win32.parse(canonical).root.toLowerCase()}:${resolved.dev}` };
}

async function lacksPersistentAcls(root: string): Promise<boolean> {
  const before = await volumeIdentity(root);
  const { stdout } = await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", '$v=Get-Volume -FilePath $env:PAPERCLIP_RUNTIME_VOLUME_PROBE -ErrorAction Stop; @{filesystem=[string]$v.FileSystemType;volume=[string]$v.UniqueId}|ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, env: { ...process.env, PAPERCLIP_RUNTIME_VOLUME_PROBE: before.canonical } });
  const volume = JSON.parse(stdout.trim());
  if (!volume || typeof volume.volume !== "string" || !volume.volume || typeof volume.filesystem !== "string"
    || !["FAT", "FAT32", "EXFAT"].includes(volume.filesystem.toUpperCase())) return false;
  const after = await volumeIdentity(root);
  if (before.canonical !== after.canonical || before.dev !== after.dev || before.ino !== after.ino) throw new Error("Runtime snapshot directory changed");
  volumesWithoutAcls.add(after.key);
  return true;
}

async function currentSid(): Promise<string> {
  identity ??= (async () => {
    const { stdout } = await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 });
    const sid = stdout.match(/"(S-1-\d+(?:-\d+)+)"/)?.[1];
    if (!sid) throw new Error("Cannot identify the Windows runtime account");
    return sid;
  })().catch(error => { identity = undefined; throw error; });
  return identity;
}

/** ACL protection for an owned tree. Callers retain read-only file attributes,
 * byte verification and provider sandbox policy when the volume has no ACLs. */
export async function setWindowsRuntimeTreeReadOnly(root: string, readOnly: boolean, options: { recursive?: boolean } = {}): Promise<WindowsRuntimeAclResult> {
  if (volumesWithoutAcls.size && volumesWithoutAcls.has((await volumeIdentity(root)).key)) return "no_persistent_acls";
  const sid = await currentSid();
  try {
    await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
    readOnly ? [root, "/deny", `*${sid}:(OI)(CI)(WD,AD,WEA,WA)`, "/Q"]
      : [root, "/remove:d", `*${sid}`, ...(options.recursive === false ? [] : ["/T", "/C"]), "/L", "/Q"],
    { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 });
    return "acl";
  } catch (error) {
    // Only positive capability evidence permits this fallback. A failed probe,
    // unknown filesystem, or real NTFS/ReFS permission failure stays an error.
    if (await lacksPersistentAcls(root).catch(() => false)) return "no_persistent_acls";
    throw error;
  }
}
