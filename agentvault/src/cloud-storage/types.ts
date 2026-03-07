/**
 * Cloud Storage Types
 *
 * Types for the cloud storage backup feature that lets users
 * archive and restore AgentVault data using consumer cloud
 * storage providers (Google Drive, iCloud, Dropbox, etc.)
 * via their local sync directories — no crypto required.
 */

/**
 * Supported cloud storage providers detected via local sync directories.
 */
export type CloudProvider =
  | 'google-drive'
  | 'icloud-drive'
  | 'dropbox'
  | 'onedrive'
  | 'custom';

/**
 * A detected cloud provider with its local sync path.
 */
export interface DetectedProvider {
  provider: CloudProvider;
  label: string;
  path: string;
  available: boolean;
}

/**
 * Configuration for cloud backup destination.
 */
export interface CloudBackupConfig {
  provider: CloudProvider;
  basePath: string;
  subdirectory: string;
}

/**
 * What to include in a cloud backup archive.
 */
export interface CloudArchiveOptions {
  agentName?: string;
  includeConfigs: boolean;
  includeWallets: boolean;
  includeBackups: boolean;
  includeNetworks: boolean;
}

/**
 * Metadata written alongside the archive for identification and integrity.
 */
export interface CloudArchiveManifest {
  version: string;
  createdAt: string;
  platform: string;
  hostname: string;
  agentVaultVersion: string;
  agentName?: string;
  components: string[];
  files: CloudArchiveFileEntry[];
  checksum: string;
}

/**
 * Entry for a single file within the archive manifest.
 */
export interface CloudArchiveFileEntry {
  relativePath: string;
  sizeBytes: number;
  checksum: string;
}

/**
 * Result of an archive operation.
 */
export interface CloudArchiveResult {
  success: boolean;
  archivePath?: string;
  manifestPath?: string;
  fileCount?: number;
  totalBytes?: number;
  error?: string;
}

/**
 * Result of a restore operation.
 */
export interface CloudRestoreResult {
  success: boolean;
  restoredFiles?: number;
  components?: string[];
  warnings: string[];
  error?: string;
}

/**
 * A discovered archive available for restore.
 */
export interface DiscoveredArchive {
  manifestPath: string;
  archivePath: string;
  manifest: CloudArchiveManifest;
}
