import os from "node:os";
import path from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

/** Returns the Paperclip home directory, respecting `PAPERCLIP_HOME` env override. */
export function resolvePaperclipHomeDir(): string {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".paperclip");
}

/** Returns the validated Paperclip instance ID from `PAPERCLIP_INSTANCE_ID` env (defaults to "default"). */
export function resolvePaperclipInstanceId(): string {
  const raw = process.env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

/** Returns the root directory for the current Paperclip instance. */
export function resolvePaperclipInstanceRoot(): string {
  return path.resolve(resolvePaperclipHomeDir(), "instances", resolvePaperclipInstanceId());
}

/** Returns the default config.json path for the current instance. */
export function resolveDefaultConfigPath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "config.json");
}

/** Returns the default embedded Postgres data directory for the current instance. */
export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "db");
}

/** Returns the default logs directory for the current instance. */
export function resolveDefaultLogsDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "logs");
}

/** Returns the default master secrets key file path for the current instance. */
export function resolveDefaultSecretsKeyFilePath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "secrets", "master.key");
}

/** Returns the default file storage directory for the current instance. */
export function resolveDefaultStorageDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "storage");
}

/** Returns the default backup directory for the current instance. */
export function resolveDefaultBackupDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "backups");
}

/** Returns the workspace directory for a given agent ID under the current instance. */
export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);
}

function sanitizeFriendlyPathSegment(value: string | null | undefined, fallback = "_default"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(FRIENDLY_PATH_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

/** Returns the workspace directory for a managed project, scoped by company, project, and optional repo name. */
export function resolveManagedProjectWorkspaceDir(input: {
  companyId: string;
  projectId: string;
  repoName?: string | null;
}): string {
  const companyId = input.companyId.trim();
  const projectId = input.projectId.trim();
  if (!companyId || !projectId) {
    throw new Error("Managed project workspace path requires companyId and projectId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(projectId, "project"),
    sanitizeFriendlyPathSegment(input.repoName, "_default"),
  );
}

/** Resolves a path, expanding a leading `~` to the user's home directory. */
export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
