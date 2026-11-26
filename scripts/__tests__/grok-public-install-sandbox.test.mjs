import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWorkspacePackage, parseWorkspaceEntries } from '../build-standalone-public-packages.mjs';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, assertInstalledCodexPlatformProvenance, assertInstalledNativeConsumerContinuity, assertNoBundledCodexPayloads, grokConsumerDockerArgs, installedClaudeProbeSource, installedCodexProbeSource, installedDaemonProbeSource, macNodeHeadersDirectory, macPublicInstallLifecycleProfile, macInstalledStartupProbeSource, runMacInitialInstallWithDiagnostics } from '../grok-public-install-sandbox.mjs';
import { verifyPiPackagedDaemon } from '../pi-public-install-probe.mjs';
import { publicInstallClosure } from '../public-install-closure.mjs';
import { runnerBinaryTarget } from '../../packages/paperclip-runner/src/live/runner-binary.ts';

const paths = { assets: '/private/staging/assets', consumer: '/private/staging/consumer', cache: '/private/staging/cache', uid: 1001, gid: 1001 };
const values = (args, flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);

test('installed Claude admission propagates failure without emitting a passing receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-claude-admission-'));
  try {
    const fixture = join(root, 'runner.mjs'), probe = join(root, 'probe.mjs');
    writeFileSync(probe, installedClaudeProbeSource(fixture));
    writeFileSync(fixture, "export async function probeAcpxClaudeInstallation(model) { if (model !== 'claude-opus-5-5') throw Error('wrong model'); }\n");
    const accepted = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 5000 });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).packageIntegrityAndNoFollowLease, 'passed');
    assert.equal(JSON.parse(accepted.stdout).providerCalls, 0);
    writeFileSync(fixture, "export async function probeAcpxClaudeInstallation() { throw Error('integrity rejected'); }\n");
    const rejected = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary Claude consumer admission rejects authority overrides before invoking the verifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-claude-authority-'));
  try {
    const fixture = join(root, 'runner.mjs'), probe = join(root, 'probe.mjs');
    writeFileSync(probe, installedClaudeProbeSource(fixture));
    writeFileSync(fixture, "export async function probeAcpxClaudeInstallation() { throw Error('provider verifier invoked'); }\n");
    for (const key of ['PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT', 'PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST']) {
      const rejected = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, [key]: root } });
      assert.notEqual(rejected.status, 0);
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /AssertionError/);
      assert.doesNotMatch(rejected.stderr, /provider verifier invoked/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Mac initial install failures retain bounded npm progress without secret or environment values', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-install-diagnostics-test-')));
  try {
    const cacheDirectory = join(root, 'cache'), logs = join(cacheDirectory, '_logs'), receiptPath = join(root, 'failure.json');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, '0000-debug-0.log'), '0 timing idealTree:init Completed in 987654321ms\n');
    const debug = Array.from({ length: 1000 }, (_, index) => `${index} timing idealTree:node_modules/private-secret Completed in ${index}ms`).join('\n');
    writeFileSync(join(logs, '0010-debug-0.log'), debug + '\n1001 verbose reify PASSWORD=991122ms\n'
      + '1002 http fetch GET 200 https://user:password@registry.npmjs.org/pkg?token=query-secret 312ms (cache miss)\n'
      + '1003 verbose cli /private/secret/path --token=argv-secret\n1004 silly fetch manifest Authorization=Bearer-header-secret\n');
    writeFileSync(join(logs, '0020-timing.json'), JSON.stringify({ timers: { 'idealTree:userRequests': 92967, 'reify:unpack': 76,
      'ENV_SECRET': 112233, 'reify:private-secret': 17 }, environment: { PASSWORD: 'environment-secret' } }));
    const original = Object.assign(new Error('password=exception-secret'), { code: 'ETIMEDOUT', errno: -60, status: 1, signal: 'SIGTERM',
      stdout: 'stdout-secret', stderr: 'stderr-secret', spawnargs: ['--token=argument-secret'] });
    const options = { sourceRevision: 'a'.repeat(40), platform: 'darwin', architecture: 'x64', cacheDirectory, receiptPath };
    assert.throws(() => runMacInitialInstallWithDiagnostics(() => { throw original; }, options), error => error === original);
    const text = readFileSync(receiptPath, 'utf8'), receipt = JSON.parse(text);
    assert.equal(receipt.sourceRevision, options.sourceRevision); assert.equal(receipt.platform, 'darwin'); assert.equal(receipt.architecture, 'x64');
    assert.equal(receipt.outcome, 'FAILED'); assert.equal(receipt.qualified, false); assert.equal(receipt.runtimeNotAttempted, true);
    assert.equal(receipt.phase, 'initial-npm-install'); assert.equal(receipt.providerCalls, 0); assert.equal(receipt.timeoutMilliseconds, 600000);
    assert.ok(receipt.elapsedMilliseconds >= 0);
    assert.deepEqual(receipt.error, { code: 'ETIMEDOUT', status: 1, signal: 'SIGTERM', errno: -60 });
    assert.equal(receipt.npmDiagnosticTail.length, 2);
    assert.ok(receipt.npmDiagnosticTail.every(tail => tail.entries.length <= 32));
    assert.equal(receipt.npmDiagnosticTail[0].truncated, true);
    assert.ok(receipt.npmDiagnosticTail[1].entries.some(entry => entry.phase === 'idealTree:userRequests' && entry.durationMilliseconds === 92967));
    assert.ok(receipt.npmDiagnosticTail[0].entries.some(entry => entry.method === 'GET' && entry.status === 200 && entry.durationMilliseconds === 312));
    assert.ok(Buffer.byteLength(text) < 10000);
    assert.doesNotMatch(text, /secret|PASSWORD|Authorization|https:|private|991122|987654321|112233/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Mac install diagnostics never follow outside log symlinks or replace the primary failure', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-install-diagnostics-boundary-')));
  try {
    const cacheDirectory = join(root, 'cache'), logs = join(cacheDirectory, '_logs'), receiptPath = join(root, 'failure.json');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(root, 'outside.log'), '1 timing idealTree:userRequests Completed in 987654321ms\n');
    symlinkSync(join(root, 'outside.log'), join(logs, '0001-debug-0.log'));
    const original = Object.assign(new Error('primary'), { code: 'unsafe-secret', status: null, signal: 'unsafe-secret' });
    const options = { sourceRevision: 'b'.repeat(40), platform: 'darwin', architecture: 'arm64', cacheDirectory, receiptPath };
    assert.throws(() => runMacInitialInstallWithDiagnostics(() => { throw original; }, options), error => error === original);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.deepEqual(receipt.npmDiagnosticTail, []); assert.equal(receipt.error.code, null); assert.equal(receipt.error.signal, null);
    rmSync(receiptPath); mkdirSync(receiptPath);
    assert.throws(() => runMacInitialInstallWithDiagnostics(() => { throw original; }, options), error => error === original);
    rmSync(receiptPath, { recursive: true }); rmSync(logs, { recursive: true }); symlinkSync(root, logs);
    assert.throws(() => runMacInitialInstallWithDiagnostics(() => { throw original; }, options), error => error === original);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')).npmDiagnosticTail, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('successful Mac installs do not create failed receipts or change the bounded install contract', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-install-diagnostics-success-')));
  try {
    const receiptPath = join(root, 'receipt.json');
    assert.equal(runMacInitialInstallWithDiagnostics(() => 'installed', { sourceRevision: 'c'.repeat(40), platform: 'darwin',
      architecture: 'x64', cacheDirectory: join(root, 'cache'), receiptPath }), 'installed');
    assert.equal(existsSync(receiptPath), false);
    const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
    assert.match(source, /timeout: 10 \* 60_000/);
    assert.match(source, /runMacInitialInstallWithDiagnostics\(\(\) => run\(process.execPath, \[npmCli, 'install', '--ignore-scripts', '--omit=dev', '--timing'/);
    assert.ok(source.indexOf('runMacInitialInstallWithDiagnostics(()') < source.indexOf("assert.equal(existsSync(sentinel), false)"));
    assert.match(source, /finally \{ rmSync\(root, \{ recursive: true, force: true \}\); \}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native host startup preserves the consumer lock and both executable byte identities', () => {
  const before = { lockSha256: 'a'.repeat(64), runnerSha256: 'b'.repeat(64), codexCommandSha256: 'c'.repeat(64), codexNativeExecutableSha256: 'e'.repeat(64) };
  assert.doesNotThrow(() => assertInstalledNativeConsumerContinuity(before, { ...before }));
  for (const field of Object.keys(before)) {
    assert.throws(() => assertInstalledNativeConsumerContinuity(before, { ...before, [field]: 'd'.repeat(64) }), new RegExp(field));
    assert.throws(() => assertInstalledNativeConsumerContinuity({ ...before, [field]: '' }, { ...before, [field]: '' }), new RegExp(field));
  }
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const arm = source.split('async function verifyLinuxArmConsumer')[1].split("if (process.argv[2] === '--linux-arm64-consumer')")[0];
  assert.match(arm, /const hostEnv = \{ PATH: .*HOME: home, TMPDIR: hostTmp, LC_ALL: 'C', TZ: 'UTC' \}/);
  assert.match(arm, /execFileSync\(process.execPath, \[file\], \{ cwd: consumer, env: hostEnv/);
  assert.ok(arm.indexOf('isolated(GROK_PUBLIC_INSTALL_LIFECYCLE)') < arm.indexOf("hostProbe('host-startup-probe.mjs'"));
  assert.ok(arm.indexOf('const before =') < arm.indexOf("hostProbe('host-startup-probe.mjs'"));
  assert.ok(arm.indexOf("hostProbe('host-startup-probe.mjs'") < arm.indexOf('const after ='));
  assert.match(arm, /assertInstalledNativeConsumerContinuity\(before, after\)/);
  assert.doesNotMatch(arm, /externallySandboxed|externalSandbox|sudo|sysctl|--privileged|seccomp=unconfined|unshare/);
});

test('Mac offline lifecycle uses only the matching executing Node SDK', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-node-headers-test-')));
  try {
    const prefix = join(root, 'sdk'), executable = join(prefix, 'bin/node'), include = join(prefix, 'include/node');
    mkdirSync(join(prefix, 'bin'), { recursive: true }); mkdirSync(include, { recursive: true });
    writeFileSync(executable, 'fixture Node executable');
    writeFileSync(join(include, 'node.h'), '#include "node_version.h"\n');
    const header = '#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 20\n#define NODE_PATCH_VERSION 0\n';
    writeFileSync(join(include, 'node_version.h'), header);
    assert.equal(macNodeHeadersDirectory(executable, '24.20.0'), prefix);
    assert.throws(() => macNodeHeadersDirectory(executable, '24.19.0'), /must match the executing Node/);
    assert.throws(() => macNodeHeadersDirectory(executable, '24.20.0-custom'), /exact release version/);
    writeFileSync(join(include, 'node_version.h'), header + '#define NODE_PATCH_VERSION 0\n');
    assert.throws(() => macNodeHeadersDirectory(executable, '24.20.0'), /declare one patch version/);
    writeFileSync(join(include, 'node_version.h'), header);
    rmSync(join(include, 'node.h'));
    assert.throws(() => macNodeHeadersDirectory(executable, '24.20.0'), /ENOENT/);
    writeFileSync(join(root, 'outside-node.h'), '#include "node_version.h"\n');
    symlinkSync(join(root, 'outside-node.h'), join(include, 'node.h'));
    assert.throws(() => macNodeHeadersDirectory(executable, '24.20.0'), /inside the executing Node prefix/);
    const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('macNodeHeadersDirectory(process.execPath, process.versions.node)'));
    assert.ok(source.includes('consumer, { ...env, npm_config_nodedir: nodeHeaders }'), 'SDK is bound only to the deferred lifecycle environment');
    assert.equal(source.split('npm_config_nodedir:').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle execution has no network, host credentials, checkout, or elevated privileges', () => {
  const args = grokConsumerDockerArgs({ ...paths, command: GROK_PUBLIC_INSTALL_LIFECYCLE });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--user'), ['1001:1001']);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--mount'), [
    'type=bind,src=/private/staging/assets,dst=/packages,readonly',
    'type=bind,src=/private/staging/consumer,dst=/consumer',
    'type=bind,src=/private/staging/cache,dst=/cache',
  ]);
  assert.deepEqual(values(args, '--env'), ['HOME=/tmp', 'npm_config_cache=/cache', 'npm_config_nodedir=/usr/local', 'npm_config_audit=false', 'npm_config_fund=false', 'npm_config_ignore_scripts=false']);
  assert.match(GROK_PUBLIC_INSTALL_IMAGE, /@sha256:[a-f0-9]{64}$/);
});

test('deferred lifecycle execution rebuilds the installed graph without dependency resolution', () => {
  assert.deepEqual(GROK_PUBLIC_INSTALL_LIFECYCLE, ['npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts']);
});

test('a root or malformed host identity cannot run lifecycle scripts', () => {
  for (const uid of [0, -1, undefined, '1001']) {
    assert.throws(() => grokConsumerDockerArgs({ ...paths, uid, command: ['npm', 'ci'] }), /unprivileged/);
  }
});

test('only the scripts-disabled dependency download gets network access', () => {
  const args = grokConsumerDockerArgs({ ...paths, download: true, command: ['npm', 'install', '--ignore-scripts'] });
  assert.deepEqual(values(args, '--network'), ['bridge']);
  assert.ok(values(args, '--env').includes('npm_config_ignore_scripts=true'));
});

test('Pi assembly gets bounded scratch capacity while preserving sandbox restrictions', () => {
  const args = grokConsumerDockerArgs({ ...paths, download: true, temporarySizeMiB: 2048, command: ['node', '/consumer/node_modules/paperclipai/dist/index.js', 'runtime', 'setup', 'pi'] });
  assert.deepEqual(values(args, '--tmpfs'), ['/tmp:rw,nosuid,nodev,noexec,size=2048m,mode=1777']);
  assert.deepEqual(values(args, '--memory'), ['3g']);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  for (const temporarySizeMiB of [0, 255, 2049, Infinity, '2048']) {
    assert.throws(() => grokConsumerDockerArgs({ ...paths, temporarySizeMiB, command: ['node'] }), /bounded/);
  }
});

test('only an offline runtime probe can execute its verified scratch snapshot', () => {
  const command = ['node', '/packages/pi-public-install-probe.mjs', '/consumer/node_modules/@paperclipai/server'];
  const args = grokConsumerDockerArgs({ ...paths, command, temporarySizeMiB: 2048, temporaryExecutable: true });
  assert.deepEqual(values(args, '--tmpfs'), ['/tmp:rw,nosuid,nodev,exec,size=2048m,mode=1777']);
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--user'), ['1001:1001']);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.throws(() => grokConsumerDockerArgs({ ...paths, command, download: true, temporaryExecutable: true }), /offline/);
  assert.throws(() => grokConsumerDockerArgs({ ...paths, command, temporaryExecutable: 'true' }), /offline/);
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("temporarySizeMiB: 2048, temporaryExecutable: true"));
});

test('the separately provisioned executable is exposed read-only to the offline probe', () => {
  const prerequisite = '/private/staging/native/grok';
  const args = grokConsumerDockerArgs({ ...paths, prerequisite, command: ['node', '/packages/probe.mjs', 'present'] });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.equal(values(args, '--mount').at(-1), `type=bind,src=${prerequisite},dst=/opt/paperclip/providers/grok/1.0.13/grok,readonly`);
});

test('verification never elevates PR-controlled provisioning or cleanup on the host', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.ok(source.includes("const prerequisite = join(root, 'native/grok')"));
});

test('the image and Grok downloads start before staging and join without weakening the npm checks', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const linuxSource = source.slice(source.indexOf("assert.equal(process.platform, 'linux'"));
  const position = fragment => { const index = linuxSource.indexOf(fragment); assert.notEqual(index, -1, `verifier must contain ${fragment}`); return index; };
  // Exactly the pinned consumer image is pulled, for the platform the probes run on.
  const imagePull = position("prefetch('image', 'docker', ['pull', '--platform', 'linux/amd64', GROK_PUBLIC_INSTALL_IMAGE])");
  // Grok is provisioned into the prefetch directory, never straight into `native/grok`.
  const grokProvision = position("prefetch('grok', process.execPath, [join(repo, 'packages/paperclip-runner/scripts/provision-grok.mjs'), stagedGrok])");
  assert.ok(source.includes("const stagedGrok = join(prefetched, 'grok')"));
  assert.doesNotMatch(source, /provision-grok\.mjs'\), prerequisite\]/);
  // Both downloads start before any package is staged and before the first sandbox runs.
  const staging = position('publicInstallClosure(repo)');
  const firstSandbox = position("isolated(['node', '/packages/public-install-registry.mjs', '/packages'], { download: true })");
  assert.ok(imagePull < staging && grokProvision < staging);
  assert.ok(position("await awaited('image', imageReady)") < firstSandbox);
  // The binary moves to the canonical host path only after npm is proven not to
  // have provisioned it, after the negative probe, and before the positive probe.
  const npmCheck = position("'npm must not provision Grok'");
  const negativeProbe = position("isolated(['node', '/packages/probe.mjs', 'missing'])");
  const grokJoin = position("await awaited('grok', grokReady)");
  const move = position('renameSync(stagedGrok, prerequisite)');
  const positiveProbe = position("isolated(['node', '/packages/probe.mjs', 'present'], { prerequisite })");
  assert.ok(npmCheck < negativeProbe && negativeProbe < grokJoin && grokJoin < move && move < positiveProbe);
  // The children run through the helper covered by prefetch-child.test.mjs, and
  // cleanup waits for them before removing the directory they write into.
  assert.ok(source.includes("import { startPrefetch, stopPrefetches } from './prefetch-child.mjs'"));
  assert.ok(position('await stopPrefetches(prefetches)') < position('rmSync(root, { recursive: true, force: true })'));
  assert.equal(linuxSource.match(/rmSync\(root/g).length, 1);
});

test('the bundled-dependency installs run together while the other packages are copied, and pack in order', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const position = fragment => { const index = source.indexOf(fragment); assert.notEqual(index, -1, `verifier must contain ${fragment}`); return index; };
  // The installs are children of the script's own CLI entry through the helper
  // covered by stage-bundled-packages.test.mjs, never in-process calls.
  assert.doesNotMatch(source, /prepareBundledPackage/);
  assert.ok(source.includes("import { bundledInstallTimings, startBundledInstalls } from './stage-bundled-packages.mjs'"));
  // Only the bundled packages' sources are staged before the installs start;
  // the installs are registered for cleanup at once, before anything else can
  // fail; the other packages are copied while the installs run; the join comes
  // before the packs start; and the packs run through the helper covered by
  // pack-staged-packages.test.mjs, bundled packages first, each registered for
  // cleanup as it starts, with the results put back into dependency order
  // before every tarball is checked.
  const bundledSources = position('for (const entry of entries.filter(entry => entry.bundled)) stageSource(entry)');
  const start = position("startBundledInstalls(entries.filter(entry => entry.bundled), { logDir: prefetched, cwd: repo, env })");
  const registered = position('prefetches.push(...installs.map(({ handle }) => handle))');
  const otherSources = position('for (const entry of entries.filter(entry => !entry.bundled))');
  const join = position("await awaited('bundled', Promise.all(installs.map(({ handle }) => handle.done)))");
  assert.ok(source.includes("import { packConcurrency, packStagedPackages, packTimings } from './pack-staged-packages.mjs'"));
  const packs = position("await packStagedPackages([...entries].sort((a, b) => Number(b.bundled) - Number(a.bundled)), { logDir: prefetched, env, concurrency, register: handle => prefetches.push(handle) })");
  const reordered = position('packs.sort((a, b) => a.index - b.index)');
  const checks = position("for (const tarball of tarballs) assertNoBundledCodexPayloads(run('tar', ['-tzf', tarball])");
  const copied = position('for (const tarball of tarballs) {');
  assert.ok(bundledSources < start && start < registered && registered < otherSources && otherSources < join && join < packs && packs < reordered && reordered < checks && checks < copied);
  const packagingLane = source.slice(position("} else {\nassert.equal(process.platform, 'linux'"));
  assert.equal(packagingLane.match(/run\('npm', \['pack'/g).length, 1, 'only the lifecycle sentinel is packed in-process in the packaging lane');
  assert.ok(source.includes("destination: join(root, `pack-${index}`)"), 'each pack writes into its own directory');
  // The timing line reports the split staging phase, each install, and the
  // pack step with what the packs would have cost one after another.
  for (const key of ['stage_ui_dist_ms', 'stage_sources_ms', 'stage_bundled_ms', 'stage_pack_ms', 'stage_pack_check_ms']) assert.ok(source.includes(`timing.${key} =`));
  assert.ok(source.includes('...bundledInstallTimings(installs)'));
  assert.ok(source.includes('Object.assign(timing, packTimings(packs, concurrency))'));
});

test('the verifier stages only workspace packages, so it skips the standalone build release.sh needs', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const position = fragment => { const index = source.indexOf(fragment); assert.notEqual(index, -1, `verifier must contain ${fragment}`); return index; };
  // The standalone public packages are the ones outside the pnpm workspace
  // (the sandbox-provider plugins). release.sh builds them because it publishes
  // them; the verifier packs only the closure of the server and the CLI under
  // `workspace:` specs, and a `workspace:` spec can only name a workspace
  // package, so no tarball here ever contains or depends on a standalone build.
  // The one reader of that build is qualification-package retention, which
  // packs the Daytona plugin from its `dist`, so the build runs exactly when
  // retention is requested: the single reference sits inside that gate, and
  // the same flag is what later decides whether retention runs at all.
  const standaloneBuild = "run(process.execPath, [join(repo, 'scripts/build-standalone-public-packages.mjs')], repo)";
  assert.equal(source.split('build-standalone-public-packages').length - 1, 1, 'the standalone build is referenced once, inside the retention gate');
  const gate = position("const retainQualificationPackages = Boolean(process.env.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR);\n  if (retainQualificationPackages) {\n    const standaloneStarted = performance.now();\n    " + standaloneBuild);
  assert.ok(source.includes('timing.stage_standalone_build_ms ='), 'the gated build is timed under its own key');
  assert.ok(source.includes('if (retainQualificationPackages) {\n    const retained = retainRunnerQualificationPackages({'), 'retention is gated by the same flag as the build');
  assert.doesNotMatch(source, /if \(process\.env\.PAPERCLIP_RUNNER_QUALIFICATION_PACKAGES_DIR\)/, 'no second reading of the retention flag can diverge from the build gate');
  const retention = readFileSync(new URL('../retain-runner-qualification-packages.mjs', import.meta.url), 'utf8');
  assert.ok(retention.includes("const pluginRelative = 'packages/plugins/sandbox-providers/daytona';") && retention.includes("cpSync(join(repo, pluginRelative, 'dist'), join(plugin, 'dist'), { recursive: true })"), 'retention still packs the Daytona plugin from its dist, which is why the gated build exists');
  const repo = new URL('../../', import.meta.url);
  assert.ok(source.includes('const { packages, needed } = publicInstallClosure(repo);'));
  const { packages, needed } = publicInstallClosure(fileURLToPath(repo));
  const workspace = parseWorkspaceEntries(readFileSync(new URL('pnpm-workspace.yaml', repo), 'utf8'));
  const standalone = [...packages.values()].filter(({ dir }) => !isWorkspacePackage(dir, workspace)).map(({ dir }) => dir);
  assert.ok(standalone.length > 0, 'the public package map must still carry standalone packages for this check to mean anything');
  assert.ok(standalone.includes('packages/plugins/sandbox-providers/daytona'), 'the Daytona plugin retention packs is a standalone package, so pnpm build alone cannot produce its dist');
  for (const name of needed) assert.ok(isWorkspacePackage(packages.get(name).dir, workspace), `${name} is staged by the verifier but is not a workspace package`);
  // The server publishes `ui-dist`, so that copy stays, before any package is
  // staged, reusing the UI that `pnpm build` produced, and it is timed. The
  // gated standalone build keeps release.sh's order: after the closure is
  // known and before the UI copy and any staged source.
  assert.deepEqual(JSON.parse(readFileSync(new URL('server/package.json', repo), 'utf8')).files, ['dist', 'ui-dist', 'skills']);
  assert.ok(source.includes("PAPERCLIP_RELEASE_REUSE_UI_DIST: '1'"));
  const uiDist = position("run('bash', [join(repo, 'scripts/prepare-server-ui-dist.sh')], repo)");
  assert.ok(position('publicInstallClosure(repo)') < gate && gate < uiDist && uiDist < position('timing.stage_ui_dist_ms =') && uiDist < position('const stageSource = '));
});

test('the installed Codex probe exercises the public export and rejects incomplete or mismatched packages', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'installed-codex-probe-')));
  try {
    const consumer = join(root, 'consumer'); mkdirSync(consumer);
    const target = `${process.platform}-${process.arch}`;
    const platformPath = `node_modules/@openai/codex-${target}`;
    const platform = join(consumer, platformPath); mkdirSync(platform, { recursive: true });
    const nativeVendor = join(platform, 'vendor'); mkdirSync(nativeVendor);
    const triple = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
      'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[target];
    const nativeBytes = Buffer.alloc(64);
    if (process.platform === 'darwin') { nativeBytes.writeUInt32LE(0xfeedfacf); nativeBytes.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
    else if (process.platform === 'win32') { nativeBytes.set([0x4d, 0x5a]); nativeBytes.writeUInt32LE(40, 60); nativeBytes.writeUInt32LE(0x00004550, 40); nativeBytes.writeUInt16LE(process.arch === 'arm64' ? 0xaa64 : 0x8664, 44); }
    else { nativeBytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); nativeBytes.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18); }
    const nativeFile = join(nativeVendor, triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mkdirSync(join(nativeVendor, triple, 'bin'), { recursive: true }); writeFileSync(nativeFile, nativeBytes, { mode: 0o755 });
    const manifest = { name: '@openai/codex', version: `0.160.0-${target}`, os: [process.platform], cpu: [process.arch] };
    writeFileSync(join(platform, 'package.json'), JSON.stringify(manifest));
    const entry = { name: manifest.name, version: manifest.version,
      resolved: `https://registry.npmjs.org/@openai/codex/-/codex-${manifest.version}.tgz`, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` };
    const lock = { lockfileVersion: 3, packages: { [platformPath]: entry } };
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    const server = join(consumer, 'node_modules/@paperclipai/server');
    const vendor = join(server, 'dist/vendor/paperclip-runner'), drivers = join(vendor, 'drivers/acpx'); mkdirSync(drivers, { recursive: true });
    mkdirSync(join(vendor, 'live'));
    writeFileSync(join(vendor, 'live/runner-binary.js'), `export const runnerBinaryTarget = ${runnerBinaryTarget.toString()};`);
    writeFileSync(join(server, 'package.json'), JSON.stringify({ name: '@paperclipai/server', type: 'module' }));
    const integrity = join(drivers, 'installation-integrity.js');
    const security = join(vendor, 'drivers/codex/codex-security-config.js'); mkdirSync(join(vendor, 'drivers/codex'));
    const securitySource = `export const codexExecutableReadOnlyRoots = () => [${JSON.stringify(nativeVendor)}];
      export const createIsolatedCodexAppServerArgs = (source, roots) => roots.map(root => JSON.stringify(root) + '=\"read\"');`;
    writeFileSync(security, securitySource);
    const moduleSource = `import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';
      export function createAcpxPackageJsonResolver(root, manifest) { assert.equal(root, ${JSON.stringify(server)}); assert.equal(manifest, root + '/package.json'); return () => 'selected-authority'; }
      export async function verifyQualifiedAcpxInstallation(profile, resolver) { assert.deepEqual(profile, { agent: 'codex', model: 'gpt-5.4' }); assert.equal(resolver(), 'selected-authority');
        return { openCommand: async () => ({ close: async () => { writeFileSync(${JSON.stringify(join(server, 'lease-closed'))}, 'ok'); } }) }; }`;
    writeFileSync(integrity, moduleSource);
    writeFileSync(join(drivers, 'qualified-profiles.js'), "export const resolveQualifiedAcpxProfile = (agent, model) => ({ agent, model });");
    const wrapper = join(consumer, 'node_modules/@openai/codex/bin'); mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, '../package.json'), JSON.stringify({ name: '@openai/codex', version: '0.160.0' }));
    const index = join(vendor, 'index.mjs'), command = join(wrapper, 'codex.js'), probe = join(root, 'probe.mjs');
    const executable = version => writeFileSync(command, `#!/bin/sh\n[ "$1" = --version ] || exit 65\nprintf '%s\\n' 'codex-cli ${version}'\n`, { mode: 0o755 });
    writeFileSync(probe, installedCodexProbeSource(index, consumer, '0.160.0'));
    const run = () => spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', NODE_PATH: '' } });
    writeFileSync(index, `export const resolvePinnedCodexCommand = () => ${JSON.stringify(command)};`);
    executable('0.160.0');
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).pinnedCodexCommandVerified, true);
    assert.equal(JSON.parse(result.stdout).codexPlatformPackageSource, 'official npm');
    assert.equal(JSON.parse(result.stdout).codexConsumerPlatform, target);
    assert.equal(JSON.parse(result.stdout).codexCommandSha256, createHash('sha256').update(readFileSync(command)).digest('hex'));
    assert.equal(JSON.parse(result.stdout).codexNativeExecutableSha256, createHash('sha256').update(nativeBytes).digest('hex'));
    const original = JSON.parse(result.stdout);
    nativeBytes[63] = 1; writeFileSync(nativeFile, nativeBytes);
    result = run(); assert.equal(result.status, 0, result.stderr);
    const changed = JSON.parse(result.stdout);
    assert.equal(changed.codexCommandSha256, original.codexCommandSha256, 'native mutation does not change the npm launcher');
    assert.notEqual(changed.codexNativeExecutableSha256, original.codexNativeExecutableSha256);
    assert.throws(() => assertInstalledNativeConsumerContinuity({ lockSha256: 'a'.repeat(64), runnerSha256: 'b'.repeat(64), ...original },
      { lockSha256: 'a'.repeat(64), runnerSha256: 'b'.repeat(64), ...changed }), /codexNativeExecutableSha256/);
    nativeBytes[63] = 0; writeFileSync(nativeFile, nativeBytes);
    rmSync(nativeFile);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /one native executable/);
    const foreignNative = join(root, 'foreign-codex'); writeFileSync(foreignNative, nativeBytes, { mode: 0o755 });
    symlinkSync(foreignNative, nativeFile);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /bounded regular file in its selected platform package/);
    rmSync(nativeFile); writeFileSync(nativeFile, nativeBytes, { mode: 0o755 });
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).codexQualifiedInstallationVerified, true);
    assert.equal(JSON.parse(result.stdout).codexCommandLeaseVerified, true);
    assert.equal(JSON.parse(result.stdout).codexNativeSandboxResourcesVerified, true);
    assert.equal(readFileSync(join(server, 'lease-closed'), 'utf8'), 'ok');
    assert.equal(JSON.parse(result.stdout).providerCalls, 0);
    const legacyPath = 'node_modules/legacy-codex-adapter/node_modules/@openai/codex-' + target;
    const legacy = join(consumer, legacyPath); mkdirSync(legacy, { recursive: true });
    const legacyManifest = { ...manifest, version: '0.156.1-' + target };
    writeFileSync(join(legacy, 'package.json'), JSON.stringify(legacyManifest));
    lock.packages[legacyPath] = { ...entry, version: legacyManifest.version,
      resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-' + legacyManifest.version + '.tgz' };
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).codexPlatformPackages.length, 2);
    assert.equal(JSON.parse(result.stdout).codexSelectedPlatformPath, platformPath);
    assert.equal(JSON.parse(result.stdout).codexSelectedPlatformVersion, '0.160.0-' + target);
    const legacyCommand = join(legacy, 'codex');
    writeFileSync(legacyCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(index, `export const resolvePinnedCodexCommand = () => ${JSON.stringify(legacyCommand)};`);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Selected Codex platform version must match the qualified pin/);
    mkdirSync(join(legacy, 'vendor'));
    const legacyNative = join(legacy, 'vendor', triple, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mkdirSync(join(legacy, 'vendor', triple, 'codex'), { recursive: true }); writeFileSync(legacyNative, nativeBytes, { mode: 0o755 });
    writeFileSync(legacyCommand, '#!/bin/sh\nprintf "codex-cli 0.156.1\\n"\n', { mode: 0o755 });
    writeFileSync(security, securitySource.replaceAll(JSON.stringify(nativeVendor), JSON.stringify(join(legacy, 'vendor'))));
    writeFileSync(probe, installedCodexProbeSource(index, consumer, undefined, { nativeCodex: true }));
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).installedCodexVersion, 'codex-cli 0.156.1');
    assert.equal(JSON.parse(result.stdout).codexQualifiedInstallationVerified, undefined);
    writeFileSync(probe, installedCodexProbeSource(index, consumer, '0.160.0'));
    writeFileSync(security, securitySource);

    writeFileSync(index, `import { writeFileSync } from 'node:fs'; export const resolvePinnedCodexCommand = () => {
      writeFileSync(${JSON.stringify(join(platform, 'package.json'))}, ${JSON.stringify(JSON.stringify({ ...manifest, altered: true }))});
      return ${JSON.stringify(command)}; };`);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /metadata must match its scanned provenance/);
    writeFileSync(join(platform, 'package.json'), JSON.stringify(manifest));
    writeFileSync(index, "export const resolvePinnedCodexCommand = () => { throw new Error('Bundled Codex runtime version mismatch'); };");
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Bundled Codex runtime version mismatch/);
    writeFileSync(index, `export const resolvePinnedCodexCommand = () => ${JSON.stringify(command)};`);
    writeFileSync(security, securitySource.replace(JSON.stringify(nativeVendor), '"/missing-vendor-root"'));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /vendor directory must be readable/);
    writeFileSync(security, securitySource.replace(JSON.stringify(nativeVendor), `${JSON.stringify(nativeVendor)}, ${JSON.stringify(consumer)}`));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /must not grant enclosing npm/);
    writeFileSync(security, securitySource.replace("'=\"read\"'", "'=\"write\"'"));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /retain the selected native executable resources/);
    writeFileSync(security, securitySource);
    const emptySlot = join(server, 'node_modules/@openai/codex-' + target);
    mkdirSync(emptySlot, { recursive: true });
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).codexPlatformPackages.length, 2,
      'An empty nested npm optional slot must not obscure the qualified hoisted host package');
    writeFileSync(join(emptySlot, 'undeclared-native-payload'), 'native fixture; never executed');
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /empty regular directory; found.*undeclared-native-payload/);
    rmSync(join(emptySlot, 'undeclared-native-payload'));
    writeFileSync(join(emptySlot, 'package.json'), '{ malformed');
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SyntaxError/);
    rmSync(join(emptySlot, 'package.json'));
    writeFileSync(integrity, moduleSource.replace('assert.deepEqual(profile,', "throw new Error('qualified executable digest mismatch'); assert.deepEqual(profile,"));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /qualified executable digest mismatch/);
    writeFileSync(integrity, moduleSource.replace("writeFileSync(", "throw new Error('command lease close failed'); writeFileSync("));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /command lease close failed/);
    writeFileSync(integrity, moduleSource);
    lock.packages[platformPath].inBundle = true;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /downloaded, not bundled/);
    delete lock.packages[platformPath].inBundle;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    const foreign = join(consumer, 'node_modules/@openai/codex-win32-arm64'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.160.0-win32-arm64' }));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /only the host/);
    rmSync(foreign, { recursive: true });
    executable('9.9.9'); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /qualified pin/);
    rmSync(command); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /ENOENT/);
    const outside = join(root, 'outside'); writeFileSync(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(index, `export const resolvePinnedCodexCommand = () => ${JSON.stringify(outside)};`);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /inside the installed consumer/);
    writeFileSync(index, 'export const unrelated = true;'); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /must export the pinned Codex resolver/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual tar member checks allow Codex JavaScript but reject nested platform packages and native vendor payloads', () => {
  const javascript = ['package/package.json', 'package/node_modules/@openai/codex/package.json',
    'package/node_modules/@openai/codex/bin/codex.js', 'package/dist/vendor/paperclip-runner/index.js'];
  assert.doesNotThrow(() => assertNoBundledCodexPayloads(javascript));
  for (const payload of [
    'package/node_modules/@openai/codex-linux-x64/package.json',
    'package/node_modules/@openai/codex-linux-arm64/package.json',
    'package/node_modules/bridge/node_modules/@openai/codex-darwin-arm64/package.json',
    'package/node_modules/@openai/codex-win32-x64/package.json',
    'package/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex',
    'package/dist/vendor/aarch64-apple-darwin/bin/codex',
    'package/dist/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ]) assert.throws(() => assertNoBundledCodexPayloads([...javascript, payload]), /must not bundle/);
  assert.throws(() => assertNoBundledCodexPayloads(['package/../outside']), /inside the package/);
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertNoBundledCodexPayloads\(run\('tar', \['-tzf', tarball\]\)/);
});

