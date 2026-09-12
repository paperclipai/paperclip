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
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
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
  STORAGE_TRANSACTION_LOCK_SCHEMA,
  STORAGE_TRANSACTION_RESERVED_PREFIX,
  STORAGE_TRANSACTION_LOCK_DIR_NAME,
  STORAGE_TRANSACTION_RECOVERY_MUTEX_NAME,
  STORAGE_TRANSACTION_PARTICIPATION_NAME,
  STORAGE_TRANSACTION_TMP_PREFIX,
  STORAGE_TRANSACTION_QUARANTINE_PREFIX,
  StorageTransactionLockError,
  acquireStorageTransactionLock,
  assertStorageTransactionLockHeld,
  releaseStorageTransactionLock,
  markStorageTransactionParticipationReady,
  readStorageTransactionParticipation,
  parseStorageTransactionOwnerRecord,
  parseStorageTransactionParticipationRecord,
  isStorageTransactionReservedName,
  isStorageTransactionReservedPath,
  resolveSourceRootRealPath,
  readLocalMachineId,
  readLocalBootId,
  readProcessStartId,
  resolveStorageTransactionIdentity,
  classifyPaperclipParticipation,
  type StorageTransactionLockHandle,
  type StorageTransactionOwnerRecord,
  type StorageTransactionParticipationRecord,
  type StorageTransactionOperationKind,
} from "./backup-transaction-lock.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
