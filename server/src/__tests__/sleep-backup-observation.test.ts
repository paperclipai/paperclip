import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { observeIdleBackupCheckpoint } from './helpers/maintenance/backup-observation.js';

it('observes complete owned gzip bytes without retaining SQL and refuses missing, truncated, foreign, historical or failed checkpoints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sleep-backup-observer-'));
  const id = '12345678-1234-1234-1234-123456789012';
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const backupDir = path.join(directory, 'backups'); await mkdir(backupDir);
  try {
    const observe = () => observeIdleBackupCheckpoint(directory, [], startedAt, id);
    await expect(observe()).rejects.toThrow();
    await writeFile(path.join(backupDir, '.idle-backup-wake-required'), 'normal owner marker');
    await expect(observe()).rejects.toThrow('no new archive');
    const archive = path.join(backupDir, 'owned.sql.gz'), bytes = gzipSync(`COPY fixture;\n${id}\n`);
    await writeFile(archive, bytes);
    const receipt = await observe();
    expect(receipt.archives[0]).toMatchObject({ bytes: bytes.length, gzipVerified: true, fixtureIdentifierFound: true });
    expect(receipt.archives[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(id);
    await expect(observeIdleBackupCheckpoint(directory, ['owned.sql.gz'], startedAt, id)).rejects.toThrow('no new archive');
    await expect(observeIdleBackupCheckpoint(directory, [], new Date(Date.now() + 1000).toISOString(), id)).rejects.toThrow('predates');
    await writeFile(archive, bytes.subarray(0, bytes.length - 4)); await expect(observe()).rejects.toThrow();
    await writeFile(archive, gzipSync('foreign fixture')); await expect(observe()).rejects.toThrow('owned fixture');
    await writeFile(archive, bytes); await writeFile(path.join(backupDir, 'db-backup-to-s3.failure'), 'failed');
    await expect(observe()).rejects.toThrow('failure marker');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('uses opened-file mtime when birthtime is zero and still rejects old or malformed provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sleep-backup-no-birthtime-'));
  const id = '12345678-1234-1234-1234-123456789012', startedAt = new Date(Date.now() - 1000).toISOString();
  const backupDir = path.join(directory, 'backups'); await mkdir(backupDir);
  const archive = path.join(backupDir, 'owned.sql.gz');
  await writeFile(archive, gzipSync(`COPY fixture;\n${id}\n`));
  await writeFile(path.join(backupDir, '.idle-backup-wake-required'), 'normal owner marker');
  const handle = await open(archive, 'r'), prototype = Object.getPrototypeOf(handle), originalStat = prototype.stat;
  await handle.close();
  let override: { birthtimeMs: number; mtimeMs?: number } = { birthtimeMs: 0 };
  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    return Object.assign(await originalStat.apply(this, args), override);
  });
  try {
    const observed = await observeIdleBackupCheckpoint(directory, [], startedAt, id);
    expect(observed.archives[0]).toMatchObject({ createdAtSource: 'mtime', gzipVerified: true, fixtureIdentifierFound: true });
    expect(Date.parse(observed.archives[0]!.createdAt)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    for (const invalid of [
      { birthtimeMs: 0, mtimeMs: Date.parse(startedAt) - 1 }, { birthtimeMs: 0, mtimeMs: 0 },
      { birthtimeMs: 0, mtimeMs: NaN }, { birthtimeMs: NaN }, { birthtimeMs: -1 },
      { birthtimeMs: 0, mtimeMs: Date.now() + 60_000 },
      { birthtimeMs: Date.parse(startedAt) - 1, mtimeMs: Date.now() },
    ]) {
      override = invalid;
      await expect(observeIdleBackupCheckpoint(directory, [], startedAt, id)).rejects.toThrow('predates');
    }
    await expect(observeIdleBackupCheckpoint(directory, [], 'invalid', id)).rejects.toThrow('checkpoint timestamp');
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
