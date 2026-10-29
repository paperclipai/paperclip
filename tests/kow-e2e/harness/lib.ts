import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function scratchRoot(): string {
  return process.env.PKST_SCRATCH ?? join(homedir(), ".cache", "paperclip-kow-smoketest");
}

export function baseImg(): string {
  return join(scratchRoot(), "base", "noble-cloudimg-amd64.img");
}

export function runsDir(): string {
  return join(scratchRoot(), "runs");
}

export interface Manifest {
  nonce: string;
  qemuPid: number;
  qemuStartTime: number;
  hostfwdPort: number;
  overlayPath: string;
  runDir: string;
  owner: string;
  startedAt: string;
}

export function newNonce(): string {
  return "r" + randomBytes(9).toString("hex");
}

export function runDirFor(nonce: string): string {
  return join(scratchRoot(), `run-${nonce}`);
}

export function ensureDirs() {
  for (const d of [scratchRoot(), join(scratchRoot(), "base"), runsDir()]) {
    mkdirSync(d, { recursive: true });
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
  });
}

export function sshBase(port: number, keyPath: string, knownHosts: string): string[] {
  return [
    "-F", "/dev/null",
    "-i", keyPath,
    "-p", String(port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ConnectTimeout=5",
    "-o", "LogLevel=ERROR",
  ];
}

export function scpBase(port: number, keyPath: string, knownHosts: string): string[] {
  return [
    "-F", "/dev/null",
    "-i", keyPath,
    "-P", String(port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "LogLevel=ERROR",
  ];
}

export interface SshResult { code: number; stdout: string; stderr: string; }

export function ssh(
  port: number, keyPath: string, knownHosts: string, user: string, cmd: string,
): SshResult {
  const r = spawnSync("ssh", [...sshBase(port, keyPath, knownHosts), `${user}@127.0.0.1`, cmd], {
    encoding: "utf8", timeout: 120_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function scp(
  port: number, keyPath: string, knownHosts: string, local: string, remote: string,
): SshResult {
  const r = spawnSync(
    "scp",
    [...scpBase(port, keyPath, knownHosts), local, `tester@127.0.0.1:${remote}`],
    { encoding: "utf8", timeout: 120_000 },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export async function waitForSsh(
  port: number, keyPath: string, knownHosts: string, timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = ssh(port, keyPath, knownHosts, "tester", "true");
    if (r.code === 0) return true;
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

export function writeManifest(m: Manifest) {
  ensureDirs();
  writeFileSync(join(runsDir(), `${m.nonce}.json`), JSON.stringify(m, null, 2), { mode: 0o664 });
}

export function manifestPath(nonce: string): string {
  return join(runsDir(), `${nonce}.json`);
}

export function readManifest(nonce: string): Manifest | null {
  const p = manifestPath(nonce);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

export function procAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readProcStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const rest = stat.slice(rparen + 1).trim().split(/\s+/);
    const starttime = rest[19];
    if (starttime === undefined) return null;
    const n = Number(starttime);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