test('consumer provenance rejects bundled, foreign, inconsistent and non-official Codex payloads', () => {
  for (const target of ['linux-x64', 'linux-arm64']) {
  const path = `node_modules/@openai/codex-${target}`;
  const manifest = { name: '@openai/codex', version: `0.160.0-${target}`, os: ['linux'], cpu: [target.slice('linux-'.length)] };
  const entry = { version: manifest.version, resolved: `https://registry.npmjs.org/@openai/codex/-/codex-${manifest.version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` };
  const check = (value = entry, installed = [{ path, manifest }]) => assertInstalledCodexPlatformProvenance({ packages: { [path]: value } }, installed, target);
  assert.equal(check().codexConsumerHostOnly, true);
  const legacyManifest = { ...manifest, version: `0.156.1-${target}` };
  assert.equal(check({ ...entry, version: legacyManifest.version,
    resolved: `https://registry.npmjs.org/@openai/codex/-/codex-0.156.1-${target}.tgz` }, [{ path, manifest: legacyManifest }]).codexConsumerHostOnly, true);
  assert.throws(() => check(entry, [{ path, manifest: { ...manifest, version: `^0.160.0-${target}` } }]), /exact host version/);
  for (const change of [
    { inBundle: true }, { link: true }, { version: `0.156.1-${target}` },
    { resolved: `https://example.com/@openai/codex/-/codex-0.160.0-${target}.tgz` },
    { resolved: `https://registry.npmjs.org/@openai/codex/-/codex-0.156.1-${target}.tgz` },
    { resolved: `https://user@registry.npmjs.org/@openai/codex/-/codex-0.160.0-${target}.tgz` },
    { integrity: undefined }, { integrity: 'sha512-AA==' },
  ]) assert.throws(() => check({ ...entry, ...change }));
  assert.throws(() => check(entry, []), /must install its host/);
  assert.throws(() => check(entry, [{ path: 'node_modules/@openai/codex-darwin-arm64', manifest }]), /only the host/);
  assert.throws(() => check(entry, [{ path, manifest: { ...manifest, name: 'untrusted' } }]), /identity/);
  }
});


