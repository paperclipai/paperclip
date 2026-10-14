#!/usr/bin/env node
// Run on a disposable Linux verification host after pnpm build. No publication,
// credentials, inference, or changes to release versions. Native provisioning is
// explicit and separate from npm installation, and is removed in finally.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packConcurrency, packStagedPackages, packTimings } from './pack-staged-packages.mjs';
import { materializePublishManifest } from './prepare-bundled-package.mjs';
import { publicInstallClosure } from './public-install-closure.mjs';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, assertInstalledNativeConsumerContinuity, assertNoBundledCodexPayloads, grokConsumerDockerArgs, installedCodexProbeSource, installedDaemonProbeSource, macNodeHeadersDirectory, macPublicInstallLifecycleProfile, macInstalledStartupProbeSource, runMacInitialInstallWithDiagnostics } from './grok-public-install-sandbox.mjs';
import { startPrefetch, stopPrefetches } from './prefetch-child.mjs';
import { retainRunnerQualificationPackages } from './retain-runner-qualification-packages.mjs';
import { bundledInstallTimings, startBundledInstalls } from './stage-bundled-packages.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function verifyMacConsumer(packageDirectory, sourceRevision, receiptPath) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Mac clean consumers run only on disposable hosted CI');
  assert.equal(process.platform, 'darwin');
  assert.ok(['arm64', 'x64'].includes(process.arch));
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  const packages = realpathSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(join(packages, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'paperclip.runner.public-packages/v1');
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.ok(manifest.archives.some(entry => entry.name === '@paperclipai/server'));
  assert.ok(manifest.archives.some(entry => entry.name === 'paperclipai'));
  assert.equal(new Set(manifest.archives.map(entry => entry.name)).size, manifest.archives.length);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'paperclip-mac-public-install-')));
  try {
    const consumer = join(root, 'consumer'), home = join(root, 'home'), tools = join(root, 'tools');
    for (const directory of [consumer, home, tools, join(root, 'tmp'), join(root, 'cache')]) mkdirSync(directory);
    const npmCli = realpathSync(execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim());
    symlinkSync(process.execPath, join(tools, 'node'));
    const env = { PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: join(root, 'tmp'),
      npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
    const run = (command, args, cwd = consumer, runEnv = env) => execFileSync(command, args, { cwd, env: runEnv,
      timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    const tarballs = manifest.archives.map(entry => {
      assert.match(entry.file, /^[A-Za-z0-9._-]+\.tgz$/); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      const path = join(packages, entry.file);
      assert.equal(realpathSync(path), path);
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256);
      assertNoBundledCodexPayloads(run('/usr/bin/tar', ['-tzf', path]).trim().split('\n'));
      return path;
    });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const sentinelSource = join(root, 'lifecycle-sentinel'); mkdirSync(sentinelSource);
    writeFileSync(join(sentinelSource, 'package.json'), JSON.stringify({ name: 'paperclip-verification-lifecycle-sentinel', version: '1.0.0',
      scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'ok\')"' } }));
    run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', root], sentinelSource);
    const sentinelTar = join(root, readdirSync(root).find(name => name.endsWith('.tgz')));
    runMacInitialInstallWithDiagnostics(() => run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--omit=dev', '--timing', ...tarballs, sentinelTar]),
      { sourceRevision, platform: process.platform, architecture: process.arch, cacheDirectory: join(root, 'cache'), receiptPath });
    const sentinel = join(consumer, 'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
    assert.equal(existsSync(sentinel), false);
    const lock = readFileSync(join(consumer, 'package-lock.json'), 'utf8');
    const profile = join(root, 'lifecycle.sb'); writeFileSync(profile, macPublicInstallLifecycleProfile(root));
    const listener = createServer(socket => socket.end());
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    try {
      const port = listener.address().port;
      const networkProbe = `import assert from 'node:assert/strict'; import net from 'node:net';
        const socket = net.connect({host:'127.0.0.1',port:${port}}); socket.setTimeout(3000,()=>process.exit(2));
        socket.once('connect',()=>{socket.destroy(); ${"process.argv[1] === 'denied' ? process.exit(3) : process.exit(0)"};});
        socket.once('error',error=>{assert.equal(process.argv[1],'denied'); assert.equal(error.code,'EPERM');});`;
      run(process.execPath, ['--input-type=module', '-e', networkProbe, 'allowed']);
      run('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '--input-type=module', '-e', networkProbe, 'denied']);
    } finally { await new Promise(resolve => listener.close(resolve)); }
    const nodeHeaders = macNodeHeadersDirectory(process.execPath, process.versions.node);
    run('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, npmCli, 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts', '--foreground-scripts'],
      consumer, { ...env, npm_config_nodedir: nodeHeaders });
    assert.equal(readFileSync(sentinel, 'utf8'), 'ok');
    assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), lock);
    for (const entry of manifest.archives) {
      assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules', entry.name, 'package.json'))).version, manifest.releaseVersion);
    }
    const server = join(consumer, 'node_modules/@paperclipai/server'), installed = join(server, 'dist/vendor/paperclip-runner');
    const probe = (name, source) => { const file = join(root, name); writeFileSync(file, source); return JSON.parse(run(process.execPath, [file]).trim()); };
    const daemon = probe('daemon-probe.mjs', installedDaemonProbeSource(installed, consumer, sourceRevision));
    const codex = probe('codex-probe.mjs', installedCodexProbeSource(join(installed, 'index.js'), consumer, undefined, { nativeCodex: true }));
    const startupScript = macInstalledStartupProbeSource(consumer, server, daemon.sha256, join(repo, 'tests/runner-e2e/installed-cli.ts'));
    const startupFile = join(root, 'startup-probe.mts'); writeFileSync(startupFile, startupScript);
    const startup = JSON.parse(run(process.execPath, ['--import', 'tsx', startupFile], join(repo, 'server')).trim());
    const receipt = { schema: 'paperclip.runner.mac-public-install.v1', sourceRevision, platform: process.platform, architecture: process.arch,
      cleanNpmInstall: true, packageCount: manifest.archives.length, codexPackedPayloadsOmitted: true,
      consumerLockPreserved: true, lifecycleSentinelVerified: true, lifecycleNodeHeadersVerified: true, lifecycleNodeVersion: process.versions.node,
      lifecycleNetwork: 'sandbox-exec denied (loopback negative control)',
      ...daemon, ...codex, startup, providerCalls: 0 };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
async function verifyLinuxArmConsumer(packageDirectory, sourceRevision, receiptPath) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Native clean consumers run only on disposable hosted CI');
  assert.equal(process.platform + '-' + process.arch, 'linux-arm64', 'ARM qualification requires a native ARM host');
  assert.equal(process.versions.node.split('.')[0], '24', 'ARM host startup requires the qualified Node24 runtime');
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  const packages = realpathSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(join(packages, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'paperclip.runner.public-packages/v1');
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.ok(manifest.archives.some(entry => entry.name === '@paperclipai/server'));
  assert.ok(manifest.archives.some(entry => entry.name === 'paperclipai'));
  assert.equal(new Set(manifest.archives.map(entry => entry.name)).size, manifest.archives.length);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'paperclip-arm-public-install-')));
  try {
    const assets = join(root, 'assets'), consumer = join(root, 'consumer'), cache = join(root, 'cache');
    for (const directory of [assets, consumer, cache]) mkdirSync(directory);
    const run = (command, args, cwd = root) => execFileSync(command, args, { cwd,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    const platform = 'linux/arm64';
    run('docker', ['pull', '--platform', platform, GROK_PUBLIC_INSTALL_IMAGE]);
    const isolated = (command, options = {}) => run('docker', grokConsumerDockerArgs({ assets, consumer, cache,
      uid: process.getuid(), gid: process.getgid(), platform, command, ...options }));
    for (const entry of manifest.archives) {
      assert.match(entry.file, /^[A-Za-z0-9._-]+\.tgz$/); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      const tarball = join(packages, entry.file);
      assert.equal(realpathSync(tarball), tarball);
      assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), entry.sha256);
      assertNoBundledCodexPayloads(run('tar', ['-tzf', tarball]).trim().split('\n'));
      cpSync(tarball, join(assets, entry.file)); chmodSync(join(assets, entry.file), 0o644);
    }
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const sentinelSource = join(root, 'lifecycle-sentinel'); mkdirSync(sentinelSource);
    writeFileSync(join(sentinelSource, 'package.json'), JSON.stringify({ name: 'paperclip-verification-lifecycle-sentinel', version: '1.0.0',
      scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'ok\')"' } }));
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', assets], sentinelSource);
    isolated(['npm', 'install', '--ignore-scripts', '--omit=dev', ...readdirSync(assets).filter(file => file.endsWith('.tgz')).map(file => `/packages/${file}`)], { download: true });
    const sentinel = join(consumer, 'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
    assert.equal(existsSync(sentinel), false);
    const lock = readFileSync(join(consumer, 'package-lock.json'), 'utf8');
    isolated(GROK_PUBLIC_INSTALL_LIFECYCLE);
    assert.equal(readFileSync(sentinel, 'utf8'), 'ok');
    assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), lock);
    for (const entry of manifest.archives) {
      assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules', entry.name, 'package.json'))).version, manifest.releaseVersion);
    }
    const server = '/consumer/node_modules/@paperclipai/server', installed = server + '/dist/vendor/paperclip-runner';
    const probe = (name, source, options = {}) => { writeFileSync(join(assets, name), source); return JSON.parse(isolated(['node', '/packages/' + name], options).trim()); };
    const daemon = probe('daemon-probe.mjs', installedDaemonProbeSource(installed, '/consumer', sourceRevision));
    assert.equal(daemon.target, 'linux-arm64');
    const codex = probe('codex-probe.mjs', installedCodexProbeSource(installed + '/index.js', '/consumer', undefined, { nativeCodex: true }));
    cpSync(join(repo, 'tests/runner-e2e/installed-cli.ts'), join(assets, 'installed-cli.ts'));
    writeFileSync(join(assets, 'types.js'), stripTypeScriptTypes(readFileSync(join(repo, 'tests/runner-e2e/types.ts'), 'utf8')));
    const home = join(root, 'host-home'), hostTmp = join(root, 'host-tmp');
    for (const directory of [home, hostTmp]) mkdirSync(directory, { mode: 0o700 });
    const hostEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: hostTmp, LC_ALL: 'C', TZ: 'UTC' };
    const hostProbe = (name, source) => {
      const file = join(assets, name); writeFileSync(file, source);
      return JSON.parse(execFileSync(process.execPath, [file], { cwd: consumer, env: hostEnv,
        timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }).trim());
    };
    const hostServer = join(consumer, 'node_modules/@paperclipai/server'), hostInstalled = join(hostServer, 'dist/vendor/paperclip-runner');
    const hostDaemon = () => hostProbe('host-daemon-probe.mjs', installedDaemonProbeSource(hostInstalled, consumer, sourceRevision));
    const hostCodex = () => hostProbe('host-codex-probe.mjs', installedCodexProbeSource(join(hostInstalled, 'index.js'), consumer, undefined, { nativeCodex: true }));
    const digest = value => createHash('sha256').update(value).digest('hex');
    const beforeCodex = hostCodex();
    const before = { lockSha256: digest(lock), runnerSha256: hostDaemon().sha256.slice(7), codexCommandSha256: beforeCodex.codexCommandSha256, codexNativeExecutableSha256: beforeCodex.codexNativeExecutableSha256 };
    assert.equal(before.runnerSha256, daemon.sha256.slice(7), 'Docker and host must select the same packaged daemon bytes');
    assert.equal(before.codexCommandSha256, codex.codexCommandSha256, 'Docker and host must select the same official Codex command bytes');
    assert.equal(before.codexNativeExecutableSha256, codex.codexNativeExecutableSha256, 'Docker and host must select the same official native Codex payload bytes');
    const hostHeader = process.report.getReport().header;
    assert.match(hostHeader.glibcVersionRuntime || '', /^\d+\.\d+$/, 'Native host startup must report its actual GNU libc ABI');
    const startup = hostProbe('host-startup-probe.mjs', macInstalledStartupProbeSource(consumer, hostServer, daemon.sha256, join(assets, 'installed-cli.ts')));
    const afterCodex = hostCodex();
    const after = { lockSha256: digest(readFileSync(join(consumer, 'package-lock.json'))), runnerSha256: hostDaemon().sha256.slice(7), codexCommandSha256: afterCodex.codexCommandSha256, codexNativeExecutableSha256: afterCodex.codexNativeExecutableSha256 };
    assertInstalledNativeConsumerContinuity(before, after);
    assert.equal(startup.runnerSha256, before.runnerSha256);
    assert.equal(startup.codexSha256, before.codexCommandSha256);
    const receipt = { schema: 'paperclip.runner.linux-arm64-public-install.v1', sourceRevision, platform: process.platform, architecture: process.arch,
      cleanNpmInstall: true, packageCount: manifest.archives.length, codexPackedPayloadsOmitted: true,
      consumerImage: GROK_PUBLIC_INSTALL_IMAGE, consumerImagePlatform: platform,
      consumerLockPreserved: true, lifecycleSentinelVerified: true, lifecycleNetwork: 'none',
      startupEnvironment: 'native host, same installed graph, isolated empty homes',
      startupHost: { nodeVersion: process.versions.node, nodeModulesAbi: process.versions.modules, glibcVersionRuntime: hostHeader.glibcVersionRuntime, kernelRelease: hostHeader.osRelease },
      installedIdentityBefore: before, installedIdentityAfter: after,
      ...daemon, ...codex, startup, providerCalls: 0 };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[2] === '--linux-arm64-consumer') {
  assert.equal(process.argv.length, 6, 'Usage: --linux-arm64-consumer PACKAGE_DIRECTORY SOURCE_SHA RECEIPT_PATH');
  await verifyLinuxArmConsumer(process.argv[3], process.argv[4], process.argv[5]);
} else if (process.argv[2] === '--mac-consumer') {
  assert.equal(process.argv.length, 6, 'Usage: --mac-consumer PACKAGE_DIRECTORY SOURCE_SHA RECEIPT_PATH');
  await verifyMacConsumer(process.argv[3], process.argv[4], process.argv[5]);
} else {
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
// Every background child, downloads and bundled-dependency installs alike, is
// stopped in `finally`; `downloads` is the subset the timing line reports as
// prefetches.
const prefetches = [];
const downloads = [];
const timing = {};
// A prefetch failure surfaces where its result is awaited, never as an
// unhandled rejection that would mask an earlier staging error.
const prefetch = (name, cmd, args) => {
  const handle = startPrefetch({ name, cmd, args, cwd: root, env, logPath: join(prefetched, `${name}.log`) });
  prefetches.push(handle);
  downloads.push(handle);
  return handle.done;
};
let phaseStarted = performance.now();
const phase = name => { const now = performance.now(); timing[`${name}_ms`] = Math.round(now - phaseStarted); phaseStarted = now; };
const awaited = async (name, promise) => { const started = performance.now(); await promise; timing[`${name}_wait_ms`] = Math.round(performance.now() - started); };
try {
  const imageReady = prefetch('image', 'docker', ['pull', '--platform', 'linux/amd64', GROK_PUBLIC_INSTALL_IMAGE]);
  // Provision as the unprivileged verification user, never into the host's /opt.
  // Only the positive probe sees this file at the canonical sandbox path.
  const grokReady = prefetch('grok', process.execPath, [join(repo, 'packages/paperclip-runner/scripts/provision-grok.mjs'), stagedGrok]);
  // The server, the CLI and every public workspace package they reach through
  // `workspace:` specs. The npm cache warm-up reads the same closure, so both
  // take it from one module.
  const { packages, needed } = publicInstallClosure(repo);
  // release.sh also builds the standalone public packages (the sandbox-provider
  // plugins outside the pnpm workspace) before it stages anything, because it
  // publishes them. Nothing staged here reaches them: `needed` is closed under
  // `workspace:` specs, so every package staged below is a workspace package
  // that `pnpm build` already built, and that build would only cost one
  // network install and compile per plugin whose output no tarball reads.
  // Canary Dry Run still runs it through release.sh. The one path that does
  // read a standalone build is qualification-package retention at the end:
  // it packs the Daytona plugin from its `dist`, which only this build
  // produces, so the build runs when retention is requested and nowhere else.
  const retainQualificationPackages = Boolean(process.env.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR);
  if (retainQualificationPackages) {
    const standaloneStarted = performance.now();
    run(process.execPath, [join(repo, 'scripts/build-standalone-public-packages.mjs')], repo);
    timing.stage_standalone_build_ms = Math.round(performance.now() - standaloneStarted);
  }
  // The server's `ui-dist` payload is prepared here; with the reuse flag set
  // above, that copies the `ui/dist` that `pnpm build` produced instead of
  // building the UI again.
  const uiDistStarted = performance.now();
  run('bash', [join(repo, 'scripts/prepare-server-ui-dist.sh')], repo);
  timing.stage_ui_dist_ms = Math.round(performance.now() - uiDistStarted);
  // Match release.sh's unified versioning in temporary staging directories.
  // Source manifests remain untouched, including independently versioned SDKs.
  // Each package's published files are staged into `source-<index>` and its
  // pack input into `package-<index>`, with <index> in dependency order so the
  // tarball list keeps matching `needed`. The packages that bundle dependencies
  // each need a host-side `npm install` of their bundled closure; those installs
  // write only their own `package-<index>` and read nothing another package
  // produces, so they start first and run together while the other packages
  // are copied, instead of one after another inside one loop. Packing is a
  // Node start-up plus CPU-bound gzip per package that reads only the package's
  // own directory, so the packs also run together, each into its own
  // `pack-<index>`, and the tarballs are checked in order once all are made.
  const entries = [...needed].map((name, index) => {
    const { dir, manifest } = packages.get(name);
    const bundled = (manifest.bundleDependencies ?? manifest.bundledDependencies ?? []).length > 0;
    return { name, index, dir, manifest, bundled, target: join(root, `package-${index}`), stagedSource: join(root, `source-${index}`), destination: join(root, `pack-${index}`) };
  });
  const stageSource = ({ dir, manifest, stagedSource }) => {
    mkdirSync(stagedSource);
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
    return releaseManifest;
  };
  const sourcesStarted = performance.now();
  for (const entry of entries.filter(entry => entry.bundled)) stageSource(entry);
  const installsStarted = performance.now();
  const installs = startBundledInstalls(entries.filter(entry => entry.bundled), { logDir: prefetched, cwd: repo });
  prefetches.push(...installs.map(({ handle }) => handle));
  for (const entry of entries.filter(entry => !entry.bundled)) {
    const releaseManifest = stageSource(entry);
    mkdirSync(entry.target);
    cpSync(entry.stagedSource, entry.target, { recursive: true });
    writeFileSync(join(entry.target, 'package.json'), JSON.stringify(materializePublishManifest(releaseManifest)));
  }
  timing.stage_sources_ms = Math.round(performance.now() - sourcesStarted);
  await awaited('bundled', Promise.all(installs.map(({ handle }) => handle.done)));
  timing.stage_bundled_ms = Math.round(performance.now() - installsStarted);
  const packStarted = performance.now();
  // The bundled packages make the largest tarballs, so they are launched first
  // and the short packs fill the remaining slots behind them. Each pack is
  // registered for cleanup as it starts, so a failure stops the ones still
  // running before the scratch root is removed. The results are put back into
  // dependency order before the tarballs are checked and copied.
  const concurrency = packConcurrency();
  const packs = await packStagedPackages([...entries].sort((a, b) => Number(b.bundled) - Number(a.bundled)), { logDir: prefetched, env, concurrency, register: handle => prefetches.push(handle) });
  packs.sort((a, b) => a.index - b.index);
  const checksStarted = performance.now();
  const tarballs = packs.map(({ tarball }) => tarball);
  for (const tarball of tarballs) assertNoBundledCodexPayloads(run('tar', ['-tzf', tarball]).toString().trim().split('\n'));
  timing.stage_pack_check_ms = Math.round(performance.now() - checksStarted);
  timing.stage_pack_ms = Math.round(performance.now() - packStarted);
  Object.assign(timing, packTimings(packs, concurrency));

  if (process.env.PAPERCLIP_RUNNER_PUBLIC_PACKS_DIR) {
    const output = resolve(process.env.PAPERCLIP_RUNNER_PUBLIC_PACKS_DIR);
    assert.equal(JSON.parse(readFileSync(join(repo, 'server/dist/build-info.json'))).commit, sourceRevision);
    assert.ok(!existsSync(output), 'Never replace retained public packages');
    mkdirSync(output, { recursive: true });
    const archives = [...needed].map((name, index) => {
      const file = basename(tarballs[index]); cpSync(tarballs[index], join(output, file));
      return { name, file, sha256: createHash('sha256').update(readFileSync(tarballs[index])).digest('hex') };
    });
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({
      schema: 'paperclip.runner.public-packages/v1', sourceRevision, releaseVersion,
      publicInstallationVerified: false, providerCalls: 0, archives,
    }, null, 2) + '\n');
  }
  const assets = join(root, 'assets'); mkdirSync(assets, { mode: 0o755 });
  const consumer = join(root, 'consumer'); mkdirSync(consumer);
  // CI can point this at a cache that scripts/warm-public-install-npm-cache.mjs
  // filled with the same public registry graph while `pnpm build` ran. npm
  // checks every cached tarball against the integrity its own resolution
  // records, so a warm cache changes where bytes come from, never what is
  // installed; the consumer directory and its lock still start empty.
  const cache = process.env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE ? resolve(process.env.PAPERCLIP_PUBLIC_INSTALL_NPM_CACHE) : join(root, 'cache');
  mkdirSync(cache, { recursive: true });
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
  // without re-running it. `*_prefetch_ms` runs from a download's start to its
  // last output, and `*_wait_ms` is how long the main flow waited for a
  // prefetch that had not finished yet; zero means the overlap hid it entirely.
  // `stage_ui_dist_ms`, `stage_sources_ms`, `stage_bundled_ms` and
  // `stage_pack_ms` split the staging phase, and `stage_bundled_<package>_ms`
  // is each concurrent install. `stage_standalone_build_ms` appears only when
  // qualification-package retention made the standalone build necessary.
  const downloaded = Object.fromEntries(downloads.map(({ name, durationMs }) => [`${name}_prefetch_ms`, durationMs]));
  console.log(JSON.stringify({ schema: 'paperclip.public-npm-install.timing.v1', ...timing, ...downloaded, ...bundledInstallTimings(installs) }));
  if (retainQualificationPackages) {
    const retained = retainRunnerQualificationPackages({ repo, output: process.env.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR, sourceRevision, releaseVersion, env,
      publicArchives: [...needed].map((name, index) => ({ name, file: tarballs[index] })),
    });
    console.log(JSON.stringify(retained));
  }
} finally {
  // An earlier failure must not leave a prefetch running, and scratch is
  // removed only once both children have stopped writing into it.
  await stopPrefetches(prefetches);
  rmSync(root, { recursive: true, force: true });
}
}
