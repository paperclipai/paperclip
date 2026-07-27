import {
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipHomePath,
  resolvePaperclipInstanceConfigPath,
  resolvePaperclipInstancePath,
  resolveUserHomePath,
} from "./home-paths.js";

export type StateDisposition = "git" | "s3_bulk" | "s3_secret" | "db" | "cache" | "ephemeral";
export type StateRedactionClass = "none" | "secret_refs" | "forbid";
export type StateCopyConsistency = "plain" | "sqlite_backup";

export type StateManifestContext = { homeDir?: string; instanceId?: string };
export type StateClassEntry = {
  id: string;
  resolve(ctx: StateManifestContext): string[];
  disposition: StateDisposition;
  redact: StateRedactionClass;
  consistency: StateCopyConsistency;
  retention?: { days?: number };
};

const home = (ctx: StateManifestContext, ...segments: string[]) => resolvePaperclipHomePath(ctx, ...segments);
const instance = (ctx: StateManifestContext, ...segments: string[]) => resolvePaperclipInstancePath(ctx, ...segments);

export const STATE_MANIFEST: readonly StateClassEntry[] = [
  { id: "cli_auth_context", resolve: (ctx) => [home(ctx, "auth.json"), home(ctx, "context.json")], disposition: "s3_secret", redact: "forbid", consistency: "plain" },
  { id: "plugin_install_set", resolve: (ctx) => [home(ctx, "adapter-plugins.json"), home(ctx, "adapter-plugins"), home(ctx, "plugins")], disposition: "git", redact: "secret_refs", consistency: "plain" },
  { id: "adapter_state", resolve: (ctx) => [home(ctx, "adapter-state")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain" },
  { id: "host_secrets", resolve: (ctx) => [home(ctx, "secrets")], disposition: "s3_secret", redact: "forbid", consistency: "plain" },
  { id: "host_maintenance", resolve: (ctx) => [home(ctx, "maintenance"), home(ctx, "hot-restart-report.json")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 30 } },
  { id: "host_ephemeral", resolve: (ctx) => [home(ctx, "feedback-artifacts"), home(ctx, "scratch"), home(ctx, "tmp"), home(ctx, "worktrees"), home(ctx, "migration-backups")], disposition: "ephemeral", redact: "none", consistency: "plain", retention: { days: 7 } },
  { id: "instance_config", resolve: (ctx) => [resolvePaperclipInstanceConfigPath(ctx), instance(ctx, ".env")], disposition: "git", redact: "secret_refs", consistency: "plain" },
  { id: "database", resolve: (ctx) => [resolveDefaultEmbeddedPostgresDir(ctx)], disposition: "db", redact: "forbid", consistency: "plain" },
  { id: "attachment_storage", resolve: (ctx) => [resolveDefaultStorageDir(ctx)], disposition: "s3_bulk", redact: "none", consistency: "plain" },
  { id: "run_logs", resolve: (ctx) => [instance(ctx, "data", "run-logs")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 90 } },
  { id: "local_backup_staging", resolve: (ctx) => [instance(ctx, "data", "backups"), instance(ctx, "data", "instance-backups")], disposition: "cache", redact: "forbid", consistency: "plain", retention: { days: 30 } },
  { id: "agent_instructions_bundle", resolve: (ctx) => [instance(ctx, "companies", "*", "agents", "*", "instructions")], disposition: "git", redact: "secret_refs", consistency: "plain" },
  { id: "secrets_master_key", resolve: (ctx) => [resolveDefaultSecretsKeyFilePath(ctx)], disposition: "s3_secret", redact: "forbid", consistency: "plain" },
  { id: "codex_agent_home", resolve: (ctx) => [instance(ctx, "companies", "*", "agents", "*", "codex-home"), instance(ctx, "companies", "*", "codex-home")], disposition: "s3_bulk", redact: "forbid", consistency: "sqlite_backup" },
  { id: "runtime_materializations", resolve: (ctx) => [instance(ctx, "companies", "*", "acp-engine"), instance(ctx, "companies", "*", "acpx-local"), instance(ctx, "companies", "*", "claude-prompt-cache")], disposition: "cache", redact: "secret_refs", consistency: "plain" },
  { id: "skill_bundles", resolve: (ctx) => [instance(ctx, "skills", "*")], disposition: "git", redact: "secret_refs", consistency: "plain" },
  { id: "project_repositories", resolve: (ctx) => [instance(ctx, "projects", "*", "*", "*")], disposition: "git", redact: "forbid", consistency: "plain" },
  { id: "execution_workspaces", resolve: (ctx) => [instance(ctx, "workspaces", "*")], disposition: "ephemeral", redact: "forbid", consistency: "plain", retention: { days: 7 } },
  { id: "instance_logs", resolve: (ctx) => [instance(ctx, "logs")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 30 } },
  { id: "claude_memory", resolve: () => [resolveUserHomePath(".claude", "projects", "**", "memory", "**")], disposition: "git", redact: "secret_refs", consistency: "plain" },
  { id: "claude_transcripts", resolve: () => [resolveUserHomePath(".claude", "projects", "**", "*.jsonl")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 90 } },
  { id: "claude_runtime_state", resolve: () => [resolveUserHomePath(".claude", "history.jsonl"), resolveUserHomePath(".claude", "todos"), resolveUserHomePath(".claude", "session-env")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 30 } },
  { id: "claude_cache", resolve: () => [resolveUserHomePath(".claude", "cache"), resolveUserHomePath(".claude", "debug"), resolveUserHomePath(".claude", "shell-snapshots"), resolveUserHomePath(".claude", "statsig")], disposition: "cache", redact: "none", consistency: "plain", retention: { days: 7 } },
  { id: "external_cli_homes", resolve: () => [resolveUserHomePath(".codex"), resolveUserHomePath(".gemini")], disposition: "s3_secret", redact: "forbid", consistency: "plain" },
] as const;

export function getStateManifestEntry(id: string): StateClassEntry | undefined {
  return STATE_MANIFEST.find((entry) => entry.id === id);
}
