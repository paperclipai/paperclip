// The public-install verifier packs every staged public package with
// `npm pack`. Each pack reads only its own `package-<index>` directory and
// writes one tarball, and the work is a Node start-up plus CPU-bound gzip per
// package, so the packs run as concurrent children through the prefetch
// helper, at most one per core, instead of one after another. Each child
// packs into its own destination directory, so the tarball a package produced
// is read from there rather than guessed from a shared directory, and the
// results come back in the order the entries were given.
import { mkdirSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { startPrefetch } from './prefetch-child.mjs';

export const PACK_ARGS = ['pack', '--ignore-scripts', '--pack-destination'];

export const packConcurrency = () => Math.max(1, availableParallelism());

// Packs `entries` (`{ name, target, destination }`) with at most `concurrency`
// children at once, launched in the order given, and resolves with each entry
// extended by its `tarball` path and `durationMs`, in the same order. Every
// child is passed to `register` as it starts, so the caller can stop the ones
// still running when something fails. The first failure rejects with the tail
// of that child's log, and nothing further is launched after it.
export function packStagedPackages(entries, { logDir, env = process.env, concurrency = packConcurrency(), register = () => {}, command = ['npm'] }) {
  const [cmd, ...commandArgs] = command;
  const results = new Array(entries.length);
  const queue = entries.map((entry, index) => ({ entry, index }));
  let active = 0;
  let failed = false;
  return new Promise((resolve, reject) => {
    const fail = error => { failed = true; reject(error); };
    const launch = () => {
      if (!failed && active === 0 && queue.length === 0) return resolve(results);
      while (!failed && active < concurrency && queue.length > 0) {
        const { entry, index } = queue.shift();
        active += 1;
        let handle;
        try {
          mkdirSync(entry.destination, { recursive: true });
          handle = startPrefetch({ name: `pack-${index}`, cmd, args: [...commandArgs, ...PACK_ARGS, entry.destination], cwd: entry.target, env, logPath: join(logDir, `pack-${index}.log`) });
          register(handle);
        } catch (error) {
          return fail(error);
        }
        handle.done.then(() => {
          const packed = readdirSync(entry.destination).filter(file => file.endsWith('.tgz'));
          if (packed.length !== 1) throw new Error(`${entry.name} pack produced ${packed.length} tarballs in ${entry.destination}`);
          results[index] = { ...entry, tarball: join(entry.destination, packed[0]), durationMs: handle.durationMs };
          active -= 1;
          launch();
        }).catch(fail);
      }
    };
    launch();
  });
}

// Timing-line keys: the concurrency used, the sum of the per-pack times (what
// the packs would have cost one after another) and the longest single pack.
export const packTimings = (packs, concurrency) => ({
  pack_concurrency: concurrency,
  pack_serial_ms: packs.reduce((total, { durationMs }) => total + durationMs, 0),
  pack_longest_ms: packs.reduce((longest, { durationMs }) => Math.max(longest, durationMs), 0),
});