test('hosted Mac lifecycle denies OS networking and writes outside owned scratch', () => {
  const profile = macPublicInstallLifecycleProfile('/Users/runner/work/_temp/owned-check');
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*/);
  assert.match(profile, /subpath "\/Users\/runner\/work\/_temp\/owned-check"/);
  assert.throws(() => macPublicInstallLifecycleProfile('relative'), /absolute/);
  assert.throws(() => macPublicInstallLifecycleProfile('/tmp/owned\0bad'), /absolute/);
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.match(source, /process.env.GITHUB_ACTIONS, 'true'/);
  assert.match(source, /networkProbe, 'allowed'/);
  assert.match(source, /networkProbe, 'denied'/);
  assert.match(source, /error.code,'EPERM'/);
  assert.match(source, /'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts'/);
  assert.match(source, /readFileSync\(sentinel, 'utf8'\), 'ok'/);
  assert.match(source, /readFileSync\(join\(consumer, 'package-lock.json'\), 'utf8'\), lock/);
  assert.match(source, /finally \{ rmSync\(root, \{ recursive: true, force: true \}\); \}/);
});

test('installed daemon proof uses the production host resolver and complete source-bound manifest', () => {
  const source = installedDaemonProbeSource('/consumer/server/dist/vendor/paperclip-runner', '/consumer', 'a'.repeat(40));
  assert.match(source, /defaultCapabilityRunnerdBinary\(\)/);
  assert.match(source, /Object.keys\(manifest.platforms\).sort\(\), targets.sort\(\)/);
  assert.match(source, /manifest.sourceRevision, "a{40}"/);
  assert.match(source, /runnerBinaryTarget\(bytes\), target/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /metadata.binaryContractVersion, expected.contracts.runnerdArtifact/);
  assert.match(source, /'linux-arm64'/);
  assert.doesNotMatch(source, /PAPERCLIP_RUNNERD_BINARY|runner\/target\/debug|execFileSync\('paperclip-runnerd'/);
});

test('native ARM clean consumers keep the existing container and installed-runtime boundaries', () => {
  const args = grokConsumerDockerArgs({ ...paths, platform: 'linux/arm64', command: GROK_PUBLIC_INSTALL_LIFECYCLE });
  assert.deepEqual(values(args, '--platform'), ['linux/arm64']);
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--user'), ['1001:1001']);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.ok(values(args, '--mount').some(value => value.endsWith('dst=/packages,readonly')));
  assert.throws(() => grokConsumerDockerArgs({ ...paths, platform: 'linux/arm/v7', command: [] }), /supported native Linux platform/);
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const arm = source.split('async function verifyLinuxArmConsumer(')[1].split("if (process.argv[2] === '--linux-arm64-consumer')")[0];
  assert.match(arm, /process.platform \+ '-' \+ process.arch, 'linux-arm64'/);
  assert.match(arm, /const platform = 'linux\/arm64'/);
  assert.match(arm, /isolated\(GROK_PUBLIC_INSTALL_LIFECYCLE\)/);
  assert.match(arm, /installedCodexProbeSource\(installed \+ '\/index.js', '\/consumer', undefined, \{ nativeCodex: true \}\)/);
  assert.match(arm, /tests\/runner-e2e\/installed-cli.ts/);
  assert.match(arm, /process.versions.node.split\('\.'\)\[0\], '24'/);
  assert.match(arm, /macInstalledStartupProbeSource\(consumer, hostServer, daemon.sha256, join\(assets, 'installed-cli.ts'\)\)/);
  assert.match(arm, /startupEnvironment: 'native host, same installed graph, isolated empty homes'/);
  assert.doesNotMatch(arm, /stage-runner|runner\/target|PAPERCLIP_RUNNER_BINARY|prerequisite:/);
});


test('Mac startup wiring normalizes only validated manifest digests and uses server-scoped tooling', () => {
  const source = macInstalledStartupProbeSource('/owned/consumer', '/owned/consumer/server', 'sha256:' + 'a'.repeat(64), '/source/tests/runner-e2e/installed-cli.ts');
  assert.match(source, /expectedRunnerSha256:"a{64}"/);
  assert.doesNotMatch(source, /expectedRunnerSha256:"sha256:/);
  for (const digest of ['a'.repeat(64), 'sha256:bad', 'sha512:' + 'a'.repeat(64), 'sha256:' + 'A'.repeat(64)]) {
    assert.throws(() => macInstalledStartupProbeSource('/owned/consumer', '/owned/consumer/server', digest, '/source/helper.ts'), /verified SHA-256/);
  }
  const verifier = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /\['--import', 'tsx', startupFile\], join\(repo, 'server'\)/);
  const closedEnvironment = verifier.match(/const env = \{ PATH: `\$\{tools\}[\s\S]*?\};/)[0];
  assert.doesNotMatch(closedEnvironment, /NODE_PATH|NODE_OPTIONS|\.\.\.process.env/);
});

test('Pi admission verifies assembled host daemon identity and preserves the flat source-package control', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-installed-daemon-'))), server = join(root, 'server');
  const output = join(server, 'dist/vendor/paperclip-runner'), target = 'linux-x64', source = 'a'.repeat(40);
  const binary = join(output, 'bin', target, 'paperclip-runnerd'), manifestPath = join(output, 'bin/release-manifest.json');
  const bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(62, 18);
  const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const manifest = { schema: 'paperclip.runner.release-binaries.v1', sourceRevision: source,
    platforms: { [target]: { path: `${target}/paperclip-runnerd`, sha256: sha256(bytes) } } };
  const check = () => verifyPiPackagedDaemon(server, binary, target, runnerBinaryTarget);
  try {
    mkdirSync(join(output, 'bin', target), { recursive: true });
    writeFileSync(binary, bytes); writeFileSync(join(server, 'dist/build-info.json'), JSON.stringify({ commit: source }));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await check();
    for (const changed of [null, { ...manifest, schema: 'untrusted' }, { ...manifest, sourceRevision: 'b'.repeat(40) },
      { ...manifest, platforms: { [target]: { ...manifest.platforms[target], path: '../outside' } } },
      { ...manifest, platforms: { [target]: { ...manifest.platforms[target], sha256: 'sha256:' + '0'.repeat(64) } } }]) {
      writeFileSync(manifestPath, JSON.stringify(changed)); await assert.rejects(check());
    }
    const wrongHeader = Buffer.from(bytes); wrongHeader.writeUInt16LE(183, 18);
    writeFileSync(binary, wrongHeader);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, platforms: { [target]: { ...manifest.platforms[target], sha256: sha256(wrongHeader) } } }));
    await assert.rejects(check(), /linux-arm64/);
    writeFileSync(binary, bytes); writeFileSync(manifestPath, JSON.stringify(manifest));
    const outside = join(root, 'outside'); writeFileSync(outside, bytes);
    rmSync(binary); symlinkSync(outside, binary); await assert.rejects(check());
    rmSync(binary); writeFileSync(binary, bytes); rmSync(manifestPath);
    const flat = join(output, 'bin/paperclip-runnerd'); writeFileSync(flat, bytes);
    await verifyPiPackagedDaemon(server, flat, target, runnerBinaryTarget);
    await assert.rejects(check(), /strictly equal/);
    writeFileSync(manifestPath, 'null');
    await assert.rejects(verifyPiPackagedDaemon(server, flat, target, runnerBinaryTarget), /manifest must be an object/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('Pi setup overlaps independent probes only after the offline lifecycle and joins before admission', () => {
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const position = fragment => { const index = source.indexOf(fragment); assert.notEqual(index, -1, fragment); return index; };
  const lifecycle = position("phase('lifecycle_rebuild')");
  const start = position("prefetch('pi_setup', 'docker', piSetupArgs)");
  const codex = position("const codex = JSON.parse(isolated(['node', '/packages/codex-probe.mjs'])");
  const grok = position("phase('grok_probes')");
  const join = position("await awaited('pi_setup', piSetupReady)");
  const receipt = position("assert.equal(receipt.status, 'installed_verified')");
  const probe = position("console.log(isolated(['node', '/packages/pi-public-install-probe.mjs'");
  assert.ok(lifecycle < start && start < codex && codex < grok && grok < join && join < receipt && receipt < probe);
  assert.ok(source.includes("piSetupArgs.splice(1, 0, '--name', piSetupContainer)"));
  assert.ok(position("await stopPrefetches(prefetches)") < position("['rm', '--force', piSetupContainer]"));
});
