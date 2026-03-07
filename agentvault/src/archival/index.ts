/**
 * Archival Module
 *
 * Exports archival functionality.
 */

export * from './arweave-client.js';
export {
  type ArchiveMetadata,
  type ArchiveOptions,
  prepareArchive,
  markArchiveUploading,
  updateArchiveTransaction,
  confirmArchive,
  failArchive,
  getArchive,
  listArchives,
  listPendingArchives,
  getArchiveData,
  deleteArchive,
  getArchiveStats,
  verifyArchive,
} from './archive-manager.js';
export type { ArchiveResult as ManagerArchiveResult } from './archive-manager.js';
export {
  ArweaveArchiver,
  type ArweaveBundle,
  type ArweaveBundleManifest,
  type ArchiverOptions,
  type HeartbeatOptions,
  type VerifyResult,
} from './arweave-archiver.js';
export type { ArchiveResult as ArchiverArchiveResult } from './arweave-archiver.js';
