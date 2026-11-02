#!/usr/bin/env node
// Fill an npm cache with the public registry graph of the packages the
// public-install verifier stages, while `pnpm build` still runs. The verifier
// starts after the build with an empty cache, and its consumer install then
// downloads the whole graph (106-127s in runs 38241687458 to 38250487646,
// 2026-10-12). The graph is fixed by source manifests, so it can be fetched
// before any tarball exists.
//
// This only downloads. Scripts are disabled, nothing here is verified, and the
// scratch consumer is removed afterwards. npm checks every cached tarball
// against the integrity its own resolution records, so a warm cache changes
// where bytes come from, never what the verifier installs. Any failure leaves
// a partial cache that the verifier completes from the registry as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicInstallClosure, publicRegistryDependencies } from './public-install-closure.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE;
assert.ok(cache, 'Set PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE to the cache directory the verifier will use');
mkdirSync(cache, { recursive: true });
const started = performance.now();
const scratch = mkdtempSync(join(tmpdir(), 'paperclip-public-install-warm-'));
try {
  const { dependencies, optionalDependencies } = publicRegistryDependencies(publicInstallClosure(repo));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, dependencies, optionalDependencies }));
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: scratch, stdio: 'inherit', env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
  });
  console.log(JSON.stringify({ schema: 'paperclip.public-npm-install.cache-warm.v1', dependencyCount: Object.keys(dependencies).length + Object.keys(optionalDependencies).length, warm_ms: Math.round(performance.now() - started) }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
