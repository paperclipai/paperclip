#!/usr/bin/env node
// Run on a disposable Linux verification host after pnpm build. No publication,
// credentials, inference, or changes to release versions. Native provisioning is
// explicit and separate from npm installation, and is removed in finally.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePublishManifest, prepareBundledPackage } from './prepare-bundled-package.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prerequisite = '/opt/paperclip/providers/grok/1.0.13/grok';
assert.equal(process.platform, 'linux', 'Run this verification on disposable EC2 Linux, not a developer host');
assert.equal(existsSync(prerequisite), false, 'Refuse to overwrite a pre-existing sandbox prerequisite');
const root = mkdtempSync(join(tmpdir(), 'paperclip-grok-public-install-'));
const env = { ...process.env, NODE_PATH: '', PAPERCLIP_RELEASE_REUSE_UI_DIST: '1', npm_config_ignore_scripts: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, env, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
const sourceRevision = run('git', ['rev-parse', 'HEAD'], repo).toString().trim();
const releaseVersion = `0.0.0-grok-verify.${sourceRevision.slice(0, 12)}`;
let provisioned = false;
try {
  const listing = run(process.execPath, [join(repo, 'scripts/release-package-map.mjs'), 'list'], repo).toString().trim().split('\n').map(line => line.split('\t'));
  const packages = new Map(listing.map(([dir, name]) => [name, { dir, manifest: JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) }]));
  const needed = new Set();
  function visit(name) {
    if (needed.has(name)) return;
    const entry = packages.get(name); assert.ok(entry, `Missing public workspace dependency ${name}`); needed.add(name);
    for (const [dep, spec] of Object.entries({ ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies })) {
      if (spec.startsWith('workspace:')) visit(dep);
    }
  }
  visit('@paperclipai/server');
  // Match release.sh's unified versioning in temporary staging directories.
  // Source manifests remain untouched, including independently versioned SDKs.
  run(process.execPath, [join(repo, 'scripts/build-standalone-public-packages.mjs')], repo);
  run('bash', [join(repo, 'scripts/prepare-server-ui-dist.sh')], repo);
  const tarballs = [];
  for (const [index, name] of [...needed].entries()) {
    const { dir, manifest } = packages.get(name);
    const target = join(root, `package-${index}`); mkdirSync(target);
    const stagedSource = join(root, `source-${index}`); mkdirSync(stagedSource);
    for (const file of manifest.files ?? ['dist']) {
      // release.sh stages runtime skills into these public packages before pack.
      const releaseSkills = file === 'skills' && ['server', 'packages/adapters/claude-local', 'packages/adapters/codex-local'].includes(dir);
      // Other adapters declare an optional skills directory that npm pack omits
      // when absent. Do not fabricate extra release payloads for those adapters.
      if (file === 'skills' && !releaseSkills && !existsSync(join(repo, dir, file))) continue;
      cpSync(releaseSkills ? join(repo, 'skills') : join(repo, dir, file), join(stagedSource, file), { recursive: true });
    }
    const releaseManifest = { ...manifest, version: releaseVersion };
    writeFileSync(join(stagedSource, 'package.json'), JSON.stringify(releaseManifest));
    if ((manifest.bundleDependencies ?? manifest.bundledDependencies ?? []).length) {
      prepareBundledPackage(stagedSource, target);
    } else {
      cpSync(stagedSource, target, { recursive: true });
      writeFileSync(join(target, 'package.json'), JSON.stringify(materializePublishManifest(releaseManifest)));
    }
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', root], target);
    const packed = readdirSync(root).filter(f => f.endsWith('.tgz') && !tarballs.includes(join(root, f)));
    assert.equal(packed.length, 1); tarballs.push(join(root, packed[0]));
  }
  const consumer = join(root, 'consumer'); mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts=false', '--omit=dev', '--package-lock=false', ...tarballs], consumer);
  for (const name of needed) {
    const installedManifest = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installedManifest.version, releaseVersion, `Installed release version for ${name}`);
  }
  assert.equal(existsSync(prerequisite), false, 'npm must not provision Grok');
  const server = join(consumer, 'node_modules/@paperclipai/server');
  const installed = join(server, 'dist/vendor/paperclip-runner');
  assert.ok(existsSync(join(installed, 'providers/grok/launcher.cjs')));
  assert.equal(existsSync(join(consumer, 'node_modules/@paperclipai/grok-acp')), false);
  assert.equal(existsSync(join(installed, 'providers/grok/bin')), false);
  // Use real installed compiled code and its actual npm dependency graph. A
  // separate process prevents module resolution from borrowing this checkout.
  const probe = `
    import assert from 'node:assert/strict';
    import { verifyQualifiedAcpxInstallation } from './node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js';
    import { resolveQualifiedAcpxProfile } from './node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/qualified-profiles.js';
    const profile = resolveQualifiedAcpxProfile('grok', 'grok-4.7');
    const inspect = () => verifyQualifiedAcpxInstallation(profile, () => { throw new Error('Grok must not resolve an npm package'); });
    if (process.argv[2] === 'missing') await assert.rejects(inspect, /prerequisite missing/);
    else { const installation = await inspect(); assert.equal(installation.agentServerPackageJsonPath, null); assert.equal(installation.agentRuntimePackageJsonPath, null); await (await installation.openCommand()).close(); }
  `;
  writeFileSync(join(consumer, 'probe.mjs'), probe);
  run(process.execPath, ['probe.mjs', 'missing'], consumer);
  provisioned = true;
  run('sudo', [process.execPath, join(repo, 'packages/paperclip-runner/scripts/provision-grok.mjs'), prerequisite]);
  run(process.execPath, ['probe.mjs', 'present'], consumer);
  console.log(JSON.stringify({ schema: 'paperclip.grok.public-npm-install.v1', sourceRevision, releaseVersion, lifecycleScriptsEnabled: true, cleanNpmInstall: true, packageCount: needed.size, builtinLauncherPresent: true, separateGrokPackage: false, npmProvisionedBinary: false, missingPrerequisiteRejected: true, provisionedBinaryVerified: true, commandLeaseVerified: true, providerCalls: 0 }));
} finally {
  if (provisioned) run('sudo', ['rm', '-f', prerequisite]);
  rmSync(root, { recursive: true, force: true });
}
