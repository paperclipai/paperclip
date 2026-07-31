export interface MigrationEnvSnapshot {
  PAPERCLIP_MIGRATION_AUTO_APPLY?: string | undefined;
  PAPERCLIP_MIGRATION_PROMPT?: string | undefined;
  [key: string]: string | undefined;
}

export interface MigrationEnvOptions {
  autoMigrate: boolean;
}

export interface MigrationEnvUpdates {
  PAPERCLIP_MIGRATION_AUTO_APPLY?: string;
  PAPERCLIP_MIGRATION_PROMPT?: string;
}

/**
 * Decide which migration-related env vars `paperclipai run` should set
 * before importing the server.
 *
 * Rules:
 * - `--no-auto-migrate` (autoMigrate=false): force `PAPERCLIP_MIGRATION_PROMPT=never`
 *   so the server refuses to start against a stale schema and prints a clear
 *   "run pnpm db:migrate" error instead of hanging on a stdin prompt.
 * - Otherwise (autoMigrate=true, the default): set
 *   `PAPERCLIP_MIGRATION_AUTO_APPLY=true` ONLY when neither env var is already
 *   set by the caller. This preserves explicit user intent — if a user has
 *   `PAPERCLIP_MIGRATION_PROMPT=never` exported, we honor it; we never override.
 */
export function resolveMigrationEnvUpdates(
  env: MigrationEnvSnapshot,
  opts: MigrationEnvOptions,
): MigrationEnvUpdates {
  if (!opts.autoMigrate) {
    return { PAPERCLIP_MIGRATION_PROMPT: "never" };
  }
  const autoApplySet = typeof env.PAPERCLIP_MIGRATION_AUTO_APPLY === "string"
    && env.PAPERCLIP_MIGRATION_AUTO_APPLY.length > 0;
  const promptSet = typeof env.PAPERCLIP_MIGRATION_PROMPT === "string"
    && env.PAPERCLIP_MIGRATION_PROMPT.length > 0;
  if (autoApplySet || promptSet) return {};
  return { PAPERCLIP_MIGRATION_AUTO_APPLY: "true" };
}

export function applyMigrationEnvUpdates(
  env: NodeJS.ProcessEnv,
  updates: MigrationEnvUpdates,
): void {
  if (updates.PAPERCLIP_MIGRATION_AUTO_APPLY !== undefined) {
    env.PAPERCLIP_MIGRATION_AUTO_APPLY = updates.PAPERCLIP_MIGRATION_AUTO_APPLY;
  }
  if (updates.PAPERCLIP_MIGRATION_PROMPT !== undefined) {
    env.PAPERCLIP_MIGRATION_PROMPT = updates.PAPERCLIP_MIGRATION_PROMPT;
  }
}
