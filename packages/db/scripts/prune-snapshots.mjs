#!/usr/bin/env node
// Cross-platform replacement for:
// ls src/migrations/meta/*_snapshot.json | sort -r | tail -n +6 | xargs rm -f
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';

const metaDir = join('src', 'migrations', 'meta');
const snapshots = readdirSync(metaDir)
  .filter((f) => f.endsWith('_snapshot.json'))
  .sort()
  .reverse();

const toDelete = snapshots.slice(5);
for (const file of toDelete) {
  const fullPath = join(metaDir, file);
  rmSync(fullPath, { force: true });
  console.log(`Removed old snapshot: ${fullPath}`);
}
if (toDelete.length === 0) {
  console.log('No old snapshots to prune.');
}
