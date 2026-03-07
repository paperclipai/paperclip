import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectProviders,
  detectAvailableProviders,
  createCustomProvider,
  getCloudSubdirectory,
  resolveCloudBackupDir,
  getProviderLabel,
} from '../../src/cloud-storage/provider-detector.js';

vi.mock('node:fs');
vi.mock('node:os');

describe('provider-detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
    vi.mocked(os.platform).mockReturnValue('linux');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectProviders', () => {
    it('should return entries for all known providers', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const providers = detectProviders();

      expect(providers.length).toBeGreaterThanOrEqual(4);
      const ids = providers.map((p) => p.provider);
      expect(ids).toContain('google-drive');
      expect(ids).toContain('icloud-drive');
      expect(ids).toContain('dropbox');
      expect(ids).toContain('onedrive');
    });

    it('should mark a provider as available when its sync directory exists', () => {
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (String(p) === path.join('/home/testuser', 'Dropbox')) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const dropbox = providers.find((p) => p.provider === 'dropbox');

      expect(dropbox).toBeDefined();
      expect(dropbox!.available).toBe(true);
      expect(dropbox!.path).toBe(path.join('/home/testuser', 'Dropbox'));
    });

    it('should mark a provider as unavailable when directory does not exist', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const dropbox = providers.find((p) => p.provider === 'dropbox');

      expect(dropbox).toBeDefined();
      expect(dropbox!.available).toBe(false);
    });

    it('should detect Google Drive on linux', () => {
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (String(p) === path.join('/home/testuser', 'Google Drive')) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const gd = providers.find((p) => p.provider === 'google-drive');

      expect(gd!.available).toBe(true);
    });

    it('should detect OneDrive', () => {
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (String(p) === path.join('/home/testuser', 'OneDrive')) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const od = providers.find((p) => p.provider === 'onedrive');

      expect(od!.available).toBe(true);
    });

    it('should handle macOS-specific paths for iCloud', () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      const icloudPath = path.join(
        '/home/testuser',
        'Library',
        'Mobile Documents',
        'com~apple~CloudDocs',
      );
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (String(p) === icloudPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const icloud = providers.find((p) => p.provider === 'icloud-drive');

      expect(icloud!.available).toBe(true);
      expect(icloud!.path).toBe(icloudPath);
    });

    it('should detect multiple providers simultaneously', () => {
      vi.mocked(fs.statSync).mockImplementation((p) => {
        const str = String(p);
        if (
          str === path.join('/home/testuser', 'Dropbox') ||
          str === path.join('/home/testuser', 'OneDrive')
        ) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const providers = detectProviders();
      const available = providers.filter((p) => p.available);

      expect(available.length).toBe(2);
      expect(available.map((p) => p.provider)).toContain('dropbox');
      expect(available.map((p) => p.provider)).toContain('onedrive');
    });
  });

  describe('detectAvailableProviders', () => {
    it('should return only available providers', () => {
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (String(p) === path.join('/home/testuser', 'Dropbox')) {
          return { isDirectory: () => true } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const available = detectAvailableProviders();

      expect(available.length).toBe(1);
      expect(available[0]!.provider).toBe('dropbox');
      expect(available[0]!.available).toBe(true);
    });

    it('should return empty array when nothing is available', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const available = detectAvailableProviders();
      expect(available).toEqual([]);
    });
  });

  describe('createCustomProvider', () => {
    it('should create a custom provider entry for an existing path', () => {
      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);

      const custom = createCustomProvider('/tmp/my-backup');

      expect(custom.provider).toBe('custom');
      expect(custom.label).toBe('Custom Directory');
      expect(custom.path).toBe('/tmp/my-backup');
      expect(custom.available).toBe(true);
    });

    it('should mark custom provider as unavailable if path does not exist', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const custom = createCustomProvider('/nonexistent/path');

      expect(custom.available).toBe(false);
    });
  });

  describe('getCloudSubdirectory', () => {
    it('should return the default subdirectory name', () => {
      expect(getCloudSubdirectory()).toBe('AgentVault-Backups');
    });
  });

  describe('resolveCloudBackupDir', () => {
    it('should join provider path with default subdirectory', () => {
      const result = resolveCloudBackupDir('/home/testuser/Dropbox');
      expect(result).toBe(
        path.join('/home/testuser/Dropbox', 'AgentVault-Backups'),
      );
    });

    it('should use custom subdirectory when provided', () => {
      const result = resolveCloudBackupDir(
        '/home/testuser/Dropbox',
        'my-custom-folder',
      );
      expect(result).toBe(
        path.join('/home/testuser/Dropbox', 'my-custom-folder'),
      );
    });
  });

  describe('getProviderLabel', () => {
    it('should return human-readable labels for all providers', () => {
      expect(getProviderLabel('google-drive')).toBe('Google Drive');
      expect(getProviderLabel('icloud-drive')).toBe('iCloud Drive');
      expect(getProviderLabel('dropbox')).toBe('Dropbox');
      expect(getProviderLabel('onedrive')).toBe('OneDrive');
      expect(getProviderLabel('custom')).toBe('Custom Directory');
    });
  });
});
