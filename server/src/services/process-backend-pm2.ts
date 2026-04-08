/**
 * Pm2ProcessBackend — production ProcessBackend implementation backed
 * by the pm2 npm package's programmatic API.
 *
 * Behavior:
 *   - pm2.connect() is lazy — first call to any method establishes a
 *     single persistent connection to the pm2 daemon. The daemon
 *     survives COS v2 server restarts (intentional — we don't want
 *     server reboot to kill every leader CLI).
 *   - spawn() uses pm2.start({...}) with autorestart, crash backoff,
 *     and max_restarts to handle transient failures.
 *   - Log rotation is handled by the pm2-logrotate module (installed
 *     separately by ensureLogRotateInstalled()).
 *   - tailLog() reads the log file path from pm2.describe and pulls
 *     the last N lines directly with node:fs.
 *
 * @see docs/cos-v2/phase4-cli-design.md §11.1
 */

import fs from "node:fs";
import path from "node:path";
import pm2 from "pm2";
import type {
  ProcessBackend,
  ProcessHandle,
  ProcessInfo,
  ProcessSpec,
} from "./process-backend.js";

/** Promisified wrappers over the callback-style pm2 API. */
function pm2Connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

function pm2Start(options: pm2.StartOptions): Promise<pm2.Proc[]> {
  return new Promise((resolve, reject) => {
    pm2.start(options, (err, procs) => (err ? reject(err) : resolve(procs as pm2.Proc[])));
  });
}

function pm2Stop(nameOrId: string | number): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.stop(nameOrId, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2Delete(nameOrId: string | number): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.delete(nameOrId, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2List(): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => (err ? reject(err) : resolve(list)));
  });
}

function pm2Describe(nameOrId: string | number): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.describe(nameOrId, (err, procs) =>
      err ? reject(err) : resolve(procs),
    );
  });
}

/** Map PM2's process_status to our ProcessInfo.status enum. */
function mapStatus(s: string | undefined): ProcessInfo["status"] {
  switch (s) {
    case "online":
      return "online";
    case "stopped":
    case "stopping":
      return s as ProcessInfo["status"];
    case "errored":
      return "errored";
    case "launching":
      return "launching";
    default:
      return "unknown";
  }
}

function toProcessInfo(p: pm2.ProcessDescription): ProcessInfo {
  const monit = p.monit ?? {};
  const env = p.pm2_env ?? {};
  return {
    name: p.name ?? "",
    pmId: p.pm_id ?? -1,
    pid: p.pid ?? null,
    status: mapStatus((env as any).status),
    uptimeMs:
      (env as any).pm_uptime && (env as any).status === "online"
        ? Date.now() - (env as any).pm_uptime
        : 0,
    restartCount: (env as any).restart_time ?? 0,
    memoryBytes: (monit as any).memory ?? 0,
    cpuPercent: (monit as any).cpu ?? 0,
  };
}

/**
 * Read the last N lines of a log file. Returns [] if the file is
 * missing. No rotation awareness — pm2-logrotate may have moved the
 * file to .log.N; callers can pass a rotated path if desired.
 */
function tailFile(filePath: string, lines: number): string[] {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
  } catch {
    return [];
  }
  // For a small tail (< ~1 MB typical), just read the whole file.
  // pm2-logrotate caps single files at ~10 MB.
  const content = fs.readFileSync(filePath, "utf8");
  const all = content.split(/\r?\n/);
  const start = Math.max(0, all.length - lines - 1);
  return all.slice(start, all.length - 1); // drop trailing empty line
}

export function createPm2Backend(): ProcessBackend {
  let connected = false;
  async function ensureConnected() {
    if (connected) return;
    await pm2Connect();
    connected = true;
  }

  return {
    async spawn(spec: ProcessSpec): Promise<ProcessHandle> {
      await ensureConnected();
      const outFile = spec.outFile ?? path.join(spec.cwd, "logs", "stdout.log");
      const errFile = spec.errFile ?? path.join(spec.cwd, "logs", "stderr.log");
      const procs = await pm2Start({
        name: spec.name,
        script: spec.script,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        output: outFile,
        error: errFile,
        merge_logs: true,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 2000,
        exp_backoff_restart_delay: 1000,
        kill_timeout: 10_000,
        time: true,
      });
      const proc = procs[0];
      const penv: any = (proc as any).pm2_env ?? {};
      return {
        name: (proc as any).name ?? spec.name,
        pmId: (proc as any).pm_id ?? penv.pm_id ?? -1,
        pid: (proc as any).pid ?? penv.pid ?? -1,
      };
    },

    async stop(name, _timeoutMs) {
      await ensureConnected();
      // pm2.stop honors kill_timeout set at spawn time. Read the exit
      // code post-stop from describe if available.
      try {
        await pm2Stop(name);
      } catch (err: any) {
        // "process name not found" is not fatal — already gone.
        if (!/not\s+found/i.test(String(err?.message ?? err))) {
          throw err;
        }
      }
      const desc = await pm2Describe(name).catch(() => []);
      const penv: any = desc[0]?.pm2_env ?? {};
      return { exitCode: penv.exit_code ?? null };
    },

    async remove(name) {
      await ensureConnected();
      try {
        await pm2Delete(name);
      } catch (err: any) {
        if (!/not\s+found/i.test(String(err?.message ?? err))) {
          throw err;
        }
      }
    },

    async list(): Promise<ProcessInfo[]> {
      await ensureConnected();
      const procs = await pm2List();
      return procs.map(toProcessInfo);
    },

    async describe(name): Promise<ProcessInfo | null> {
      await ensureConnected();
      const procs = await pm2Describe(name);
      const p = procs[0];
      return p ? toProcessInfo(p) : null;
    },

    async isAlive(name): Promise<boolean> {
      const info = await (async () => {
        try {
          await ensureConnected();
          const procs = await pm2Describe(name);
          return procs[0] ? toProcessInfo(procs[0]) : null;
        } catch {
          return null;
        }
      })();
      return !!info && info.status === "online";
    },

    async tailLog(name, kind, lines) {
      await ensureConnected();
      const procs = await pm2Describe(name);
      const penv: any = procs[0]?.pm2_env ?? {};
      const filePath =
        kind === "out"
          ? penv.pm_out_log_path ?? null
          : penv.pm_err_log_path ?? null;
      if (!filePath) return [];
      return tailFile(filePath, lines);
    },
  };
}

/**
 * Ensure pm2-logrotate is installed and configured. Called once at
 * server startup. Idempotent — no-op if already present.
 *
 * Not part of ProcessBackend because it's a pm2 daemon-level concern
 * that applies to all managed processes, not to a specific spec.
 */
export async function ensureLogRotateInstalled(): Promise<void> {
  // pm2.install isn't in the type defs of pm2 6.x — use the callback
  // form via the untyped surface.
  const pm2Any = pm2 as any;
  if (typeof pm2Any.install !== "function") return;
  await new Promise<void>((resolve, reject) => {
    pm2Any.install("pm2-logrotate", (err: Error | null) =>
      err ? reject(err) : resolve(),
    );
  }).catch(() => {
    // Installation is best-effort. If it fails we still function —
    // logs just won't auto-rotate. Logged by the caller.
  });
}
