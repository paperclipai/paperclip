import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_INSTALL_ROOTS, publicInstallClosure, publicRegistryDependencies } from '../public-install-closure.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

test('the closure starts at the server and the CLI and follows only workspace specs', () => {
  assert.deepEqual(PUBLIC_INSTALL_ROOTS, ['@paperclipai/server', 'paperclipai']);
  const { packages, needed } = publicInstallClosure(repo);
  const order = [...needed];
  assert.equal(order[0], '@paperclipai/server');
  assert.ok(needed.has('paperclipai'));
  for (const name of needed) {
    const { manifest } = packages.get(name);
    for (const [dep, spec] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      assert.equal(needed.has(dep), spec.startsWith('workspace:'), `${name} -> ${dep}@${spec}`);
    }
  }
});

test('the warm-up graph is the closure\'s registry dependencies, first spec wins', () => {
  const pkg = (dependencies, optionalDependencies) => ({ dir: 'x', manifest: { dependencies, optionalDependencies } });
  const packages = new Map([
    ['a', pkg({ b: 'workspace:*', left: '^1.0.0', shared: '^2.0.0', local: 'file:../local', linked: 'link:../linked' }, { native: '1.2.3' })],
    ['b', pkg({ shared: '^3.0.0', right: '~4.0.0' }, { left: '^9.0.0' })],
    ['unvisited', pkg({ never: '1.0.0' })],
  ]);
  assert.deepEqual(publicRegistryDependencies({ packages, needed: new Set(['a', 'b']) }), {
    dependencies: { left: '^1.0.0', shared: '^2.0.0', right: '~4.0.0' },
    optionalDependencies: { native: '1.2.3' },
  });
  const real = publicRegistryDependencies(publicInstallClosure(repo));
  const names = [...Object.keys(real.dependencies), ...Object.keys(real.optionalDependencies)];
  assert.ok(names.length > 0);
  for (const spec of [...Object.values(real.dependencies), ...Object.values(real.optionalDependencies)]) {
    assert.doesNotMatch(spec, /^(workspace|file|link):/);
  }
});

test('the warm-up refuses to run without the cache the verifier will read', () => {
  const env = { ...process.env };
  delete env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../warm-public-install-npm-cache.mjs', import.meta.url))], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE/);
});

test('the Build lane warms the cache before pnpm build and hands the same directory to the verifier', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/pr-trusted.yml', import.meta.url), 'utf8');
  const build = workflow.slice(workflow.indexOf('\n  build:\n'), workflow.indexOf('\n  verify_serialized_server:\n'));
  const position = fragment => { const index = build.indexOf(fragment); assert.notEqual(index, -1, `Build job must contain ${fragment}`); return index; };
  const warm = position('PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE="$RUNNER_TEMP/public-install-npm-cache" node scripts/warm-public-install-npm-cache.mjs');
  assert.ok(position('- name: Install dependencies') < warm && warm < position('- name: Build\n'), 'the warm-up overlaps the Rust restore and pnpm build');
  assert.ok(build.includes('set +e\n'), 'a failed warm-up still records its status, so the verifier never waits it out');
  const verify = position('export PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE="$RUNNER_TEMP/public-install-npm-cache"');
  assert.ok(verify < position('node scripts/verify-grok-npm-install.mjs'));
  const verifier = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.ok(verifier.includes("const cache = process.env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE ? resolve(process.env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE) : join(root, 'cache');"));
});
