import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import { expandHomePrefix } from "../config/home.js";

export const DEFAULT_WORKTREE_HOME = "~/.paperclip-worktrees";
export const WORKTREE_SEED_MODES = ["minimal", "full"] as const;

export type WorktreeSeedMode = (typeof WORKTREE_SEED_MODES)[number];

export type WorktreeSeedPlan = {
  mode: WorktreeSeedMode;
  excludedTables: string[];
  nullifyColumns: Record<string, string[]>;
};

const MINIMAL_WORKTREE_EXCLUDED_TABLES = [
  "activity_log",
  "agent_runtime_state",
  "agent_task_sessions",
  "agent_wakeup_requests",
  "cost_events",
  "heartbeat_run_events",
  "heartbeat_runs",
  "workspace_runtime_services",
];

const MINIMAL_WORKTREE_NULLIFIED_COLUMNS: Record<string, string[]> = {
  issues: ["checkout_run_id", "execution_run_id"],
};

export type WorktreeLocalPaths = {
  cwd: string;
  repoConfigDir: string;
  configPath: string;
  envPath: string;
  homeDir: string;
  instanceId: string;
  instanceRoot: string;
  contextPath: string;
  embeddedPostgresDataDir: string;
  backupDir: string;
  logDir: string;
  secretsKeyFilePath: string;
  storageDir: string;
};

export function isWorktreeSeedMode(value: string): value is WorktreeSeedMode {
  return (WORKTREE_SEED_MODES as readonly string[]).includes(value);
}

export function resolveWorktreeSeedPlan(mode: WorktreeSeedMode): WorktreeSeedPlan {
  if (mode === "full") {
    return {
      mode,
      excludedTables: [],
      nullifyColumns: {},
    };
  }
  return {
    mode,
    excludedTables: [...MINIMAL_WORKTREE_EXCLUDED_TABLES],
    nullifyColumns: {
      ...MINIMAL_WORKTREE_NULLIFIED_COLUMNS,
    },
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

export function sanitizeWorktreeInstanceId(rawValue: string): string {
  const trimmed = rawValue.trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "worktree";
}

export function resolveSuggestedWorktreeName(cwd: string, explicitName?: string): string {
  return nonEmpty(explicitName) ?? path.basename(path.resolve(cwd));
}

export function resolveWorktreeLocalPaths(opts: {
  cwd: string;
  homeDir?: string;
  instanceId: string;
}): WorktreeLocalPaths {
  const cwd = path.resolve(opts.cwd);
  const homeDir = path.resolve(expandHomePrefix(opts.homeDir ?? DEFAULT_WORKTREE_HOME));
  const instanceRoot = path.resolve(homeDir, "instances", opts.instanceId);
  const repoConfigDir = path.resolve(cwd, ".paperclip");
  return {
    cwd,
    repoConfigDir,
    configPath: path.resolve(repoConfigDir, "config.json"),
    envPath: path.resolve(repoConfigDir, ".env"),
    homeDir,
    instanceId: opts.instanceId,
    instanceRoot,
    contextPath: path.resolve(homeDir, "context.json"),
    embeddedPostgresDataDir: path.resolve(instanceRoot, "db"),
    backupDir: path.resolve(instanceRoot, "data", "backups"),
    logDir: path.resolve(instanceRoot, "logs"),
    secretsKeyFilePath: path.resolve(instanceRoot, "secrets", "master.key"),
    storageDir: path.resolve(instanceRoot, "data", "storage"),
  };
}

export function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    if (!isLoopbackHost(parsed.hostname)) return rawUrl;
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function buildWorktreeConfig(input: {
  sourceConfig: PaperclipConfig | null;
  paths: WorktreeLocalPaths;
  serverPort: number;
  databasePort: number;
  now?: Date;
}): PaperclipConfig {
  const { sourceConfig, paths, serverPort, databasePort } = input;
  const nowIso = (input.now ?? new Date()).toISOString();

  const source = sourceConfig;
  const authPublicBaseUrl = rewriteLocalUrlPort(source?.auth.publicBaseUrl, serverPort);

  return {
    $meta: {
      version: 1,
      updatedAt: nowIso,
      source: "configure",
    },
    ...(source?.llm ? { llm: source.llm } : {}),
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: paths.embeddedPostgresDataDir,
      embeddedPostgresPort: databasePort,
      backup: {
        enabled: source?.database.backup.enabled ?? true,
        intervalMinutes: source?.database.backup.intervalMinutes ?? 60,
        retentionDays: source?.database.backup.retentionDays ?? 30,
        dir: paths.backupDir,
      },
    },
    logging: {
      mode: source?.logging.mode ?? "file",
      logDir: paths.logDir,
    },
    server: {
      deploymentMode: source?.server.deploymentMode ?? "local_trusted",
      exposure: source?.server.exposure ?? "private",
      host: source?.server.host ?? "127.0.0.1",
      port: serverPort,
      allowedHostnames: source?.server.allowedHostnames ?? [],
      serveUi: source?.server.serveUi ?? true,
    },
    auth: {
      baseUrlMode: source?.auth.baseUrlMode ?? "auto",
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
      disableSignUp: source?.auth.disableSignUp ?? false,
    },
    storage: {
      provider: source?.storage.provider ?? "local_disk",
      localDisk: {
        baseDir: paths.storageDir,
      },
      s3: {
        bucket: source?.storage.s3.bucket ?? "paperclip",
        region: source?.storage.s3.region ?? "us-east-1",
        endpoint: source?.storage.s3.endpoint,
        prefix: source?.storage.s3.prefix ?? "",
        forcePathStyle: source?.storage.s3.forcePathStyle ?? false,
      },
    },
    secrets: {
      provider: source?.secrets.provider ?? "local_encrypted",
      strictMode: source?.secrets.strictMode ?? false,
      localEncrypted: {
        keyFilePath: paths.secretsKeyFilePath,
      },
    },
  };
}

export function buildWorktreeEnvEntries(paths: WorktreeLocalPaths): Record<string, string> {
  return {
    PAPERCLIP_HOME: paths.homeDir,
    PAPERCLIP_INSTANCE_ID: paths.instanceId,
    PAPERCLIP_CONFIG: paths.configPath,
    PAPERCLIP_CONTEXT: paths.contextPath,
    PAPERCLIP_IN_WORKTREE: "true",
  };
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function formatShellExports(entries: Record<string, string>): string {
  return Object.entries(entries)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
    .join("\n");
}
