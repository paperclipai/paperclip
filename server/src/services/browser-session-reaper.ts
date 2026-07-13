import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60 * 60;
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;

export type BrowserSessionReaperOptions = {
  socketDir?: string;
  realAgentBrowser?: string;
  idleTimeoutSeconds?: number;
  now?: () => number;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function removeSessionFiles(socketDir: string, session: string) {
  await Promise.all(
    ["pid", "sock", "stream", "version", "engine"].map((suffix) =>
      fs.rm(path.join(socketDir, `${session}.${suffix}`), { force: true }).catch(() => undefined),
    ),
  );
}

export async function reapIdleBrowserSessions(options: BrowserSessionReaperOptions = {}) {
  const socketDir = options.socketDir ?? process.env.AGENT_BROWSER_SOCKET_DIR?.trim() ?? "/tmp/pab";
  const activityRoot = path.join(socketDir, ".paperclip-browser-activity");
  const realAgentBrowser = options.realAgentBrowser
    ?? process.env.PAPERCLIP_AGENT_BROWSER_REAL?.trim()
    ?? "/usr/local/bin/agent-browser-real";
  const idleTimeoutMs = (options.idleTimeoutSeconds
    ?? positiveNumber(process.env.PAPERCLIP_BROWSER_IDLE_TIMEOUT_SECONDS, DEFAULT_IDLE_TIMEOUT_SECONDS)) * 1000;
  const now = options.now?.() ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.readdir(activityRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }

  const socketEntries = await fs.readdir(socketDir).catch(() => [] as string[]);
  const sessions = new Set<string>();
  for (const entry of [...entries, ...socketEntries]) {
    if (entry.endsWith(".activity")) sessions.add(entry.slice(0, -".activity".length));
    if (entry.endsWith(".pid")) sessions.add(entry.slice(0, -".pid".length));
  }

  let reaped = 0;
  for (const session of sessions) {
    if (!/^pc-[a-z0-9]+$/.test(session)) continue;
    const activityPath = path.join(activityRoot, `${session}.activity`);
    const pidPath = path.join(socketDir, `${session}.pid`);
    const activityStat = await fs.stat(activityPath).catch(() => null);
    const pidStat = activityStat ? null : await fs.stat(pidPath).catch(() => null);
    const lastActivityAt = activityStat?.mtimeMs ?? pidStat?.mtimeMs;
    if (lastActivityAt === undefined || now - lastActivityAt < idleTimeoutMs) continue;

    const pidText = await fs.readFile(pidPath, "utf8").catch(() => "");
    const pid = Number(pidText.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      await removeSessionFiles(socketDir, session);
      await fs.rm(activityPath, { force: true });
      continue;
    }

    try {
      process.kill(pid, 0);
    } catch {
      await removeSessionFiles(socketDir, session);
      await fs.rm(activityPath, { force: true });
      continue;
    }

    try {
      await execFileAsync(realAgentBrowser, ["close"], {
        env: {
          ...process.env,
          AGENT_BROWSER_SESSION: session,
          AGENT_BROWSER_NAMESPACE: session,
          AGENT_BROWSER_SOCKET_DIR: socketDir,
        },
        timeout: 15_000,
      });
    } catch (error) {
      logger.warn({ err: error, pid, session }, "managed browser close failed; terminating idle daemon");
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // It exited between the close attempt and the fallback signal.
      }
    }
    await fs.rm(activityPath, { force: true });
    reaped += 1;
    logger.info({ pid, session, idleTimeoutMs }, "reaped idle managed browser session");
  }
  return { reaped };
}

export function startBrowserSessionReaper(options: BrowserSessionReaperOptions = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reapIdleBrowserSessions(options);
    } catch (error) {
      logger.warn({ err: error }, "managed browser idle reaper failed");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), DEFAULT_SCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
