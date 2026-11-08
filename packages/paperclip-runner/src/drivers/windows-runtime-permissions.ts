import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let identity: Promise<string> | undefined;

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

/** Applies only to a new, validated Paperclip-owned snapshot tree. */
export async function setWindowsRuntimeTreeReadOnly(root: string, readOnly: boolean): Promise<void> {
  const sid = await currentSid();
  await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
    readOnly ? [root, "/deny", `*${sid}:(OI)(CI)(WD,AD,WEA,WA)`] : [root, "/remove:d", `*${sid}`, "/T", "/C", "/L"],
    { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
}
