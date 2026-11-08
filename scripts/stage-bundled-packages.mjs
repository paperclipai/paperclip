// The public-install verifier stages three packages that bundle dependencies
// (`@paperclipai/server`, `@paperclipai/adapter-utils`, `@paperclipai/db`).
// Each one is a host-side `npm install` of that package's bundled closure into
// its own pack directory, and none reads what another produces, so they run as
// concurrent children instead of one after another inside the staging loop.
// Each child is the CLI entry of `prepare-bundled-package.mjs`, the same path
// release.sh runs, with its output in a log file that a failure reports.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPrefetch } from './prefetch-child.mjs';

export const PREPARE_BUNDLED_PACKAGE_SCRIPT = fileURLToPath(new URL('./prepare-bundled-package.mjs', import.meta.url));

// `@paperclipai/adapter-utils` -> `adapter_utils`, for log names and timing keys.
export const bundledPackageSlug = name => name.replace(/^@paperclipai\//, '').replace(/[^a-z0-9]+/gi, '_');

// Starts one child per entry (`{ name, stagedSource, target }`) at once and
// returns the entries with their `slug` and prefetch `handle`. The caller joins
// `handle.done` where the packed output is needed and registers the handles
// for cleanup, so an earlier failure stops every install still running.
export function startBundledInstalls(entries, { logDir, cwd, env = process.env, script = PREPARE_BUNDLED_PACKAGE_SCRIPT }) {
  return entries.map(entry => {
    const slug = bundledPackageSlug(entry.name);
    const handle = startPrefetch({ name: `bundled-${slug}`, cmd: process.execPath, args: [script, entry.stagedSource, entry.target], cwd, env, logPath: join(logDir, `bundled-${slug}.log`) });
    return { ...entry, slug, handle };
  });
}

// Per-package wall time for the timing line. The helper measures from the
// start to the child's last output; the parent is idle while it waits for the
// installs, so the exit is observed as it happens.
export const bundledInstallTimings = installs => Object.fromEntries(installs.map(({ slug, handle }) => [`stage_bundled_${slug}_ms`, handle.durationMs]));
