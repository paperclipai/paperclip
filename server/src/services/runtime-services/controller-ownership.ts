import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function readHostIdentity(): Promise<string | null> {
  try {
    let identity: string;
    if (process.platform === "linux") {
      const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const namespace = await fs.readlink("/proc/self/ns/pid");
      if (!uuid.test(boot) || !/^pid:\[\d+\]$/.test(namespace)) return null;
      identity = `${boot}:${namespace}`;
    } else if (process.platform === "darwin") {
      const { stdout } = await exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 3000 });
      if (!uuid.test(stdout.trim())) return null;
      identity = stdout.trim();
    } else return null;
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    return createHash("sha256").update(`${process.platform}:${uid}:${identity}`).digest("hex");
  } catch { return null; }
}

// A boot and PID namespace identify where a PID can be interpreted. A hostname
// alone cannot distinguish containers sharing a database or a mounted volume.
let hostIdentity: Promise<string | null> | undefined;
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function createRuntimeServiceControllerOwnership(options: {
  hostIdentity?: () => Promise<string | null>;
  processAbsent?: (pid: number) => boolean;
} = {}) {
  const host = options.hostIdentity ? options.hostIdentity() : (hostIdentity ??= readHostIdentity());
  const absent = options.processAbsent ?? processAbsent;
  async function prefix() {
    const identity = await host;
    return identity && /^[a-f0-9]{64}$/.test(identity) ? `runtime-controller-v1:${identity}:` : null;
  }
  return {
    prefix,
    async claimId() {
      const value = await prefix();
      // Without a verified local scope, retain the ordinary expiring lease.
      return value ? `${value}${process.pid}:${randomUUID()}` : randomUUID();
    },
    async isDead(id: string) {
      const value = await prefix();
      if (!value || !id.startsWith(value)) return false;
      const parts = id.slice(value.length).split(":");
      if (parts.length !== 2 || !/^[1-9]\d*$/.test(parts[0]!) || !uuid.test(parts[1]!)) return false;
      const pid = Number(parts[0]);
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) return false;
      // A recycled PID, EPERM, or any uncertain probe preserves the lease.
      // Only a confirmed absent process permits early recovery. No signal is sent.
      try { return absent(pid); } catch { return false; }
    },
  };
}

export type RuntimeServiceControllerOwnership = ReturnType<typeof createRuntimeServiceControllerOwnership>;
