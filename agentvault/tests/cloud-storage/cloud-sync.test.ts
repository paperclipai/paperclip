import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  archiveToCloud,
  listCloudArchives,
  restoreFromCloud,
  verifyCloudArchive,
} from '../../src/cloud-storage/cloud-sync.js';

/**
 * Fully self-contained integration tests using temporary directories.
 * No reads or writes to the real ~/.agentvault/ directory.
 */
describe('cloud-sync', () => {
  let tmpDir: string;
  let cloudDir: string;
  let fakeVaultDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-cloud-test-'));
    cloudDir = path.join(tmpDir, 'cloud-provider');
    fakeVaultDir = path.join(tmpDir, 'fake-vault');

    fs.mkdirSync(cloudDir, { recursive: true });
    fs.mkdirSync(fakeVaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed a fake vault structure inside our temp directory.
   */
  function seedVault(): void {
    // agents/my-agent/agent.json
    const agentsDir = path.join(fakeVaultDir, 'agents', 'my-agent');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'agent.json'),
      JSON.stringify({ name: 'my-agent', type: 'generic' }),
    );

    // wallets/my-agent/default.wallet
    const walletsDir = path.join(fakeVaultDir, 'wallets', 'my-agent');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletsDir, 'default.wallet'),
      Buffer.from('fake-wallet-data'),
    );

    // backups/my-agent-backup.json
    const backupsDir = path.join(fakeVaultDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupsDir, 'my-agent-backup.json'),
      JSON.stringify({ agentName: 'my-agent', version: '1.0' }),
    );

    // networks/local.yaml
    const networksDir = path.join(fakeVaultDir, 'networks');
    fs.mkdirSync(networksDir, { recursive: true });
    fs.writeFileSync(
      path.join(networksDir, 'local.yaml'),
      'name: local\nurl: http://127.0.0.1:4943\n',
    );
  }

  describe('archiveToCloud', () => {
    it('should return error when vault is empty', () => {
      const result = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: true,
          includeBackups: true,
          includeNetworks: true,
        },
        undefined,
        fakeVaultDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No data found');
    });

    it('should archive all components from vault', () => {
      seedVault();

      const result = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: true,
          includeBackups: true,
          includeNetworks: true,
        },
        undefined,
        fakeVaultDir,
      );

      expect(result.success).toBe(true);
      expect(result.archivePath).toBeDefined();
      expect(result.fileCount).toBe(4);
      expect(result.totalBytes).toBeGreaterThan(0);

      // Manifest should exist and be valid
      const manifestPath = path.join(result.archivePath!, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.version).toBe('1.0');
      expect(manifest.components).toContain('configs');
      expect(manifest.components).toContain('wallets');
      expect(manifest.components).toContain('backups');
      expect(manifest.components).toContain('networks');
      expect(manifest.files.length).toBe(4);
      expect(manifest.checksum).toBeDefined();
    });

    it('should archive a specific agent only', () => {
      seedVault();

      const result = archiveToCloud(
        cloudDir,
        {
          agentName: 'my-agent',
          includeConfigs: true,
          includeWallets: true,
          includeBackups: false,
          includeNetworks: false,
        },
        undefined,
        fakeVaultDir,
      );

      expect(result.success).toBe(true);
      expect(result.fileCount).toBe(2); // agent.json + default.wallet

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath!, 'utf8'));
      expect(manifest.agentName).toBe('my-agent');
      expect(manifest.components).toContain('configs');
      expect(manifest.components).toContain('wallets');
      expect(manifest.components).not.toContain('backups');
    });

    it('should respect include/exclude options', () => {
      seedVault();

      const result = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: false,
          includeBackups: false,
          includeNetworks: false,
        },
        undefined,
        fakeVaultDir,
      );

      expect(result.success).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath!, 'utf8'));
      expect(manifest.components).toContain('configs');
      expect(manifest.components).not.toContain('wallets');
      expect(manifest.components).not.toContain('backups');
      expect(manifest.components).not.toContain('networks');
    });

    it('should use custom subdirectory', () => {
      seedVault();

      const result = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: false,
          includeBackups: false,
          includeNetworks: false,
        },
        'my-custom-subdir',
        fakeVaultDir,
      );

      expect(result.success).toBe(true);
      expect(result.archivePath).toContain('my-custom-subdir');
    });
  });

  describe('listCloudArchives', () => {
    it('should return empty array for empty directory', () => {
      const archives = listCloudArchives(cloudDir);
      expect(archives).toEqual([]);
    });

    it('should return empty array for non-existent directory', () => {
      const archives = listCloudArchives('/nonexistent/path');
      expect(archives).toEqual([]);
    });

    it('should discover archives with valid manifests', () => {
      const archDir = path.join(cloudDir, 'AgentVault-Backups', 'test-2025-01-01');
      fs.mkdirSync(archDir, { recursive: true });
      fs.writeFileSync(
        path.join(archDir, 'manifest.json'),
        JSON.stringify({
          version: '1.0',
          createdAt: '2025-01-01T00:00:00.000Z',
          platform: 'linux',
          hostname: 'test',
          agentVaultVersion: '1.0.0',
          components: ['configs'],
          files: [],
          checksum: 'abc123',
        }),
      );

      const archives = listCloudArchives(cloudDir);

      expect(archives.length).toBe(1);
      expect(archives[0]!.manifest.version).toBe('1.0');
      expect(archives[0]!.manifest.components).toContain('configs');
    });

    it('should sort archives newest first', () => {
      const backupsDir = path.join(cloudDir, 'AgentVault-Backups');

      for (const [name, date] of [
        ['old', '2024-01-01T00:00:00.000Z'],
        ['new', '2025-06-01T00:00:00.000Z'],
        ['mid', '2025-03-01T00:00:00.000Z'],
      ] as const) {
        const dir = path.join(backupsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'manifest.json'),
          JSON.stringify({
            version: '1.0',
            createdAt: date,
            platform: 'linux',
            hostname: 'test',
            agentVaultVersion: '1.0.0',
            components: [],
            files: [],
            checksum: 'x',
          }),
        );
      }

      const archives = listCloudArchives(cloudDir);

      expect(archives.length).toBe(3);
      expect(new Date(archives[0]!.manifest.createdAt).getTime()).toBeGreaterThan(
        new Date(archives[1]!.manifest.createdAt).getTime(),
      );
      expect(new Date(archives[1]!.manifest.createdAt).getTime()).toBeGreaterThan(
        new Date(archives[2]!.manifest.createdAt).getTime(),
      );
    });

    it('should skip directories without manifest', () => {
      const backupsDir = path.join(cloudDir, 'AgentVault-Backups');
      const noManifest = path.join(backupsDir, 'no-manifest');
      fs.mkdirSync(noManifest, { recursive: true });
      fs.writeFileSync(path.join(noManifest, 'somefile.txt'), 'hi');

      const archives = listCloudArchives(cloudDir);
      expect(archives.length).toBe(0);
    });

    it('should discover archives created by archiveToCloud', () => {
      seedVault();

      archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: false,
          includeBackups: false,
          includeNetworks: false,
        },
        undefined,
        fakeVaultDir,
      );

      const archives = listCloudArchives(cloudDir);
      expect(archives.length).toBe(1);
      expect(archives[0]!.manifest.components).toContain('configs');
    });
  });

  describe('verifyCloudArchive', () => {
    it('should return invalid for missing manifest', () => {
      const result = verifyCloudArchive(path.join(tmpDir, 'nonexistent'));
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Manifest file not found');
    });

    it('should verify a valid archive', () => {
      const archDir = path.join(tmpDir, 'verify-test');
      fs.mkdirSync(path.join(archDir, 'configs'), { recursive: true });

      const fileContent = Buffer.from('test content');
      fs.writeFileSync(path.join(archDir, 'configs', 'agent.json'), fileContent);

      const fileChecksum = crypto.createHash('sha256').update(fileContent).digest('hex');
      const overallChecksum = crypto
        .createHash('sha256')
        .update(Buffer.from(fileChecksum))
        .digest('hex');

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'agent.json'),
            sizeBytes: fileContent.length,
            checksum: fileChecksum,
          },
        ],
        checksum: overallChecksum,
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      const result = verifyCloudArchive(archDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should verify an archive created by archiveToCloud', () => {
      seedVault();

      const archiveResult = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: true,
          includeBackups: false,
          includeNetworks: false,
        },
        undefined,
        fakeVaultDir,
      );

      expect(archiveResult.success).toBe(true);

      const verifyResult = verifyCloudArchive(archiveResult.archivePath!);
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.errors).toEqual([]);
    });

    it('should detect checksum mismatch', () => {
      const archDir = path.join(tmpDir, 'verify-bad');
      fs.mkdirSync(path.join(archDir, 'configs'), { recursive: true });
      fs.writeFileSync(path.join(archDir, 'configs', 'agent.json'), 'original content');

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'agent.json'),
            sizeBytes: 16,
            checksum: 'wrong-checksum-value',
          },
        ],
        checksum: 'also-wrong',
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      const result = verifyCloudArchive(archDir);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect missing files', () => {
      const archDir = path.join(tmpDir, 'verify-missing');
      fs.mkdirSync(archDir, { recursive: true });

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'gone.json'),
            sizeBytes: 10,
            checksum: 'abc',
          },
        ],
        checksum: 'xyz',
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      const result = verifyCloudArchive(archDir);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Missing'))).toBe(true);
    });
  });

  describe('restoreFromCloud', () => {
    it('should return error for non-existent archive', () => {
      const result = restoreFromCloud('/nonexistent/archive');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No manifest found');
    });

    it('should restore files to a custom vault directory', () => {
      // Build a minimal valid archive
      const archDir = path.join(tmpDir, 'restore-test');
      const configsDir = path.join(archDir, 'configs');
      fs.mkdirSync(configsDir, { recursive: true });

      const fileContent = Buffer.from(JSON.stringify({ name: 'restored-agent' }));
      fs.writeFileSync(path.join(configsDir, 'agent.json'), fileContent);

      const fileChecksum = crypto.createHash('sha256').update(fileContent).digest('hex');

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'agent.json'),
            sizeBytes: fileContent.length,
            checksum: fileChecksum,
          },
        ],
        checksum: 'irrelevant-for-restore',
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      // Restore to a temp vault dir (NOT ~/.agentvault)
      const restoreVaultDir = path.join(tmpDir, 'restored-vault');
      fs.mkdirSync(restoreVaultDir, { recursive: true });

      const result = restoreFromCloud(archDir, true, restoreVaultDir);

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toBe(1);
      expect(result.components).toContain('configs');

      // Verify the file landed in the temp vault
      const destPath = path.join(restoreVaultDir, 'agents', 'agent.json');
      expect(fs.existsSync(destPath)).toBe(true);
      const restored = JSON.parse(fs.readFileSync(destPath, 'utf8'));
      expect(restored.name).toBe('restored-agent');
    });

    it('should round-trip: archive then restore', () => {
      seedVault();

      // Archive
      const archiveResult = archiveToCloud(
        cloudDir,
        {
          includeConfigs: true,
          includeWallets: true,
          includeBackups: true,
          includeNetworks: true,
        },
        undefined,
        fakeVaultDir,
      );
      expect(archiveResult.success).toBe(true);

      // Restore to a fresh vault dir
      const restoreVaultDir = path.join(tmpDir, 'round-trip-vault');
      const result = restoreFromCloud(archiveResult.archivePath!, true, restoreVaultDir);

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toBe(4);
      expect(result.components).toContain('configs');
      expect(result.components).toContain('wallets');
      expect(result.components).toContain('backups');
      expect(result.components).toContain('networks');

      // Verify restored files match originals
      const originalConfig = fs.readFileSync(
        path.join(fakeVaultDir, 'agents', 'my-agent', 'agent.json'),
        'utf8',
      );
      const restoredConfig = fs.readFileSync(
        path.join(restoreVaultDir, 'agents', 'my-agent', 'agent.json'),
        'utf8',
      );
      expect(restoredConfig).toBe(originalConfig);
    });

    it('should skip files with checksum mismatch', () => {
      const archDir = path.join(tmpDir, 'restore-bad-checksum');
      const configsDir = path.join(archDir, 'configs');
      fs.mkdirSync(configsDir, { recursive: true });
      fs.writeFileSync(path.join(configsDir, 'agent.json'), 'some content');

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'agent.json'),
            sizeBytes: 12,
            checksum: 'intentionally-wrong',
          },
        ],
        checksum: 'x',
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      const restoreVaultDir = path.join(tmpDir, 'restore-bad-vault');
      const result = restoreFromCloud(archDir, true, restoreVaultDir);

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toBe(0);
      expect(result.warnings.some((w) => w.includes('Checksum mismatch'))).toBe(true);
    });

    it('should not overwrite existing files without overwrite flag', () => {
      const archDir = path.join(tmpDir, 'restore-no-overwrite');
      const configsDir = path.join(archDir, 'configs');
      fs.mkdirSync(configsDir, { recursive: true });

      const fileContent = Buffer.from('new-data');
      fs.writeFileSync(path.join(configsDir, 'agent.json'), fileContent);

      const checksum = crypto.createHash('sha256').update(fileContent).digest('hex');

      const manifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        platform: 'linux',
        hostname: 'test',
        agentVaultVersion: '1.0.0',
        components: ['configs'],
        files: [
          {
            relativePath: path.join('configs', 'agent.json'),
            sizeBytes: fileContent.length,
            checksum,
          },
        ],
        checksum: 'x',
      };

      fs.writeFileSync(path.join(archDir, 'manifest.json'), JSON.stringify(manifest));

      // Create existing file at destination
      const restoreVaultDir = path.join(tmpDir, 'no-overwrite-vault');
      const destDir = path.join(restoreVaultDir, 'agents');
      fs.mkdirSync(destDir, { recursive: true });
      const destFile = path.join(destDir, 'agent.json');
      fs.writeFileSync(destFile, 'existing-data');

      const result = restoreFromCloud(archDir, false, restoreVaultDir);

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toBe(0);
      expect(result.warnings.some((w) => w.includes('Skipping existing'))).toBe(true);

      // Existing data should be unchanged
      expect(fs.readFileSync(destFile, 'utf8')).toBe('existing-data');
    });
  });
});
