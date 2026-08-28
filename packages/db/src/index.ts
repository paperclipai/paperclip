export {
  createDb,
  closeRegisteredClients,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
  isPostgresStartingUpError,
  isPostgresConnectionUnavailableError,
  isPostgresNotReadyError,
  waitForPostgresReady,
  type WaitForPostgresReadyOptions,
} from "./client.js";
export {
  POSTMASTER_LOCK_FILE_NAME,
  postmasterLockFilePath,
  readPostmasterLockFile,
  probeProcessLiveness,
  canonicalizeDataDirectory,
  inspectPostmasterLock,
  decideEmbeddedPostgresStart,
  type PostmasterLockFile,
  type PostmasterLockStatus,
  type ProcessLiveness,
  type PortHolderIdentity,
  type EmbeddedPostgresStartDecision,
} from "./embedded-postgres-lock.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export {
  DEFAULT_EMBEDDED_POSTGRES_START_TIMEOUT_MS,
  DEFAULT_EMBEDDED_POSTGRES_STOP_TIMEOUT_MS,
  EmbeddedPostgresStartTimeoutError,
  EmbeddedPostgresStopTimeoutError,
  hasEmbeddedPostgresProcessExited,
  loadWithoutEmbeddedPostgresExitHooks,
  startEmbeddedPostgresWithin,
  stopEmbeddedPostgresWithin,
  type EmbeddedPostgresChildProcess,
  type EmbeddedPostgresLifecycle,
  type StartEmbeddedPostgresOptions,
  type StopEmbeddedPostgresOptions,
  type StopEmbeddedPostgresOutcome,
} from "./embedded-postgres-lifecycle.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
