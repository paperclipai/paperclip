import fs from "node:fs";
import path from "node:path";
import {
  isPidAlive,
  readLocalServicePortOwner,
} from "./services/local-service-supervisor.js";
import {
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipInstanceRoot,
} from "./home-paths.js";

const DEFAULT_API_PORT = 3100;
const DEFAULT_PG_PORT = 54329;

// ---- Lightweight config reader (avoids config.ts side-effects) ----

export function findDevConfigFilePath(fromDir: string): string | null {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, ".paperclip", "config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const instanceDefault = path.join(resolvePaperclipInstanceRoot(), "config.json");
  return fs.existsSync(instanceDefault) ? instanceDefault : null;
}

export interface DevConfig {
  deploymentMode: string;
  exposure: string;
  bind: string;
  host: string;
  port: number;
  pgDataDir: string;
  pgPort: number;
}

export function readDevConfig(overrideConfigPath?: string | null): DevConfig {
  const pgDataDir = resolveDefaultEmbeddedPostgresDir();
  const defaults: DevConfig = {
    deploymentMode: "local_trusted",
    exposure: "private",
    bind: "loopback",
    host: "127.0.0.1",
    port: DEFAULT_API_PORT,
    pgDataDir,
    pgPort: DEFAULT_PG_PORT,
  };

  if (!overrideConfigPath) return defaults;

  try {
    const raw = JSON.parse(fs.readFileSync(overrideConfigPath, "utf8")) as Record<string, unknown>;
    const srv = (raw.server ?? {}) as Record<string, unknown>;
    const db = (raw.database ?? {}) as Record<string, unknown>;
    return {
      deploymentMode: typeof srv.deploymentMode === "string" ? srv.deploymentMode : defaults.deploymentMode,
      exposure: typeof srv.exposure === "string" ? srv.exposure : defaults.exposure,
      bind: typeof srv.bind === "string" ? srv.bind : defaults.bind,
      host: typeof srv.host === "string" ? srv.host : defaults.host,
      port: typeof srv.port === "number" ? srv.port : defaults.port,
      pgDataDir: typeof db.embeddedPostgresDataDir === "string" ? db.embeddedPostgresDataDir : defaults.pgDataDir,
      pgPort: typeof db.embeddedPostgresPort === "number" ? db.embeddedPostgresPort : defaults.pgPort,
    };
  } catch {
    return defaults;
  }
}

// ---- Embedded PostgreSQL detection ----

export interface PgProbeResult {
  pid: number | null;
  port: number;
  alive: boolean;
  source: "postmaster.pid" | "lsof";
}

export async function probeEmbeddedPg(pgDataDir: string, pgPort: number): Promise<PgProbeResult> {
  const pidFile = path.join(pgDataDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    try {
      const lines = fs.readFileSync(pidFile, "utf8").split("\n");
      const pid = parseInt(lines[0]?.trim() ?? "", 10);
      const portFromFile = parseInt(lines[3]?.trim() ?? "", 10);
      const port = Number.isFinite(portFromFile) && portFromFile > 0 ? portFromFile : pgPort;
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, port, alive: isPidAlive(pid), source: "postmaster.pid" };
      }
    } catch {
      // fall through to lsof
    }
  }
  const pid = await readLocalServicePortOwner(pgPort);
  return { pid, port: pgPort, alive: pid !== null, source: "lsof" };
}

// ---- Uptime formatting ----

export function formatUptime(since: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---- Status aggregation ----

export interface DevStatusReport {
  repoRoot: string;
  devMode: string;
  exposure: string;
  bind: string;
  host: string;
  apiPort: number;
  apiUrl: string;
  devRunner: {
    found: boolean;
    pid: number | null;
    childPid: number | null;
    mode: string | null;
    alive: boolean;
    startedAt: string | null;
    uptime: string | null;
  };
  apiPortOwner: number | null;
  stale: boolean;
  pg: PgProbeResult;
  recommendations: string[];
}

export async function buildDevStatus(
  repoRoot: string,
  records: Array<{
    pid: number;
    startedAt: string;
    metadata: Record<string, unknown> | null;
  }>,
  config: DevConfig,
  apiPort: number,
  apiPortOwner: number | null,
  pg: PgProbeResult,
): Promise<DevStatusReport> {
  const record = records[0] ?? null;

  const runnerPid = record?.pid ?? null;
  const runnerAlive = runnerPid !== null ? isPidAlive(runnerPid) : false;
  const childPid = typeof record?.metadata?.childPid === "number" ? record.metadata.childPid : null;
  const mode = typeof record?.metadata?.mode === "string" ? record.metadata.mode : null;

  const stale = !runnerAlive && apiPortOwner !== null;

  const modeLabel =
    config.deploymentMode === "authenticated"
      ? `authenticated/${config.exposure} (bind=${config.bind})`
      : "local_trusted";

  const apiUrl =
    config.deploymentMode === "authenticated" && config.bind !== "loopback"
      ? `http://${config.host}:${apiPort}`
      : `http://127.0.0.1:${apiPort}`;

  const recommendations: string[] = [];
  if (stale) {
    recommendations.push("watcher gone but listener bound — run `pnpm dev:stop --force`");
  } else if (!record && apiPortOwner === null) {
    recommendations.push("dev server is not running — start with `pnpm dev`");
  }

  return {
    repoRoot,
    devMode: modeLabel,
    exposure: config.exposure,
    bind: config.bind,
    host: config.host,
    apiPort,
    apiUrl,
    devRunner: {
      found: record !== null,
      pid: runnerPid,
      childPid,
      mode,
      alive: runnerAlive,
      startedAt: record?.startedAt ?? null,
      uptime: record?.startedAt && runnerAlive ? formatUptime(record.startedAt) : null,
    },
    apiPortOwner,
    stale,
    pg,
    recommendations,
  };
}
