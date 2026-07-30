import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  closeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "./home-paths.js";

export const CONTROL_PLANE_LOCK_BASENAME = "control-plane.lock.json";

export type ControlPlaneLockPayload = {
  pid: number;
  startedAt: string;
  instanceId: string;
  instanceRoot: string;
  argv0: string;
  allowSharedEnv: string;
};

export type AcquiredControlPlaneLock = {
  lockPath: string;
  payload: ControlPlaneLockPayload;
  release: () => void;
};

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we lack permission to signal it (still running).
    // ESRCH = process does not exist (stale lock).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockPayload(raw: string): ControlPlaneLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ControlPlaneLockPayload>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    if (typeof parsed.instanceRoot !== "string" || parsed.instanceRoot.trim().length === 0) return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
      instanceRoot: parsed.instanceRoot,
      argv0: typeof parsed.argv0 === "string" ? parsed.argv0 : "",
      allowSharedEnv: typeof parsed.allowSharedEnv === "string" ? parsed.allowSharedEnv : "",
    };
  } catch {
    return null;
  }
}

export function resolveControlPlaneLockPath(instanceRoot = resolvePaperclipInstanceRoot()): string {
  return resolve(instanceRoot, "runtime", CONTROL_PLANE_LOCK_BASENAME);
}

export function readControlPlaneLock(lockPath: string): ControlPlaneLockPayload | null {
  if (!existsSync(lockPath)) return null;
  try {
    return parseLockPayload(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function formatHeldLockError(lockPath: string, holder: ControlPlaneLockPayload): Error {
  return new Error(
    [
      `Another Paperclip control plane already holds this instance (pid=${holder.pid}, startedAt=${holder.startedAt || "unknown"}).`,
      `Lock: ${lockPath}`,
      `Instance: ${holder.instanceRoot}`,
      "Two control planes against one instance share schedulers/sweepers and can strand agent runs.",
      "Stop the other process, or set PAPERCLIP_ALLOW_SHARED_INSTANCE=1 only if you intentionally want shared mode.",
    ].join(" "),
  );
}

/**
 * Exclusive control-plane lock for a Paperclip instance directory.
 *
 * Prevents a second `paperclipai run` / `pnpm dev` from attaching to the same
 * instance DB and running duplicate schedulers/sweepers.
 *
 * Bypass: PAPERCLIP_ALLOW_SHARED_INSTANCE=1|true|yes
 */
export function acquireControlPlaneLock(opts: {
  instanceRoot?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date;
}): AcquiredControlPlaneLock | null {
  const env = opts.env ?? process.env;
  const allowShared = /^(1|true|yes)$/i.test(env.PAPERCLIP_ALLOW_SHARED_INSTANCE?.trim() ?? "");
  if (allowShared) {
    return null;
  }

  const instanceRoot = resolve(opts.instanceRoot ?? resolvePaperclipInstanceRoot());
  const lockPath = resolveControlPlaneLockPath(instanceRoot);
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => new Date());
  const payload: ControlPlaneLockPayload = {
    pid,
    startedAt: now().toISOString(),
    instanceId: resolvePaperclipInstanceId(),
    instanceRoot,
    argv0: process.argv.slice(0, 2).join(" "),
    allowSharedEnv: "0",
  };

  mkdirSync(dirname(lockPath), { recursive: true });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 0, "utf8");
      } finally {
        closeSync(fd);
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = readControlPlaneLock(lockPath);
          if (current?.pid === pid) {
            rmSync(lockPath, { force: true });
          }
        } catch {
          // best-effort cleanup
        }
      };

      return { lockPath, payload, release };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;

      const holder = readControlPlaneLock(lockPath);
      if (holder && holder.pid === pid) {
        // Same process already owns the lock (tests / nested start).
        return {
          lockPath,
          payload: holder,
          release: () => {
            try {
              const current = readControlPlaneLock(lockPath);
              if (current?.pid === pid) rmSync(lockPath, { force: true });
            } catch {
              // ignore
            }
          },
        };
      }

      if (holder && isPidRunning(holder.pid)) {
        throw formatHeldLockError(lockPath, holder);
      }

      // Stale or unreadable lock. Re-read immediately before unlink to shrink the
      // TOCTOU window where another process could replace the file after our PID check.
      const confirmed = readControlPlaneLock(lockPath);
      if (confirmed && isPidRunning(confirmed.pid)) {
        throw formatHeldLockError(lockPath, confirmed);
      }
      if (
        confirmed &&
        holder &&
        confirmed.pid === holder.pid &&
        !isPidRunning(confirmed.pid)
      ) {
        try {
          rmSync(lockPath, { force: true });
        } catch (e) {
          lastErr = e;
          // Contended remove — loop and retry exclusive create.
        }
      } else if (!confirmed) {
        try {
          rmSync(lockPath, { force: true });
        } catch (e) {
          lastErr = e;
          // Contended remove — loop and retry exclusive create.
        }
      }
    }
  }

  const cause = lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new Error(`Failed to acquire Paperclip control-plane lock at ${lockPath}${cause}`);
}
