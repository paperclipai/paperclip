/**
 * Cloud Sync
 *
 * Archive and restore AgentVault data to/from a cloud-synced
 * local directory. Creates a self-contained folder with a JSON
 * manifest so any cloud provider can sync it as plain files.
 *
 * No blockchain, no crypto, no API keys — just files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { VERSION } from '../index.js';
import { resolveCloudBackupDir } from './provider-detector.js';
import type {
  CloudArchiveManifest,
  CloudArchiveFileEntry,
  CloudArchiveOptions,
  CloudArchiveResult,
  CloudRestoreResult,
  DiscoveredArchive,
} from './types.js';

const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_VERSION = '1.0';

/**
 * Return the default AgentVault data directory.
 */
export function getDefaultVaultDir(): string {
  return path.join(os.homedir(), '.agentvault');
}

/**
 * Compute SHA-256 hex digest of a buffer.
 */
function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Recursively collect all files under a directory.
 * Returns paths relative to `baseDir`.
 */
function collectFiles(baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(baseDir, full));
      }
    }
  }

  walk(baseDir);
  return results;
}

/**
 * Get the list of source directories/files to include,
 * scoped to a specific agent or the entire vault.
 */
function getSourcePaths(
  options: CloudArchiveOptions,
  vaultDir: string,
): { label: string; absPath: string }[] {
  const sources: { label: string; absPath: string }[] = [];
  const agentName = options.agentName;

  if (options.includeConfigs) {
    if (agentName) {
      sources.push({
        label: 'configs',
        absPath: path.join(vaultDir, 'agents', agentName),
      });
    } else {
      sources.push({
        label: 'configs',
        absPath: path.join(vaultDir, 'agents'),
      });
    }
  }

  if (options.includeWallets) {
    if (agentName) {
      sources.push({
        label: 'wallets',
        absPath: path.join(vaultDir, 'wallets', agentName),
      });
    } else {
      sources.push({
        label: 'wallets',
        absPath: path.join(vaultDir, 'wallets'),
      });
    }
  }

  if (options.includeBackups) {
    sources.push({
      label: 'backups',
      absPath: path.join(vaultDir, 'backups'),
    });
  }

  if (options.includeNetworks) {
    sources.push({
      label: 'networks',
      absPath: path.join(vaultDir, 'networks'),
    });
  }

  return sources;
}

/**
 * Archive AgentVault data to a cloud-synced directory.
 *
 * Creates a timestamped folder inside the cloud backup dir
 * containing a copy of the selected vault data plus a manifest.
 *
 * @param providerBasePath - Root path of the cloud provider sync directory
 * @param options - What to include in the archive
 * @param subdirectory - Subdirectory name inside provider (default: AgentVault-Backups)
 * @param vaultDir - Path to the AgentVault data directory (default: ~/.agentvault)
 */
