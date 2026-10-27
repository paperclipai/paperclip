import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startPackedRegistry, writePackedRegistryCatalog } from '../public-install-registry.mjs';

const script = fileURLToPath(new URL('../public-install-registry.mjs', import.meta.url));
const scratch = async body => {
  const root = mkdtempSync(join(tmpdir(), 'public-install-registry-'));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const environment = root => ({ ...process.env, HOME: root, npm_config_cache: join(root, 'cache'),
  npm_config_userconfig: join(root, 'no-npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000' });
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: environment(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${signal ?? code}: ${output}`)));
});
const fixture = (root, { publicDependency = false } = {}) => {
  const assets = join(root, 'assets'); mkdirSync(assets);
  const packs = [
    { name: '@ci/leaf', version: '1.0.0', main: 'index.js' },
    { name: '@ci/optional', version: '1.0.0' },
    { name: '@ci/root', version: '1.0.0', dependencies: { '@ci/leaf': '1.0.0', 'bundled-leaf': '1.0.0', ...(publicDependency ? { 'is-number': '7.0.0' } : {}) },
      optionalDependencies: { '@ci/optional': '1.0.0' }, bundleDependencies: ['bundled-leaf'], bin: { 'ci-root': 'index.js' },
      scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'ok')\"" } },
  ];
  for (const [index, manifest] of packs.entries()) {
    const source = join(root, `source-${index}`); mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'index.js'), '#!/usr/bin/env node\nmodule.exports = 42;\n');
    if (manifest.bundleDependencies) {
      const bundle = join(source, 'node_modules/bundled-leaf'); mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'bundled-leaf', version: '1.0.0', main: 'index.js' }));
      writeFileSync(join(bundle, 'index.js'), 'module.exports = "bundled";\n');
    }
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', assets], { cwd: source, env: environment(root), stdio: 'pipe' });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ ...manifest, version: '9.9.9' }));
  }
  return assets;
};
const installedFiles = directory => {
  const entries = [];
  const walk = (root, relative = '') => {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (item.name === '.package-lock.json') continue;
      const name = join(relative, item.name), path = join(root, item.name);
      if (item.isDirectory()) walk(path, name);
      else entries.push([name, item.isSymbolicLink() ? `link:${readlinkSync(path)}` : createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  };
  walk(directory);
  return entries.sort(([a], [b]) => a.localeCompare(b));
};

test('real npm installs identical packed bytes, bundles, optional dependencies and bins without running scripts early', { timeout: 90_000 }, async () => scratch(async root => {
  const assets = fixture(root, { publicDependency: true }), catalog = await writePackedRegistryCatalog(assets);
  assert.ok(catalog.every(entry => entry.manifest.version === '1.0.0'), 'metadata must come from packed bytes, not changed source');
  const before = join(root, 'file-consumer'), after = join(root, 'registry-consumer');
  for (const cwd of [before, after]) { mkdirSync(cwd); writeFileSync(join(cwd, 'package.json'), '{"private":true}'); }
  await run('npm', ['install', '--ignore-scripts', '--omit=dev', ...catalog.map(entry => join(assets, entry.file))], before);
  await run(process.execPath, [script, assets], after);
  assert.deepEqual(installedFiles(join(after, 'node_modules')), installedFiles(join(before, 'node_modules')));
  for (const cwd of [before, after]) {
    const marker = join(cwd, 'node_modules/@ci/root/lifecycle-ran');
    assert.equal(existsSync(marker), false);
    const lock = readFileSync(join(cwd, 'package-lock.json'), 'utf8');
    const publicPackage = JSON.parse(lock).packages['node_modules/is-number'];
    assert.equal(publicPackage.version, '7.0.0');
    assert.equal(publicPackage.resolved, 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz');
    await run('npm', ['rebuild', '--offline', '--ignore-scripts=false', '--foreground-scripts'], cwd);
    assert.equal(readFileSync(marker, 'utf8'), 'ok');
    assert.equal(readFileSync(join(cwd, 'package-lock.json'), 'utf8'), lock);
  }
  assert.deepEqual(installedFiles(join(after, 'node_modules')), installedFiles(join(before, 'node_modules')));
}));

test('the registry exposes only known tarballs, redirects other packages to npm and closes its listener', async () => scratch(async root => {
  const assets = join(root, 'assets'); mkdirSync(assets);
  writeFileSync(join(assets, 'registry-packages.json'), JSON.stringify([{ file: 'pkg.tgz', manifest: { name: '@ci/pkg', version: '1.0.0' }, integrity: 'sha512-YQ==' }]));
  writeFileSync(join(assets, 'pkg.tgz'), 'packed bytes');
  const registry = await startPackedRegistry(assets);
  try {
    const metadata = await (await fetch(`${registry.url}/@ci%2fpkg`)).json();
    assert.equal(metadata.versions['1.0.0'].dist.integrity, 'sha512-YQ==');
    assert.equal(await (await fetch(metadata.versions['1.0.0'].dist.tarball)).text(), 'packed bytes');
    const external = await fetch(`${registry.url}/@other%2fpkg`, { redirect: 'manual' });
    assert.equal(external.status, 302);
    assert.equal(external.headers.get('location'), 'https://registry.npmjs.org/%40other%2Fpkg');
    assert.equal((await fetch(`${registry.url}/-/900.tgz`)).status, 404);
    assert.equal((await fetch(`${registry.url}/some%2foutside%2ffile`)).status, 404);
    assert.equal((await fetch(`${registry.url}/@ci%2fpkg`, { method: 'POST' })).status, 405);
  } finally { await registry.close(); }
  await assert.rejects(fetch(`${registry.url}/@ci%2fpkg`));
}));

test('npm rejects changed tarball bytes against the catalog integrity and the CLI reports failure', { timeout: 90_000 }, async () => scratch(async root => {
  const assets = fixture(root), catalog = await writePackedRegistryCatalog(assets);
  const archive = join(assets, catalog[0].file);
  const bytes = readFileSync(archive);
  bytes[4] ^= 1; writeFileSync(archive, bytes);
  const consumer = join(root, 'consumer'); mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), '{"private":true}');
  await assert.rejects(run(process.execPath, [script, assets], consumer), /EINTEGRITY/);
}));
