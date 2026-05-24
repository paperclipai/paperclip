#!/usr/bin/env node
// Cross-platform entry: works on macOS/Linux/Windows.
// Resolves the repo root from this file's location, prefers the compiled
// dist/cli.js, falls back to tsx+source for dev/clone-and-run mode.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(fs.realpathSync(__filename));
const REPO_ROOT = path.resolve(BIN_DIR, '..');

const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const SRC_CLI = path.join(REPO_ROOT, 'cli.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const argv = process.argv.slice(2);

// Prefer compiled output (npm-installed users + post-build dev). Fall back to
// tsx-on-source (clone-and-run dev mode, before tsc emits dist/).
if (fs.existsSync(DIST_CLI)) {
  const r = spawnSync(process.execPath, [DIST_CLI, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (fs.existsSync(TSX_BIN) && fs.existsSync(SRC_CLI)) {
  // shell:true lets Windows resolve the .cmd shim for tsx without a separate code path.
  const r = spawnSync(TSX_BIN, [SRC_CLI, ...argv], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status ?? 1);
}

console.error('[designer] No runnable found.');
console.error(`           Expected ${DIST_CLI} (compiled) or ${TSX_BIN} + ${SRC_CLI} (dev).`);
console.error(`           Run: cd ${REPO_ROOT} && npm install && npm run build`);
process.exit(1);