export function archiveToCloud(
  providerBasePath: string,
  options: CloudArchiveOptions,
  subdirectory?: string,
  vaultDir?: string,
): CloudArchiveResult {
  try {
    const effectiveVaultDir = vaultDir || getDefaultVaultDir();
    const cloudDir = resolveCloudBackupDir(providerBasePath, subdirectory);
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');
    const folderName = options.agentName
      ? `${options.agentName}-${timestamp}`
      : `vault-${timestamp}`;
    const archiveDir = path.join(cloudDir, folderName);

    // Create archive directory
    fs.mkdirSync(archiveDir, { recursive: true });

    const sources = getSourcePaths(options, effectiveVaultDir);
    const fileEntries: CloudArchiveFileEntry[] = [];
    const components: string[] = [];
    let totalBytes = 0;

    for (const source of sources) {
      if (!fs.existsSync(source.absPath)) continue;

      const stat = fs.statSync(source.absPath);
      const componentDir = path.join(archiveDir, source.label);

      if (stat.isDirectory()) {
        const files = collectFiles(source.absPath);
        if (files.length === 0) continue;

        components.push(source.label);

        for (const relFile of files) {
          const srcFile = path.join(source.absPath, relFile);
          const destFile = path.join(componentDir, relFile);

          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          fs.copyFileSync(srcFile, destFile);

          const fileData = fs.readFileSync(destFile);
          fileEntries.push({
            relativePath: path.join(source.label, relFile),
            sizeBytes: fileData.length,
            checksum: sha256(fileData),
          });
          totalBytes += fileData.length;
        }
      } else {
        // Single file (e.g. a specific agent config)
        components.push(source.label);
        fs.mkdirSync(componentDir, { recursive: true });
        const destFile = path.join(componentDir, path.basename(source.absPath));
        fs.copyFileSync(source.absPath, destFile);

        const fileData = fs.readFileSync(destFile);
        fileEntries.push({
          relativePath: path.join(source.label, path.basename(source.absPath)),
          sizeBytes: fileData.length,
          checksum: sha256(fileData),
        });
        totalBytes += fileData.length;
      }
    }

    if (fileEntries.length === 0) {
      // Clean up empty dir
      fs.rmSync(archiveDir, { recursive: true, force: true });
      return {
        success: false,
        error: 'No data found to archive. Check that ~/.agentvault contains data.',
      };
    }

    // Compute overall checksum from sorted file checksums
    const overallChecksum = sha256(
      Buffer.from(
        fileEntries
          .map((f) => f.checksum)
          .sort()
          .join(''),
      ),
    );

    const manifest: CloudArchiveManifest = {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      platform: os.platform(),
      hostname: os.hostname(),
      agentVaultVersion: VERSION,
      agentName: options.agentName,
      components,
      files: fileEntries,
      checksum: overallChecksum,
    };

    const manifestPath = path.join(archiveDir, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
      success: true,
      archivePath: archiveDir,
      manifestPath,
      fileCount: fileEntries.length,
      totalBytes,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * List available archives in a cloud backup directory.
 */
export function listCloudArchives(
  providerBasePath: string,
  subdirectory?: string,
): DiscoveredArchive[] {
  const cloudDir = resolveCloudBackupDir(providerBasePath, subdirectory);

  if (!fs.existsSync(cloudDir)) {
    return [];
  }

  const entries = fs.readdirSync(cloudDir, { withFileTypes: true });
  const archives: DiscoveredArchive[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(cloudDir, entry.name, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as CloudArchiveManifest;

      archives.push({
        manifestPath,
        archivePath: path.join(cloudDir, entry.name),
        manifest,
      });
    } catch {
      // Skip malformed manifests
    }
  }

  // Sort newest first
  archives.sort(
    (a, b) =>
      new Date(b.manifest.createdAt).getTime() -
      new Date(a.manifest.createdAt).getTime(),
  );

  return archives;
}

/**
 * Restore AgentVault data from a cloud archive.
 *
 * Copies files from the archive back into the vault directory,
 * verifying checksums along the way.
 *
 * @param archivePath - Path to the archive directory
 * @param overwrite - Whether to overwrite existing files
 * @param vaultDir - Path to the AgentVault data directory (default: ~/.agentvault)
 */
export function restoreFromCloud(
  archivePath: string,
  overwrite: boolean = false,
  vaultDir?: string,
): CloudRestoreResult {
  try {
    const effectiveVaultDir = vaultDir || getDefaultVaultDir();
    const manifestPath = path.join(archivePath, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      return {
        success: false,
        warnings: [],
        error: `No manifest found at ${manifestPath}`,
      };
    }

    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as CloudArchiveManifest;
    const warnings: string[] = [];
    let restoredFiles = 0;

    // Component-to-vault-dir mapping
    const componentDirMap: Record<string, string> = {
      configs: 'agents',
      wallets: 'wallets',
      backups: 'backups',
      networks: 'networks',
    };

    for (const fileEntry of manifest.files) {
      const srcFile = path.join(archivePath, fileEntry.relativePath);

      if (!fs.existsSync(srcFile)) {
        warnings.push(`Missing file in archive: ${fileEntry.relativePath}`);
        continue;
      }

      // Verify checksum
      const fileData = fs.readFileSync(srcFile);
      const actualChecksum = sha256(fileData);
      if (actualChecksum !== fileEntry.checksum) {
        warnings.push(
          `Checksum mismatch for ${fileEntry.relativePath} (expected ${fileEntry.checksum.slice(0, 8)}..., got ${actualChecksum.slice(0, 8)}...)`,
        );
        continue;
      }

      // Determine destination: map component prefix to vault dir
      const firstSlash = fileEntry.relativePath.indexOf(path.sep);
      // Handle both / and path.sep for cross-platform paths in manifests
      const firstSlashAlt = fileEntry.relativePath.indexOf('/');
      const slashIdx =
        firstSlash >= 0 && firstSlashAlt >= 0
          ? Math.min(firstSlash, firstSlashAlt)
          : Math.max(firstSlash, firstSlashAlt);

      if (slashIdx < 0) {
        warnings.push(`Skipping file with no component prefix: ${fileEntry.relativePath}`);
        continue;
      }

      const component = fileEntry.relativePath.slice(0, slashIdx);
      const restOfPath = fileEntry.relativePath.slice(slashIdx + 1);
      const vaultSubdir = componentDirMap[component];

      if (!vaultSubdir) {
        warnings.push(`Unknown component "${component}" for ${fileEntry.relativePath}`);
        continue;
      }

      const destFile = path.join(effectiveVaultDir, vaultSubdir, restOfPath);

      if (fs.existsSync(destFile) && !overwrite) {
        warnings.push(`Skipping existing file (use --overwrite): ${destFile}`);
        continue;
      }

      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(srcFile, destFile);
      restoredFiles++;
    }

    return {
      success: true,
      restoredFiles,
      components: manifest.components,
      warnings,
    };
  } catch (error) {
    return {
      success: false,
      warnings: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Verify integrity of a cloud archive by checking all file checksums.
 */
export function verifyCloudArchive(
  archivePath: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const manifestPath = path.join(archivePath, MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: ['Manifest file not found'] };
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as CloudArchiveManifest;

    for (const fileEntry of manifest.files) {
      const filePath = path.join(archivePath, fileEntry.relativePath);

      if (!fs.existsSync(filePath)) {
        errors.push(`Missing: ${fileEntry.relativePath}`);
        continue;
      }

      const fileData = fs.readFileSync(filePath);
      const actualChecksum = sha256(fileData);

      if (actualChecksum !== fileEntry.checksum) {
        errors.push(
          `Checksum mismatch: ${fileEntry.relativePath}`,
        );
      }
    }

    // Verify overall checksum
    const expectedOverall = sha256(
      Buffer.from(
        manifest.files
          .map((f) => f.checksum)
          .sort()
          .join(''),
      ),
    );

    if (expectedOverall !== manifest.checksum) {
      errors.push('Overall archive checksum mismatch');
    }

    return { valid: errors.length === 0, errors };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}
