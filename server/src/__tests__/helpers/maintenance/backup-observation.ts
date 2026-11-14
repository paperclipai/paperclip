import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/** Inspect only archives created by the normal idle owner after the quiet counters freeze.
 * Stream through EOF to validate the gzip trailer; retain no SQL/credential contents. */
export async function observeIdleBackupCheckpoint(directory: string, beforeNames: string[], startedAt: string, fixtureId: string) {
  if (!/^[a-f0-9-]{36}$/.test(fixtureId)) throw new Error('Invalid owned backup fixture identifier');
  const checkpointMs = Date.parse(startedAt);
  if (!Number.isFinite(checkpointMs) || checkpointMs <= 0) throw new Error('Invalid owned checkpoint timestamp');
  const backupDir = path.join(directory, 'backups');
  const marker = await lstat(path.join(backupDir, '.idle-backup-wake-required'));
  if (!marker.isFile() || marker.isSymbolicLink() || marker.size === 0) throw new Error('Missing normal idle backup wake marker');
  for (const failure of [path.join(directory, 'health/db-backup-to-s3.failure'), path.join(directory, 'db-backup-to-s3.failure'), path.join(backupDir, 'db-backup-to-s3.failure')]) {
    try { await lstat(failure); throw new Error('Observed database backup failure marker'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const names = (await readdir(backupDir)).filter(name => name.endsWith('.sql.gz') && !beforeNames.includes(name)).sort();
  if (!names.length) throw new Error('Normal idle owner produced no new archive');
  const archives = [];
  for (const name of names) {
    const handle = await open(path.join(backupDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      // Some filesystems report birthtime=0. The new-name filter and opened
      // non-symlink file still apply; use its content mtime only in that case.
      // An old positive birthtime must not be rescued by a recent modification.
      const createdAtSource = stat.birthtimeMs === 0 ? 'mtime' : 'birthtime';
      const createdMs = stat.birthtimeMs === 0 ? stat.mtimeMs : stat.birthtimeMs;
      if (!stat.isFile() || stat.size <= 0 || !Number.isFinite(createdMs) || createdMs <= 0
        || createdMs < checkpointMs || Math.trunc(createdMs) > Date.now()) throw new Error('Archive predates owned checkpoint or is invalid');
      const hash = createHash('sha256'); let sqlBytes = 0, tail = '', fixtureIdentifierFound = false;
      await pipeline(handle.createReadStream({ autoClose: false }),
        new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }), createGunzip(),
        new Writable({ write(chunk, _encoding, done) {
          sqlBytes += chunk.length;
          if (sqlBytes > 512 * 1024 * 1024) { done(new Error('Owned fixture archive exceeded bounded observation size')); return; }
          const text = tail + chunk.toString('utf8'); fixtureIdentifierFound ||= text.includes(fixtureId);
          tail = text.slice(-fixtureId.length); done();
        } }));
      if (!sqlBytes || !fixtureIdentifierFound) throw new Error('Archive does not contain the owned fixture');
      archives.push({ name, bytes: stat.size, sqlBytes, sha256: hash.digest('hex'), createdAt: new Date(createdMs).toISOString(), createdAtSource, gzipVerified: true, fixtureIdentifierFound });
    } finally { await handle.close(); }
  }
  return { owner: 'normal-idle-checkpoint', startedAt, observedAt: new Date().toISOString(), archives, wakeMarkerObserved: true, failureObserved: false };
}
export async function idleBackupArchiveNames(directory: string) {
  try { return (await readdir(path.join(directory, 'backups'))).filter(name => name.endsWith('.sql.gz')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
