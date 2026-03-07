/**
 * Cloud Provider Detector
 *
 * Auto-detects consumer cloud storage providers by checking for
 * their well-known local sync directories on the current platform.
 * No API keys, no SDK installs — just plain filesystem checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CloudProvider, DetectedProvider } from './types.js';

interface ProviderCandidate {
  provider: CloudProvider;
  label: string;
  paths: string[];
}

/**
 * Build the list of well-known sync directory paths per provider.
 * Paths vary by OS, so we enumerate all known locations.
 */
function getCandidates(): ProviderCandidate[] {
  const home = os.homedir();
  const platform = os.platform();

  const candidates: ProviderCandidate[] = [
    {
      provider: 'google-drive',
      label: 'Google Drive',
      paths: [
        path.join(home, 'Google Drive'),
        path.join(home, 'My Drive'),
        ...(platform === 'darwin'
          ? [
              path.join(home, 'Library', 'CloudStorage', 'GoogleDrive'),
              path.join(
                home,
                'Library',
                'CloudStorage',
                'GoogleDrive-My Drive',
              ),
            ]
          : []),
        ...(platform === 'win32'
          ? [path.join('G:', 'My Drive')]
          : []),
      ],
    },
    {
      provider: 'icloud-drive',
      label: 'iCloud Drive',
      paths:
        platform === 'darwin'
          ? [
              path.join(
                home,
                'Library',
                'Mobile Documents',
                'com~apple~CloudDocs',
              ),
            ]
          : platform === 'win32'
            ? [
                path.join(home, 'iCloudDrive'),
                path.join(
                  process.env['USERPROFILE'] || home,
                  'iCloudDrive',
                ),
              ]
            : [],
    },
    {
      provider: 'dropbox',
      label: 'Dropbox',
      paths: [
        path.join(home, 'Dropbox'),
        ...(platform === 'win32'
          ? [path.join('D:', 'Dropbox')]
          : []),
      ],
    },
    {
      provider: 'onedrive',
      label: 'OneDrive',
      paths: [
        path.join(home, 'OneDrive'),
        ...(platform === 'win32'
          ? [
              path.join(
                process.env['USERPROFILE'] || home,
                'OneDrive',
              ),
            ]
          : []),
        ...(platform === 'darwin'
          ? [
              path.join(home, 'Library', 'CloudStorage', 'OneDrive'),
            ]
          : []),
      ],
    },
  ];

  return candidates;
}

/**
 * Check if a directory exists and is accessible.
 */
function directoryExists(dirPath: string): boolean {
  try {
    const stat = fs.statSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect all available cloud storage providers on this machine.
 * Returns one entry per provider, using the first matching path found.
 */
export function detectProviders(): DetectedProvider[] {
  const candidates = getCandidates();
  const results: DetectedProvider[] = [];

  for (const candidate of candidates) {
    let foundPath: string | null = null;

    for (const candidatePath of candidate.paths) {
      if (directoryExists(candidatePath)) {
        foundPath = candidatePath;
        break;
      }
    }

    results.push({
      provider: candidate.provider,
      label: candidate.label,
      path: foundPath || candidate.paths[0] || '',
      available: foundPath !== null,
    });
  }

  return results;
}

/**
 * Detect only available (installed/syncing) providers.
 */
export function detectAvailableProviders(): DetectedProvider[] {
  return detectProviders().filter((p) => p.available);
}

/**
 * Get the default AgentVault subdirectory name inside a cloud provider.
 */
export function getCloudSubdirectory(): string {
  return 'AgentVault-Backups';
}

/**
 * Resolve the full cloud backup directory for a given provider path.
 */
export function resolveCloudBackupDir(
  providerPath: string,
  subdirectory?: string,
): string {
  return path.join(providerPath, subdirectory || getCloudSubdirectory());
}

/**
 * Build a DetectedProvider for a custom/user-specified path.
 */
export function createCustomProvider(customPath: string): DetectedProvider {
  return {
    provider: 'custom',
    label: 'Custom Directory',
    path: customPath,
    available: directoryExists(customPath),
  };
}

/**
 * Get a human-readable label for a provider.
 */
export function getProviderLabel(provider: CloudProvider): string {
  const labels: Record<CloudProvider, string> = {
    'google-drive': 'Google Drive',
    'icloud-drive': 'iCloud Drive',
    'dropbox': 'Dropbox',
    'onedrive': 'OneDrive',
    'custom': 'Custom Directory',
  };
  return labels[provider];
}
