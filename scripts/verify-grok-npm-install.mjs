#!/usr/bin/env node
// Run on a disposable Linux verification host after pnpm build. No publication,
// credentials, inference, or changes to release versions. Native provisioning is
// explicit and separate from npm installation, and is removed in finally.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materializePublishManifest, prepareBundledPackage } from './prepare-bundled-package.mjs';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS, discoverMacPublicInstallToolchain, grokConsumerDockerArgs, macPublicInstallLifecyclePolicy, prepareMacPublicInstallNodeHeaders, publicPackProducerLock, runMacPublicInstallPhase, verifyPublicPackProducerLock } from './grok-public-install-sandbox.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, requestedOutput, ...extraArguments] = process.argv.slice(2);
assert.ok(mode === undefined || ['--pack-only', '--consume-pack'].includes(mode) && requestedOutput && !extraArguments.length,
  'Usage: verify-grok-npm-install.mjs [--pack-only <new-absolute-output-directory> | --consume-pack <packed-input-directory>]');
const packOnlyOutput = mode === '--pack-only' ? requestedOutput : undefined;
const consumePack = mode === '--consume-pack' ? requestedOutput : undefined;
const packTransferOutput = packOnlyOutput ?? process.env.PAPERCLIP_PUBLIC_PACK_OUTPUT;
if (packTransferOutput) {
  assert.ok(isAbsolute(packTransferOutput) && resolve(packTransferOutput) === packTransferOutput, 'Pack output must be an absolute normalized path');
  assert.ok(relative(repo, packTransferOutput).startsWith('..'), 'Pack output must be outside the checkout');
  assert.equal(existsSync(packTransferOutput), false, 'Pack output must be a new owned directory');
}
if (!packOnlyOutput && !consumePack) assert.equal(process.platform, 'linux', 'Run this verification on disposable EC2 Linux, not a developer host');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'paperclip-grok-public-install-')));
const prerequisite = join(root, 'native/grok');
const env = { ...process.env, NODE_PATH: '', PAPERCLIP_RELEASE_REUSE_UI_DIST: '1', npm_config_ignore_scripts: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
const run = (cmd, args, cwd = root, options = {}) => execFileSync(cmd, args, { cwd, env, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024, ...options });
const sourceRevision = run('git', ['rev-parse', 'HEAD'], repo).toString().trim();
const releaseVersion = `0.0.0-grok-verify.${sourceRevision.slice(0, 12)}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const browserSmoke = process.env.PAPERCLIP_PUBLIC_INSTALL_BROWSER_SMOKE === '1';
const browserOwner = `paperclip-public-install-${process.pid}-${Date.now()}`;
const offlineOwner = `${browserOwner}-offline`;
let browserNetworkCreated = false;
let offlineProbeStarted = false;
const packLifecycleSentinel = destination => {
  const sentinelSource = join(root, 'lifecycle-sentinel'); if (!existsSync(sentinelSource)) mkdirSync(sentinelSource);
  writeFileSync(join(sentinelSource, 'package.json'), JSON.stringify({
    name: 'paperclip-verification-lifecycle-sentinel', version: '1.0.0', private: true,
    scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'ok\')"' },
  }));
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], sentinelSource);
  return 'paperclip-verification-lifecycle-sentinel-1.0.0.tgz';
};
try {
  verification: {
  if (consumePack) {
    assert.equal(process.platform, 'darwin', 'Packed host consumption is only for the existing hosted macOS qualification legs');
    assert.ok(isAbsolute(consumePack) && resolve(consumePack) === consumePack && consumePack !== '/');
    const receipt = JSON.parse(readFileSync(join(consumePack, 'pack-receipt.json'), 'utf8'));
    assert.equal(receipt.schema, 'paperclip.public-npm-pack.v1');
    assert.equal(receipt.sourceRevision, sourceRevision, 'The package producer source must match this consumer');
    assert.equal(receipt.producerPlatform, 'linux-x64', 'The macOS consumer must inspect the Linux-produced public packages');
    const producerLock = verifyPublicPackProducerLock({ receipt, directory: consumePack, sourceRevision,
      sourceLock: run('git', ['show', `${sourceRevision}:pnpm-lock.yaml`], repo),
      required: process.env.PAPERCLIP_PUBLIC_PACK_REQUIRE_LOCK_PROVENANCE === '1' });
    const inputs = [...receipt.tarballs, receipt.lifecycleSentinel];
    assert.equal(new Set(inputs.map(item => item.name)).size, inputs.length, 'Duplicate public package');
    for (const input of inputs) {
      assert.match(input.name, /^[a-zA-Z0-9_.-]+\.tgz$/);
      assert.equal(sha256(readFileSync(join(consumePack, input.name))), input.sha256, 'Transferred public package checksum mismatch');
    }
    // The existing Linux producer's exact tarballs, never a host rebuild. Give
    // npm lifecycle and the installed runtime a fresh home/cache and a PATH
    // containing only the selected Node plus OS tools, not developer harnesses.
    const consumer = join(root, 'consumer'), home = join(root, 'home'), cache = join(root, 'cache');
    const bin = join(root, 'bin'), temporary = join(root, 'tmp');
    for (const path of [consumer, home, cache, bin, temporary]) mkdirSync(path);
    cpSync(process.execPath, join(bin, 'node')); chmodSync(join(bin, 'node'), 0o755);
    const npmCli = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    assert.ok(existsSync(npmCli), 'The selected hosted Node distribution must include npm');
    const npmRoot = realpathSync(dirname(dirname(npmCli)));
    const toolchain = discoverMacPublicInstallToolchain(), { developerRoot, compiler } = toolchain;
    const nodeHeaders = prepareMacPublicInstallNodeHeaders({ nodeExecutable: process.execPath, nodeVersion: process.version, destination: join(root, 'node-headers') });
    const nodeIdentity = path => ({ path, realpath: realpathSync(path), symlink: lstatSync(path).isSymbolicLink() });
    console.error(JSON.stringify({ schema: 'paperclip.hosted-macos.public-npm-prerequisites.v1',
      sourceRevision, consumerPlatform: `${process.platform}-${process.arch}`, nodeVersion: process.version,
      sourceNode: nodeIdentity(process.execPath), copiedNode: nodeIdentity(join(bin, 'node')), npmRoot, toolchain, nodeHeaders }));
    const isolatedEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: temporary,
      NODE_PATH: '', npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_loglevel: 'verbose', npm_config_timing: 'true', npm_config_logs_max: '3',
      npm_config_nodedir: nodeHeaders.destination, DEVELOPER_DIR: developerRoot, CC: compiler,
      CXX: toolchain.cxx, SDKROOT: toolchain.sdk, PYTHON: toolchain.python, NODE_GYP_FORCE_PYTHON: toolchain.python, PYTHONDONTWRITEBYTECODE: '1',
      PAPERCLIP_TELEMETRY_DISABLED: '1', PAPERCLIP_UPDATE_CHECK: '0', PAPERCLIP_OPEN_ON_LISTEN: 'false' };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    runMacPublicInstallPhase({ stage: 'scripts-disabled-install', command: join(bin, 'node'),
      args: [npmCli, 'install', '--ignore-scripts', '--omit=dev', ...inputs.map(input => join(consumePack, input.name))],
      cwd: consumer, env: isolatedEnv, cache, timeout: MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS });
    const sentinel = join(consumer, 'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
    assert.equal(existsSync(sentinel), false, 'Transfer download must not run dependency hooks');
    const lock = readFileSync(join(consumer, 'package-lock.json'));
    assert.ok(existsSync('/usr/bin/sandbox-exec'), 'Hosted Mac lifecycle qualification requires OS network isolation; npm offline alone is insufficient');
    const policy = join(root, 'lifecycle.sb');
    writeFileSync(policy, macPublicInstallLifecyclePolicy({ ownedRoot: root, npmRoot, developerRoot }), { mode: 0o600 });
    // Match buildcheck's compiler detection before running any dependency hook.
    // This preprocesses macros only; it creates no compiled object or binary.
    const compilerIdentity = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, compiler, '-E', '-P', '-x', 'c', '-'], {
      cwd: consumer, env: isolatedEnv, input: '__clang__ __GNUC__ __GNUC_MINOR__ __GNUC_PATCHLEVEL__ __clang_major__ __clang_minor__ __clang_patchlevel__\n',
      encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 }).trim();
    assert.match(compilerIdentity, /^1(?:\s+\d+){6}$/, 'Offline Apple compiler detection must return buildcheck’s seven numeric clang tokens');
    const cxxIdentity = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, toolchain.cxx, '-E', '-P', '-x', 'c++', '-'], {
      cwd: consumer, env: isolatedEnv, input: '__clang__ __GNUC__ __GNUC_MINOR__ __GNUC_PATCHLEVEL__ __clang_major__ __clang_minor__ __clang_patchlevel__\n',
      encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 }).trim();
    assert.match(cxxIdentity, /^1(?:\s+\d+){6}$/, 'Offline C++ compiler detection must return buildcheck’s seven numeric clang tokens');
    const pythonVersion = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, toolchain.python, '-c', 'import sys; print("%s.%s.%s" % sys.version_info[:3])'], {
      cwd: consumer, env: isolatedEnv, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 }).trim();
    assert.ok(/^3\.\d+\.\d+$/.test(pythonVersion) && Number(pythonVersion.split('.')[1]) >= 6, `Selected Python must support node-gyp (3.6+): ${toolchain.python} returned ${pythonVersion}`);
    console.error(JSON.stringify({ stage: 'offline-toolchain-preflight', status: 'passed', toolchain, compilerIdentity, cxxIdentity, pythonVersion }));
    runMacPublicInstallPhase({ stage: 'offline-lifecycle', command: '/usr/bin/sandbox-exec',
      args: ['-f', policy, join(bin, 'node'), npmCli, ...GROK_PUBLIC_INSTALL_LIFECYCLE.slice(1)],
      cwd: consumer, env: isolatedEnv, cache });
    assert.equal(readFileSync(sentinel, 'utf8'), 'ok');
    assert.ok(readFileSync(join(consumer, 'package-lock.json')).equals(lock), 'Host lifecycle must preserve the resolved graph');
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const paths = join(root, 'probe-paths.json');
    writeFileSync(paths, JSON.stringify({ consumer, dataDirectory: join(root, 'data'), readyPath: join(root, 'ready.json'), base: `http://127.0.0.1:${port}` }));
    const output = execFileSync(join(bin, 'node'), [join(repo, 'tests/release-smoke/installed-cli-probe.mjs'),
      receipt.releaseVersion, sourceRevision, 'offline', paths], { cwd: consumer, env: isolatedEnv,
      stdio: 'pipe', maxBuffer: 32 * 1024 * 1024, timeout: 135_000 }).toString().trim();
    const installed = JSON.parse(output.split('\n').at(-1));
    console.log(JSON.stringify({ schema: 'paperclip.hosted-macos.public-npm-install.v1', sourceRevision,
      producerPlatform: 'linux-x64', consumerPlatform: `${process.platform}-${process.arch}`,
      sameProducerTarballs: receipt.tarballs, isolatedHomeAndPath: true, lifecycleSentinelVerified: true,
      producerLock, producerLockVerified: producerLock !== undefined,
      consumerLockSha256: sha256(lock), consumerLockPreserved: true, lifecycleNetwork: 'macOS sandbox-exec network denied',
      ...installed, providerCalls: 0 }));
    break verification;
  }
  const builtRevision = JSON.parse(readFileSync(join(repo, 'server/dist/build-info.json'), 'utf8')).commit;
  assert.equal(builtRevision, sourceRevision, 'Public packages must be built from the selected source revision');
  const sourceLock = run('git', ['show', `${sourceRevision}:pnpm-lock.yaml`], repo);
  const buildLock = readFileSync(join(repo, 'pnpm-lock.yaml'));
  const producerLock = publicPackProducerLock({ sourceRevision, sourceLock, buildLock });
  // Canary's existing source-pack control builds only this host's daemon. The
  // paired release qualification supplies validated three-target assets and
  // must retain the full release-manifest requirement in every consumer.
  const installedMode = env.PAPERCLIP_RELEASE_RUNNER_ASSETS ? 'offline' : 'host-source';
  const installedBrowserMode = env.PAPERCLIP_RELEASE_RUNNER_ASSETS ? 'browser' : 'browser-host-source';
  if (env.PAPERCLIP_RELEASE_RUNNER_ASSETS) {
    for (const output of ['packages/paperclip-runner/dist', 'server/dist/vendor/paperclip-runner']) {
      run(process.execPath, [join(repo, 'scripts/release-runner-artifacts.mjs'), 'copy', sourceRevision,
        env.PAPERCLIP_RELEASE_RUNNER_ASSETS, join(repo, output)], repo);
    }
  }
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
  // Use the release CLI generator and bundle configuration without rewriting
  // cli/package.json or resolving product code through this checkout at runtime.
  const cliStage = join(root, 'cli'); mkdirSync(cliStage);
  const cliManifestPath = join(cliStage, 'package.json');
  run(process.execPath, [join(repo, 'scripts/generate-npm-package-json.mjs'), '--output', cliManifestPath], repo);
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'));
  cliManifest.version = releaseVersion;
  cliManifest.dependencies['@paperclipai/server'] = releaseVersion;
  writeFileSync(cliManifestPath, JSON.stringify(cliManifest));
  run(process.execPath, ['--input-type=module', '-e', `import esbuild from 'esbuild'; import config from ${JSON.stringify(pathToFileURL(join(repo, 'cli/esbuild.config.mjs')).href)}; await esbuild.build({ ...config, absWorkingDir: ${JSON.stringify(join(repo, 'cli'))}, outfile: ${JSON.stringify(join(cliStage, 'dist/index.js'))} });`], join(repo, 'cli'));
  chmodSync(join(cliStage, 'dist/index.js'), 0o755);
  run(process.execPath, ['--check', join(cliStage, 'dist/index.js')]);
  // Match release.sh's unified versioning in temporary staging directories.
  // Source manifests remain untouched, including independently versioned SDKs.
  if (packOnlyOutput) {
    // A host packaging check consumes the already-built selected workspace
    // closure. Do not install unrelated standalone plugins or alter that
    // host's dependency-script approval policy to pack this consumer graph.
    const workspace = new Set(JSON.parse(run('pnpm', ['list', '-r', '--depth', '-1', '--json'], repo)).map(pkg => pkg.name));
    for (const name of needed) {
      assert.ok(workspace.has(name), `Pack-only requires a built workspace dependency: ${name}`);
      assert.ok(existsSync(join(repo, packages.get(name).dir, 'dist')), `Missing built public package ${name}`);
    }
  } else run(process.execPath, [join(repo, 'scripts/build-standalone-public-packages.mjs')], repo);
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
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', root], cliStage);
  tarballs.push(join(root, `paperclipai-${releaseVersion}.tgz`));
  assert.ok(existsSync(tarballs.at(-1)));
  if (packTransferOutput) {
    // Reuse this exact producer for a separately isolated host consumer. This
    // mode packs bytes only; no dependency lifecycle or provider is invoked.
    mkdirSync(packTransferOutput, { mode: 0o700 });
    const packed = tarballs.map(path => {
      cpSync(path, join(packTransferOutput, basename(path)));
      return { name: basename(path), sha256: sha256(readFileSync(path)) };
    });
    const sentinelName = packLifecycleSentinel(packTransferOutput);
    assert.ok(readFileSync(join(repo, 'pnpm-lock.yaml')).equals(buildLock), 'Package production must preserve the resolved producer lock');
    writeFileSync(join(packTransferOutput, producerLock.sourceLock.name), sourceLock, { mode: 0o600 });
    writeFileSync(join(packTransferOutput, producerLock.buildLock.name), buildLock, { mode: 0o600 });
    const receipt = { schema: 'paperclip.public-npm-pack.v1', sourceRevision, releaseVersion,
      packageCount: needed.size + 1, tarballs: packed,
      producerPlatform: `${process.platform}-${process.arch}`, producerLock,
      lifecycleSentinel: { name: sentinelName, sha256: sha256(readFileSync(join(packTransferOutput, sentinelName))) }, providerCalls: 0 };
    writeFileSync(join(packTransferOutput, 'pack-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
    if (packOnlyOutput) break verification;
  }
  const assets = join(root, 'assets'); mkdirSync(assets, { mode: 0o755 });
  const consumer = join(root, 'consumer'); mkdirSync(consumer);
  const cache = join(root, 'cache'); mkdirSync(cache);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const tarball of tarballs) {
    const destination = join(assets, basename(tarball)); cpSync(tarball, destination); chmodSync(destination, 0o644);
  }
  // Prove lifecycle execution is real even if npm changes its script defaults.
  packLifecycleSentinel(assets);
  const sentinel = join(consumer, 'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
  const consumerUid = process.getuid();
  const isolated = (command, options = {}) => run('docker', grokConsumerDockerArgs({ assets, consumer, cache, uid: consumerUid, gid: process.getgid(), command, ...options }));
  // npm resolution is intentionally the public consumer graph, not the pnpm
  // workspace graph. Freeze that result before any lifecycle script can run.
  isolated(['npm', 'install', '--ignore-scripts', '--omit=dev', ...readdirSync(assets).filter(file => file.endsWith('.tgz')).map(file => `/packages/${file}`)], { download: true });
  assert.equal(existsSync(sentinel), false, 'Dependency download must not run lifecycle scripts');
  const consumerLock = readFileSync(join(consumer, 'package-lock.json'), 'utf8');
  // npm ci rejects bundled optional platform dependencies absent from its own
  // generated lock. Rebuild runs the deferred install hooks on the installed
  // graph without re-resolving it; network isolation and lock checks still hold.
  isolated(GROK_PUBLIC_INSTALL_LIFECYCLE);
  assert.equal(readFileSync(sentinel, 'utf8'), 'ok', 'Offline lifecycle scripts must actually execute');
  assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), consumerLock, 'Lifecycle execution must preserve the resolved consumer lock');
  for (const name of needed) {
    const installedManifest = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installedManifest.version, releaseVersion, `Installed release version for ${name}`);
  }
  assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules/paperclipai/package.json'), 'utf8')).version, releaseVersion);
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
    import { verifyQualifiedAcpxInstallation } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js';
    import { resolveQualifiedAcpxProfile } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/qualified-profiles.js';
    const profile = resolveQualifiedAcpxProfile('grok', 'grok-4.7');
    const inspect = () => verifyQualifiedAcpxInstallation(profile, () => { throw new Error('Grok must not resolve an npm package'); });
    if (process.argv[2] === 'missing') await assert.rejects(inspect, /prerequisite missing/);
    else { const installation = await inspect(); assert.equal(installation.agentServerPackageJsonPath, null); assert.equal(installation.agentRuntimePackageJsonPath, null); await (await installation.openCommand()).close(); }
  `;
  writeFileSync(join(assets, 'probe.mjs'), probe, { mode: 0o644 });
  isolated(['node', '/packages/probe.mjs', 'missing']);
  // Provision as the unprivileged verification user, never into the host's /opt.
  // Only the positive probe sees this file at the canonical sandbox path.
  run(process.execPath, [join(repo, 'packages/paperclip-runner/scripts/provision-grok.mjs'), prerequisite]);
  isolated(['node', '/packages/probe.mjs', 'present'], { prerequisite });
  cpSync(join(repo, 'tests/release-smoke/installed-cli-probe.mjs'), join(assets, 'installed-cli-probe.mjs'));
  // The pinned image's node user has a passwd entry required by initdb. Only
  // its private tmpfs holds instance state; the installed consumer is read-only.
  const cliProbeArgs = grokConsumerDockerArgs({ assets, consumer, cache, uid: 1000, gid: 1000,
    command: ['node', '/packages/installed-cli-probe.mjs', releaseVersion, sourceRevision, installedMode], temporarySizeMb: 1024, runtimeSmoke: true, containerName: offlineOwner });
  offlineProbeStarted = true;
  const cliProbeOutput = run('docker', cliProbeArgs, root, { timeout: 135_000 }).toString().trim();
  const cliReceipt = JSON.parse(cliProbeOutput.split('\n').at(-1));
  if (browserSmoke) {
    // Lifecycle and installed CLI readiness have already passed offline. The
    // separate browser phase uses ordinary Docker loopback publication: internal
    // networks omit published ports on supported Docker hosts. This fixture has
    // no provider credentials and the existing oracle stops before agent auth.
    run('docker', ['network', 'create', browserOwner]);
    browserNetworkCreated = true;
    run('docker', grokConsumerDockerArgs({ assets, consumer, cache, uid: 1000, gid: 1000,
      command: ['node', '/packages/installed-cli-probe.mjs', releaseVersion, sourceRevision, installedBrowserMode],
      temporarySizeMb: 1024, runtimeSmoke: true, browserNetwork: browserOwner, containerName: browserOwner }));
    let ready;
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      try { ready = JSON.parse(run('docker', ['exec', browserOwner, 'cat', '/tmp/paperclip-installed-smoke-ready.json']).toString()); break; }
      catch { if (run('docker', ['inspect', '--format', '{{.State.Running}}', browserOwner]).toString().trim() !== 'true') throw new Error('Installed CLI browser fixture exited before readiness'); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'Installed CLI browser fixture did not become ready');
    const port = run('docker', ['port', browserOwner, '3100/tcp']).toString().trim();
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    execFileSync(process.execPath, [join(repo, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/release-smoke/playwright.config.ts',
      '--grep', 'installed artifact first-run entry', '--workers', '1', '--retries', '0'], {
      cwd: repo, env: { ...env, PAPERCLIP_RELEASE_SMOKE_BASE_URL: `http://${port}`,
        PAPERCLIP_RELEASE_SMOKE_BOOTSTRAP_PATH: ready.invitePath, PAPERCLIP_RELEASE_SMOKE_SOURCE_REVISION: sourceRevision },
      stdio: 'inherit', timeout: 120_000,
    });
    cliReceipt.installedUiFirstRunBrowserPassed = true;
    cliReceipt.browserNetwork = 'owned bridge with loopback publication';
  }
  const tarballHashes = tarballs.map(path => ({ name: basename(path), sha256: sha256(readFileSync(path)) }));
  assert.ok(readFileSync(join(repo, 'pnpm-lock.yaml')).equals(buildLock), 'Qualification must preserve the resolved producer lock');
  console.log(JSON.stringify({ schema: 'paperclip.grok.public-npm-install.v1', sourceRevision, releaseVersion, producerLock, producerLockPreserved: true, lifecycleScriptsEnabled: true, lifecycleSentinelVerified: true, lifecycleNetwork: 'none', consumerImage: GROK_PUBLIC_INSTALL_IMAGE, consumerUid, consumerLockPreserved: true, consumerLockSha256: sha256(consumerLock), cleanNpmInstall: true, packageCount: needed.size + 1, tarballs: tarballHashes, ...cliReceipt, builtinLauncherPresent: true, separateGrokPackage: false, npmProvisionedBinary: false, missingPrerequisiteRejected: true, provisionedBinaryVerified: true, commandLeaseVerified: true, providerCalls: 0 }));
  }
} finally {
  const cleanupErrors = [];
  for (const owner of [offlineProbeStarted && offlineOwner, browserNetworkCreated && browserOwner].filter(Boolean)) {
    try { run('docker', ['rm', '--force', owner], root, { timeout: 30_000 }); }
    catch (error) { if (!String(error.stderr).includes('No such container')) cleanupErrors.push(error); }
  }
  if (browserNetworkCreated) {
    try { run('docker', ['network', 'rm', browserOwner], root, { timeout: 30_000 }); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { rmSync(root, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Public-install fixture cleanup could not be confirmed');
}
