import fs from "node:fs";
import path from "node:path";

export type RunLockState = {
  pid: number;
  startedAt: string;
  command: string;
  instanceId: string;
};

export type RunLockHandle = {
  lockPath: string;
  state: RunLockState;
  release: () => void;
};

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

function readLock(lockPath: string): RunLockState | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as RunLockState;
  } catch {
    return null;
  }
}

export function acquireRunLock(instanceRoot: string, instanceId: string): RunLockHandle {
  fs.mkdirSync(instanceRoot, { recursive: true });
  const lockPath = path.join(instanceRoot, "run.lock.json");

  const state: RunLockState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    instanceId,
  };

  try {
    fs.writeFileSync(lockPath, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
  } catch {
    const existing = readLock(lockPath);
    if (existing && isPidAlive(existing.pid)) {
      throw new Error(
        `Another paperclipai run appears active for instance '${instanceId}' (pid=${existing.pid}, startedAt=${existing.startedAt}).`,
      );
    }

    // stale/corrupt lock: attempt atomic re-acquire first
    try {
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(lockPath, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
    } catch {
      const contested = readLock(lockPath);
      if (contested && isPidAlive(contested.pid)) {
        throw new Error(
          `Another paperclipai run appears active for instance '${instanceId}' (pid=${contested.pid}, startedAt=${contested.startedAt}).`,
        );
      }
      throw new Error(`Failed to acquire run lock for instance '${instanceId}'. Retry startup.`);
    }
  }

  let released = false;
  return {
    lockPath,
    state,
    release: () => {
      if (released) return;
      released = true;
      try {
        const latest = readLock(lockPath);
        if (!latest || latest.pid === process.pid) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch {
        // best effort cleanup only
      }
    },
  };
}

export type ReadinessMode = "full" | "api-only";

export type ReadinessResult = {
  ok: boolean;
  apiOk: boolean;
  uiOk: boolean;
  checks: number;
  mode: ReadinessMode;
};

export async function waitForReadiness(opts: {
  baseUrl: string;
  mode: ReadinessMode;
  timeoutMs?: number;
  intervalMs?: number;
  fetcher?: typeof fetch;
}): Promise<ReadinessResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const fetcher = opts.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;

  let checks = 0;
  let apiOk = false;
  let uiOk = opts.mode === "api-only";

  while (Date.now() < deadline) {
    checks += 1;
    apiOk = await probe(`${opts.baseUrl.replace(/\/$/, "")}/api/health`, fetcher);
    if (opts.mode === "full") {
      uiOk = await probe(`${opts.baseUrl.replace(/\/$/, "")}/`, fetcher);
    }

    if (apiOk && uiOk) {
      return { ok: true, apiOk, uiOk, checks, mode: opts.mode };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { ok: false, apiOk, uiOk, checks, mode: opts.mode };
}

async function probe(url: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const res = await fetcher(url, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
