#!/usr/bin/env node
// Run on a disposable Linux verification host after pnpm build. No publication,
// credentials, inference, or changes to release versions. Native provisioning is
// explicit and separate from npm installation, and is removed in finally.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePublishManifest, prepareBundledPackage } from './prepare-bundled-package.mjs';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, assertNoBundledCodexPayloads, grokConsumerDockerArgs, installedCodexProbeSource } from './grok-public-install-sandbox.mjs';
import { retainRunnerQualificationPackages } from './retain-runner-qualification-packages.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.platform, 'linux', 'Run this verification on disposable EC2 Linux, not a developer host');
const root = mkdtempSync(join(tmpdir(), 'paperclip-grok-public-install-'));
const prerequisite = join(root, 'native/grok');
const env = { ...process.env, NODE_PATH: '', PAPERCLIP_RELEASE_REUSE_UI_DIST: '1', npm_config_ignore_scripts: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, env, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
const sourceRevision = run('git', ['rev-parse', 'HEAD'], repo).toString().trim();
const releaseVersion = `0.0.0-grok-verify.${sourceRevision.slice(0, 12)}`;
// The two network downloads the probes need do not depend on anything packed
// below, so they overlap the CPU-bound staging instead of running after it.
// The consumer image is pinned by digest and the Grok binary is checked against
// its pinned sha256 by the provisioning script, so an early start changes no
// verified property. Neither touches the consumer, the assets, nor the
// `native/grok` path that the post-install assertion inspects.
const prefetched = join(root, 'prefetch'); mkdirSync(prefetched);
const stagedGrok = join(prefetched, 'grok');
const children = [];
const timing = {};
const prefetch = (name, cmd, args) => {
  const started = performance.now();
  const logPath = join(prefetched, `${name}.log`);
  const log = openSync(logPath, 'w');
  const promise = new Promise((settle, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', log, log] });
    children.push(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      closeSync(log);
      timing[`${name}_prefetch_ms`] = Math.round(performance.now() - started);
      if (code === 0) return settle();
      // After a failure elsewhere, cleanup has already stopped this child and
      // removed its log; the earlier error is the one that must surface.
      let output = '';
      try { output = readFileSync(logPath, 'utf8').trim().slice(-2000); } catch {}
      reject(new Error(`${name} prefetch failed (${signal ?? `exit ${code}`}): ${output}`));
    });
  });
  // A failure surfaces where the result is awaited, not as an unhandled rejection
  // that would mask an earlier staging error.
  promise.catch(() => {});
  return promise;
};
const imageReady = prefetch('image', 'docker', ['pull', '--platform', 'linux/amd64', GROK_PUBLIC_INSTALL_IMAGE]);
// Provision as the unprivileged verification user, never into the host's /opt.
// Only the positive probe sees this file at the canonical sandbox path.
const grokReady = prefetch('grok', process.execPath, [join(repo, 'packages/paperclip-runner/scripts/provision-grok.mjs'), stagedGrok]);
let phaseStarted = performance.now();
const phase = name => { const now = performance.now(); timing[`${name}_ms`] = Math.round(now - phaseStarted); phaseStarted = now; };
const awaited = async (name, promise) => { const started = performance.now(); await promise; timing[`${name}_wait_ms`] = Math.round(performance.now() - started); };
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
  visit('paperclipai');
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
    assert.equal(packed.length, 1);
    const tarball = join(root, packed[0]);
    assertNoBundledCodexPayloads(run('tar', ['-tzf', tarball]).toString().trim().split('\n'));
    tarballs.push(tarball);
  }
  const assets = join(root, 'assets'); mkdirSync(assets, { mode: 0o755 });
  const consumer = join(root, 'consumer'); mkdirSync(consumer);
  const cache = join(root, 'cache'); mkdirSync(cache);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const tarball of tarballs) {
    const destination = join(assets, basename(tarball)); cpSync(tarball, destination); chmodSync(destination, 0o644);
  }
  // Prove lifecycle execution is real even if npm changes its script defaults.
  const sentinelSource = join(root, 'lifecycle-sentinel'); mkdirSync(sentinelSource);
  writeFileSync(join(sentinelSource, 'package.json'), JSON.stringify({
    name: 'paperclip-verification-lifecycle-sentinel', version: '1.0.0', private: true,
    scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'ok\')"' },
  }));
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', assets], sentinelSource);
  const sentinel = join(consumer, 'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
  const consumerUid = process.getuid();
  const isolated = (command, options = {}) => run('docker', grokConsumerDockerArgs({ assets, consumer, cache, uid: consumerUid, gid: process.getgid(), command, ...options }));
  phase('stage_packages');
  await awaited('image', imageReady);
  // npm resolution is intentionally the public consumer graph, not the pnpm
  // workspace graph. Freeze that result before any lifecycle script can run.
  isolated(['npm', 'install', '--ignore-scripts', '--omit=dev', ...readdirSync(assets).filter(file => file.endsWith('.tgz')).map(file => `/packages/${file}`)], { download: true });
  phase('consumer_install');
  assert.equal(existsSync(sentinel), false, 'Dependency download must not run lifecycle scripts');
  const consumerLock = readFileSync(join(consumer, 'package-lock.json'), 'utf8');
  // npm ci rejects bundled optional platform dependencies absent from its own
  // generated lock. Rebuild runs the deferred install hooks on the installed
  // graph without re-resolving it; network isolation and lock checks still hold.
  isolated(GROK_PUBLIC_INSTALL_LIFECYCLE);
  assert.equal(readFileSync(sentinel, 'utf8'), 'ok', 'Offline lifecycle scripts must actually execute');
  assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), consumerLock, 'Lifecycle execution must preserve the resolved consumer lock');
  phase('lifecycle_rebuild');
  for (const name of needed) {
    const installedManifest = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installedManifest.version, releaseVersion, `Installed release version for ${name}`);
  }
  assert.equal(existsSync(prerequisite), false, 'npm must not provision Grok');
  const server = join(consumer, 'node_modules/@paperclipai/server');
  const installed = join(server, 'dist/vendor/paperclip-runner');
  const codexVersion = JSON.parse(readFileSync(join(repo, 'packages/paperclip-runner/acpx-profiles.json'), 'utf8')).profiles.codex.agentRuntimeVersion;
  assert.match(codexVersion, /^\d+\.\d+\.\d+$/);
  writeFileSync(join(assets, 'codex-probe.mjs'), installedCodexProbeSource(
    '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/index.js', '/consumer', codexVersion), { mode: 0o644 });
  const codex = JSON.parse(isolated(['node', '/packages/codex-probe.mjs']).toString().trim());
  phase('codex_probe');
  assert.equal(codex.codexConsumerHostOnly, true);
  assert.equal(codex.codexPlatformPackageSource, 'official npm');
  assert.ok(existsSync(join(installed, 'providers/grok/launcher.cjs')));
  assert.equal(existsSync(join(consumer, 'node_modules/@paperclipai/grok-acp')), false);
  assert.equal(existsSync(join(installed, 'providers/grok/bin')), false);
  // Use real installed compiled code and its actual npm dependency graph. A
  // separate process prevents module resolution from borrowing this checkout.
  const probe = `
    import assert from 'node:assert/strict';
    import { verifyQualifiedAcpxInstallation } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js';
    import { resolveQualifiedAcpxProfile } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/qualified-profiles.js';
    const profile = resolveQualifiedAcpxProfile('grok', 'grok-4.7');
    const inspect = () => verifyQualifiedAcpxInstallation(profile, () => { throw new Error('Grok must not resolve an npm package'); });
    if (process.argv[2] === 'missing') await assert.rejects(inspect, /prerequisite missing/);
    else { const installation = await inspect(); assert.equal(installation.agentServerPackageJsonPath, null); assert.equal(installation.agentRuntimePackageJsonPath, null); await (await installation.openCommand()).close(); }
  `;
  writeFileSync(join(assets, 'probe.mjs'), probe, { mode: 0o644 });
  isolated(['node', '/packages/probe.mjs', 'missing']);
  // The binary was provisioned outside `native/grok` while the packages were
  // staged, so the assertion above still proves npm put nothing there. It moves
  // into place only now, so only the positive probe sees it.
  await awaited('grok', grokReady);
  mkdirSync(dirname(prerequisite), { recursive: true });
  renameSync(stagedGrok, prerequisite);
  isolated(['node', '/packages/probe.mjs', 'present'], { prerequisite });
  phase('grok_probes');
  console.log(JSON.stringify({ schema: 'paperclip.grok.public-npm-install.v1', sourceRevision, releaseVersion, lifecycleScriptsEnabled: true, lifecycleSentinelVerified: true, lifecycleNetwork: 'none', consumerImage: GROK_PUBLIC_INSTALL_IMAGE, consumerUid, consumerLockPreserved: true, cleanNpmInstall: true, packageCount: needed.size, codexPackedPayloadsOmitted: true, codexPackedPackagesChecked: tarballs.length, ...codex, builtinLauncherPresent: true, separateGrokPackage: false, npmProvisionedBinary: false, missingPrerequisiteRejected: true, provisionedBinaryVerified: true, commandLeaseVerified: true, providerCalls: 0 }));
  // Exercise Pi's public CLI and installed server, never a private workspace
  // package or binary override. Public dependency downloads are explicit and
  // isolated; the actual admission probe runs without a network or credentials.
  const piProbe = join(assets, 'pi-public-install-probe.mjs');
  cpSync(join(repo, 'scripts/pi-public-install-probe.mjs'), piProbe); chmodSync(piProbe, 0o644);
  // Pi assembles a bundled runtime in scratch space before atomic publication.
  // Keep the existing sandbox and memory bound; only this download needs more
  // temporary capacity than the smaller offline lifecycle probes.
  const setup = isolated(['node', '/consumer/node_modules/paperclipai/dist/index.js', 'runtime', 'setup', 'pi'], { download: true, temporarySizeMiB: 2048 }).toString();
  const receipt = JSON.parse(setup.trim());
  phase('pi_setup');
  assert.equal(receipt.status, 'installed_verified');
  assert.equal(receipt.target, 'linux-x64');
  assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), consumerLock, 'Pi setup must preserve the consumer dependency graph');
  // Verified launch leases also materialize the runtime in private scratch.
  // Docker defaults tmpfs to noexec. The offline admission probe must execute
  // its verified private snapshot while keeping lifecycle/download scratch noexec.
  console.log(isolated(['node', '/packages/pi-public-install-probe.mjs', '/consumer/node_modules/@paperclipai/server'], { temporarySizeMiB: 2048, temporaryExecutable: true }).toString().trim());
  phase('pi_probe');
  // Wall time per phase, so the slow part of this step is visible in the CI log
  // without re-running it. `*_wait_ms` is how long the main flow waited for a
  // prefetch that had not finished yet; zero means the overlap hid it entirely.
  console.log(JSON.stringify({ schema: 'paperclip.public-npm-install.timing.v1', ...timing }));
  if (process.env.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR) {
    const retained = retainRunnerQualificationPackages({ repo, output: process.env.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR, sourceRevision, releaseVersion, env,
      publicArchives: [...needed].map((name, index) => ({ name, file: tarballs[index] })),
    });
    console.log(JSON.stringify(retained));
  }
} finally {
  // An earlier failure must not leave a prefetch running after cleanup.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
