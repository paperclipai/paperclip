import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { GROK_PUBLIC_INSTALL_IMAGE, GROK_PUBLIC_INSTALL_LIFECYCLE, MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS, assertMacDeveloperRoot, discoverMacPublicInstallToolchain, grokConsumerDockerArgs, macPublicInstallLifecyclePolicy, prepareMacPublicInstallNodeHeaders, publicPackProducerLock, runMacPublicInstallPhase, verifyPublicPackProducerLock } from '../grok-public-install-sandbox.mjs';
import { assertStandardImageIdentity, inspectInstalledDaemon, inspectInstalledProviderReadiness, inspectInstalledUi, inspectManagedServiceInstall, installedProbeMode, installedProbePaths, standardImageDockerArgs, standardImageRequest } from '../../tests/release-smoke/installed-cli-probe.mjs';

const paths = { assets: '/private/staging/assets', consumer: '/private/staging/consumer', cache: '/private/staging/cache', uid: 1001, gid: 1001 };
const values = (args, flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('public pack provenance verifies the actual resolved producer lock separately from committed and consumer locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperclip-producer-lock-test-'));
  const sourceRevision = 'a'.repeat(40);
  // PR manifests can add dependencies before the CI-owned source lock refresh.
  // The committed range and the selected build version are separate evidence.
  const sourceLock = Buffer.from("lockfileVersion: '9.0'\nimporters:\n  server:\n    dependencies: {}\n");
  const buildLock = Buffer.from("lockfileVersion: '9.0'\nimporters:\n  server:\n    dependencies:\n      compression:\n        specifier: ^1.8.2\n        version: 1.8.2\n");
  try {
    const producerLock = publicPackProducerLock({ sourceRevision, sourceLock, buildLock });
    assert.equal(producerLock.sourceLock.sha256, hash(sourceLock).slice(7));
    assert.equal(producerLock.buildLock.sha256, hash(buildLock).slice(7));
    assert.notEqual(producerLock.sourceLock.sha256, producerLock.buildLock.sha256);
    await writeFile(join(directory, producerLock.sourceLock.name), sourceLock);
    await writeFile(join(directory, producerLock.buildLock.name), buildLock);
    const receipt = { schema: 'paperclip.public-npm-pack.v1', sourceRevision, producerLock, consumerLockSha256: 'c'.repeat(64) };
    const options = { receipt, directory, sourceRevision, sourceLock, required: true };
    assert.equal(verifyPublicPackProducerLock(options), producerLock);
    assert.notEqual(producerLock.buildLock.sha256, receipt.consumerLockSha256);
    await writeFile(join(directory, producerLock.buildLock.name), Buffer.concat([buildLock, Buffer.from('# changed resolved graph\n')]));
    assert.throws(() => verifyPublicPackProducerLock(options), /Transferred producer lock checksum mismatch/);
    await writeFile(join(directory, producerLock.buildLock.name), buildLock);
    assert.throws(() => verifyPublicPackProducerLock({ ...options, receipt: { ...receipt,
      producerLock: { ...producerLock, buildLock: { ...producerLock.buildLock, sha256: receipt.consumerLockSha256 } } } }), /checksum mismatch/);
    assert.throws(() => verifyPublicPackProducerLock({ ...options, sourceRevision: 'b'.repeat(40) }), /source must match/);
    assert.throws(() => verifyPublicPackProducerLock({ ...options, receipt: { ...receipt,
      producerLock: { ...producerLock, sourceRevision: 'b'.repeat(40) } } }), /source must match/);
    // Self-consistent substituted source bytes still cannot qualify this commit.
    const substitutedSource = Buffer.from('lockfileVersion: substituted\n');
    await writeFile(join(directory, producerLock.sourceLock.name), substitutedSource);
    assert.throws(() => verifyPublicPackProducerLock({ ...options, receipt: { ...receipt,
      producerLock: { ...producerLock, sourceLock: { ...producerLock.sourceLock, sha256: hash(substitutedSource).slice(7) } } } }), /committed source revision/);
    await writeFile(join(directory, producerLock.sourceLock.name), sourceLock);
    await rm(join(directory, producerLock.buildLock.name));
    assert.throws(() => verifyPublicPackProducerLock(options), { code: 'ENOENT' });
    await symlink(join(directory, producerLock.sourceLock.name), join(directory, producerLock.buildLock.name));
    assert.throws(() => verifyPublicPackProducerLock(options), /retained regular file/);
    assert.throws(() => verifyPublicPackProducerLock({ ...options, receipt: { ...receipt,
      producerLock: { ...producerLock, buildLock: { ...producerLock.buildLock, name: '../pnpm-lock.yaml' } } } }), /retained lock filename/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('older public pack receipts remain readable without making a new qualification provenance claim', () => {
  const sourceRevision = 'a'.repeat(40), sourceLock = Buffer.from('source lock');
  const options = { receipt: { schema: 'paperclip.public-npm-pack.v1', sourceRevision }, directory: '/unused', sourceRevision, sourceLock };
  assert.equal(verifyPublicPackProducerLock(options), undefined);
  assert.throws(() => verifyPublicPackProducerLock({ ...options, required: true }), /requires retained producer lock provenance/);
  assert.throws(() => publicPackProducerLock({ sourceRevision: 'master', sourceLock, buildLock: sourceLock }), /exact source revision/);
  assert.throws(() => publicPackProducerLock({ sourceRevision, sourceLock, buildLock: Buffer.alloc(0) }), /retained lock bytes/);
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('const producerLock = verifyPublicPackProducerLock(') < source.indexOf("stage: 'scripts-disabled-install'"),
    'Transferred producer locks must be checked before any consumer installation');
  assert.match(source, /producerLockVerified: producerLock !== undefined/);
  assert.match(source, /Package production must preserve the resolved producer lock/);
  assert.match(source, /Qualification must preserve the resolved producer lock/);
});

async function daemonFixture(root, server) {
  // These contract fixtures exercise the installed probe's independent checks.
  // Hosted package qualification loads the real production modules and native
  // executable; these shell fixtures are never used as platform evidence.
  const installed = join(server, 'dist/vendor/paperclip-runner'), target = `${process.platform}-${process.arch}`;
  const executable = join(installed, `bin/${target}/paperclip-runnerd`), sourceRevision = 'a'.repeat(40);
  const metadata = { schema: 'paperclip-runner/runnerd-build-metadata/v1', binaryName: 'paperclip-runnerd',
    packageName: '@paperclipai/paperclip-runner', packageVersion: '0.0.0', binaryContractVersion: 2,
    nativeExecutionVersion: 1, harnessDriverVersion: 1, prp: { name: 'paperclip.runner', minimumVersion: 1, maximumVersion: 2 },
    durableSessionCapabilities: ['unlimited_runtime', 'connection_lease_renewal'], prpTransportModes: ['dial_ws_loopback', 'dial_wss', 'listen_ws'] };
  await mkdir(join(installed, `bin/${target}`), { recursive: true }); await mkdir(join(installed, 'live'));
  await mkdir(join(installed, 'evals'));
  await writeFile(join(installed, 'live/runner-binary.js'), `import fs from 'node:fs';import path from 'node:path';
    export function resolvePackagedRunnerBinary(root) {
      const exact=path.join(root, 'bin/${target}/paperclip-runnerd'), generic=path.join(root, 'bin/paperclip-runnerd');
      if(fs.existsSync(${JSON.stringify(join(root, 'outside-resolver'))}))return ${JSON.stringify(join(root, 'outside'))};
      return fs.existsSync(exact)?exact:fs.existsSync(generic)?generic:null;
    }
    export function runnerBinaryTarget() {return fs.existsSync(${JSON.stringify(join(root, 'wrong-architecture'))})?'wrong-platform':'${target}';}`);
  await writeFile(join(installed, 'evals/build-metadata.js'), `export const PAPERCLIP_RUNNERD_BUILD_METADATA_SCHEMA='paperclip-runner/runnerd-build-metadata/v1';
    export const PAPERCLIP_RUNNER_BUILD_METADATA={package:{name:'@paperclipai/paperclip-runner'},
      contracts:{runnerdArtifact:2,nativeExecution:1,harnessDriver:1},prp:{name:'paperclip.runner',minimumVersion:1,maximumVersion:2}};`);
  // Reuse the existing actual metadata parser, rather than a replacement grader.
  const { stripTypeScriptTypes } = await import('node:module');
  const parser = readFileSync(new URL('../../packages/paperclip-runner/src/evals/runnerd-artifact.ts', import.meta.url), 'utf8');
  // Node's strip-only loader rejects constructor parameter properties. The
  // fixture needs the parser and error messages, not its stored issue field.
  await writeFile(join(installed, 'evals/runnerd-artifact.js'), stripTypeScriptTypes(parser.replace('readonly issue:', 'issue:')));
  const metadataPath = join(root, 'daemon-metadata.json'), argumentsPath = join(root, 'daemon-arguments.json');
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
    if(process.argv.slice(2).join(' ')!=='--build-metadata')process.exit(9);
    console.log(fs.readFileSync(${JSON.stringify(metadataPath)},'utf8'));`, { mode: 0o755 });
  const manifestPath = join(installed, 'bin/release-manifest.json');
  const manifest = { schema: 'paperclip.runner.release-binaries.v1', sourceRevision,
    platforms: Object.fromEntries(['darwin-arm64','darwin-x64','linux-x64'].map(platform => [platform,
      { path: `${platform}/paperclip-runnerd`, sha256: hash(readFileSync(executable)) }])) };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(server, 'dist/build-info.json'), JSON.stringify({ commit: sourceRevision }));
  return { installed, executable, sourceRevision, metadataPath, argumentsPath, manifestPath, manifest, metadata };
}

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

test('hosted Mac lifecycle denies OS networking and writes only owned temporary state', () => {
  const policy = macPublicInstallLifecyclePolicy({ ownedRoot: '/private/tmp/owned-qualification', npmRoot: '/Users/runner/node/npm' });
  assert.match(policy, /\(deny default\)/);
  assert.match(policy, /\(deny network\*\)/);
  assert.match(policy, /\(allow file-read-data file-test-existence \(literal "\/"\)\)/);
  assert.match(policy, /\(allow file-write\* \(subpath "\/private\/tmp\/owned-qualification"\) \(literal "\/dev\/null"\)\)/);
  assert.doesNotMatch(policy, /allow default|allow network|mach-lookup|syscall|\(subpath "\/"\)/);
  for (const ownedRoot of ['/', '../home', '/private/tmp/../other', '/private/tmp/owned\n(allow default)']) {
    assert.throws(() => macPublicInstallLifecyclePolicy({ ownedRoot, npmRoot: '/Users/runner/node/npm' }), /absolute owned/);
  }
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  const sandbox = source.indexOf("stage: 'offline-lifecycle', command: '/usr/bin/sandbox-exec'");
  assert.ok(sandbox > source.indexOf("stage: 'scripts-disabled-install'"));
  assert.ok(sandbox < source.indexOf('const listener = createServer()'));
  assert.match(source, /command: '\/usr\/bin\/sandbox-exec',[\s\S]*?args: \['-f', policy,[\s\S]*?GROK_PUBLIC_INSTALL_LIFECYCLE\.slice\(1\)/);
  assert.match(source, /Hosted Mac lifecycle qualification requires OS network isolation/);
  assert.doesNotMatch(source, /no OS egress assertion/);
});

test('hosted Mac lifecycle reads only the selected Apple developer root', () => {
  for (const developerRoot of ['/Applications/Xcode_16.4.app/Contents/Developer', '/Library/Developer/CommandLineTools']) {
    const policy = macPublicInstallLifecyclePolicy({ ownedRoot: '/private/tmp/owned', npmRoot: '/Users/runner/node/npm', developerRoot });
    assert.ok(policy.includes(`(subpath ${JSON.stringify(developerRoot)})`));
    assert.match(policy, /\(deny network\*\)/);
    assert.equal(policy.match(/\(allow file-write\*/g).length, 1);
    assert.doesNotMatch(policy, /\(subpath "\/Applications"\)|\(subpath "\/Library"\)|\(subpath "\/Users"\)/);
  }
  for (const developerRoot of ['/', '/Applications', '/Applications/../Users/qa.app/Contents/Developer', '/Users/qa/Xcode.app/Contents/Developer', '/Library/Developer', '/Applications/Xcode.app/Contents/Developer\n(allow default)']) {
    assert.throws(() => assertMacDeveloperRoot(developerRoot), /exact selected Apple/);
  }
});

test('selected Xcode lifecycle can read its runtime frameworks without granting other app contents', () => {
  const developerRoot = '/Applications/Xcode_16.4.app/Contents/Developer';
  const policy = macPublicInstallLifecyclePolicy({ ownedRoot: '/private/tmp/owned', npmRoot: '/Users/runner/node/npm', developerRoot });
  assert.ok(policy.includes('(subpath "/Applications/Xcode_16.4.app/Contents/SharedFrameworks")'));
  assert.ok(policy.includes('(subpath "/Applications/Xcode_16.4.app/Contents/Frameworks")'));
  assert.doesNotMatch(policy, /\(subpath "\/Applications(?:"|\/Xcode_16\.4\.app"|\/Xcode_16\.4\.app\/Contents")/);
  assert.doesNotMatch(policy, /PlugIns|Xcode_15|\(allow network|\(allow default/);
  assert.match(policy, /\(allow file-write\* \(subpath "\/private\/tmp\/owned"\) \(literal "\/dev\/null"\)\)/);
  const commandLineTools = macPublicInstallLifecyclePolicy({ ownedRoot: '/private/tmp/owned', npmRoot: '/Users/runner/node/npm',
    developerRoot: '/Library/Developer/CommandLineTools' });
  assert.doesNotMatch(commandLineTools, /Frameworks|\(subpath "\/Applications/);
});

test('offline Node headers must come from the selected distribution and match its exact version', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-mac-headers-test-')));
  const distribution = join(root, 'node'), headers = join(distribution, 'include/node'), executable = join(distribution, 'bin/node');
  try {
    await mkdir(headers, { recursive: true }); await mkdir(join(distribution, 'bin'));
    await writeFile(executable, 'node fixture');
    await writeFile(join(headers, 'node_version.h'), '#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 20\n#define NODE_PATCH_VERSION 0\n');
    await writeFile(join(headers, 'config.gypi'), '{}'); await writeFile(join(headers, 'common.gypi'), '{}');
    const options = { nodeExecutable: executable, nodeVersion: 'v24.20.0', destination: join(root, 'owned-headers') };
    const receipt = prepareMacPublicInstallNodeHeaders(options);
    assert.equal(receipt.source, headers); assert.equal(receipt.version, 'v24.20.0');
    assert.equal(readFileSync(join(receipt.destination, 'include/node/node_version.h'), 'utf8'), readFileSync(join(headers, 'node_version.h'), 'utf8'));
    assert.throws(() => prepareMacPublicInstallNodeHeaders(options), /new owned directory/);
    assert.throws(() => prepareMacPublicInstallNodeHeaders({ ...options, nodeVersion: 'v24.19.0', destination: join(root, 'wrong-version') }), /must match v24.19.0/);
    await rm(join(headers, 'common.gypi'));
    assert.throws(() => prepareMacPublicInstallNodeHeaders({ ...options, destination: join(root, 'missing-config') }), /Missing offline Node build header/);
    await rm(join(headers, 'node_version.h'));
    assert.throws(() => prepareMacPublicInstallNodeHeaders({ ...options, destination: join(root, 'missing-headers') }), /missing offline headers/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed Mac install phases retain bounded npm debug tails before owned cache cleanup', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-mac-phase-test-'))), logs = join(root, '_logs');
  const events = [], options = { stage: 'scripts-disabled-install', command: process.execPath, cwd: root, env: { PATH: '/usr/bin:/bin' }, cache: root, log: value => events.push(JSON.parse(value)) };
  try {
    await mkdir(logs);
    await writeFile(join(logs, '2026-debug-0.log'), `${'a'.repeat(20_000)}last completed public fetch`);
    await symlink(join(root, 'outside.log'), join(logs, '2027-debug-0.log'));
    assert.throws(() => runMacPublicInstallPhase({ ...options, args: ['-e', 'console.error("observed stderr"); process.exit(7)'] }), error => error.status === 7);
    assert.equal(events[1].status, 'failed'); assert.equal(events[1].exitCode, 7); assert.match(events[1].stderr, /observed stderr/);
    assert.equal(events[2].status, 'npm-diagnostic'); assert.equal(events[2].name, '2026-debug-0.log');
    assert.equal(Buffer.byteLength(events[2].tail), 16 * 1024); assert.match(events[2].tail, /last completed public fetch$/);
    assert.equal(events.length, 3, 'A substituted symlink cannot read an outside diagnostic');
    events.length = 0;
    assert.throws(() => runMacPublicInstallPhase({ ...options, args: ['-e', 'setTimeout(() => {}, 60_000)'], timeout: 100 }), error => error.code === 'ETIMEDOUT');
    assert.equal(events[1].code, 'ETIMEDOUT'); assert.equal(events[2].status, 'npm-diagnostic');
    assert.throws(() => runMacPublicInstallPhase({ ...options, args: [], timeout: 480_001 }), /bounded timeout/);
    events.length = 0;
    assert.equal(runMacPublicInstallPhase({ ...options, args: ['-e', 'console.log("done")'] }).toString().trim(), 'done');
    assert.deepEqual(events.map(event => event.status), ['started', 'passed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Mac install timeout retains early phase totals despite late reify noise without adding raw metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperclip-mac-timings-test-')), logs = join(root, '_logs'), events = [];
  try {
    await mkdir(logs);
    const early = '10 timing idealTree:userRequests Completed in 340000ms\n11 timing idealTree Completed in 360000ms\n12 timing reify:loadTrees Completed in 360005ms\n';
    const noise = '200 timing reifyNode:node_modules/@private/package-name Completed in 10097ms\n'.repeat(20_000);
    await writeFile(join(logs, '2026-debug-0.log'), early + noise + '999 timing reify:unpack Completed in 111000ms\n');
    await writeFile(join(logs, '2026-timing.json'), JSON.stringify({ metadata: { secret: 'MUST_NOT_APPEAR', argv: ['https://example.com/?token=secret'] },
      timers: { 'npm:load': 15, 'command:install': 479900, 'https://example.com/?token=secret': 1 } }));
    assert.throws(() => runMacPublicInstallPhase({ stage: 'scripts-disabled-install', command: process.execPath,
      args: ['-e', 'console.log("npm timing idealTree:init Completed in 12ms");console.error("npm timing reify:diffTrees Completed in 3ms");setTimeout(()=>{},60000)'],
      cwd: root, env: { PATH: '/usr/bin:/bin' }, cache: root, timeout: 150,
      log: value => events.push(JSON.parse(value)) }), error => error.code === 'ETIMEDOUT');
    const summaries = events.filter(event => event.status === 'npm-timing-summary');
    assert.equal(summaries.length, 1);
    const summary = summaries[0], encoded = JSON.stringify(summary);
    assert.ok(Buffer.byteLength(encoded) <= 16 * 1024);
    assert.equal(summary.inspectedBytesPerLogLimit, 1024 * 1024);
    const timing = (source, phase) => summary.timings.find(item => item.source === source && item.phase === phase);
    assert.equal(timing('2026-debug-0.log', 'idealTree:userRequests').totalMs, 340000);
    assert.equal(timing('2026-debug-0.log', 'idealTree').totalMs, 360000);
    assert.equal(timing('2026-debug-0.log', 'reify:loadTrees').totalMs, 360005);
    assert.equal(timing('2026-debug-0.log', 'reify:unpack').totalMs, 111000);
    assert.equal(timing('2026-debug-0.log', 'reifyNode').maximumMs, 10097);
    assert.ok(timing('2026-debug-0.log', 'reifyNode').completedCount < 20_000, 'Only the bounded head and tail may be inspected');
    assert.equal(timing('stdout', 'idealTree:init').totalMs, 12);
    assert.equal(timing('stderr', 'reify:diffTrees').totalMs, 3);
    assert.equal(timing('2026-timing.json', 'command:install').totalMs, 479900);
    assert.doesNotMatch(encoded, /MUST_NOT_APPEAR|https:|token|private\/package-name|argv|metadata/);
    const tail = events.find(event => event.status === 'npm-diagnostic' && event.name === '2026-debug-0.log').tail;
    assert.equal(Buffer.byteLength(tail), 16 * 1024);
    assert.doesNotMatch(tail, /idealTree:userRequests/, 'The old tail-only diagnostic misses the independently preserved early phase');
    assert.equal(events.filter(event => event.status === 'started').length, 1, 'A diagnostic must not retry installation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Mac timing summaries stay within sixteen KiB even with many distinct completed phases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperclip-mac-timing-budget-test-')), logs = join(root, '_logs'), events = [];
  try {
    await mkdir(logs);
    await writeFile(join(logs, '2026-debug-0.log'), '1 timing idealTree:userRequests Completed in 340000ms\n' +
      Array.from({ length: 5000 }, (_, index) => `${index + 2} timing reify:phase${index} Completed in 1ms\n`).join(''));
    assert.throws(() => runMacPublicInstallPhase({ stage: 'scripts-disabled-install', command: process.execPath,
      args: ['-e', 'process.exit(7)'], cwd: root, env: { PATH: '/usr/bin:/bin' }, cache: root,
      log: value => events.push(JSON.parse(value)) }), error => error.status === 7);
    const summary = events.find(event => event.status === 'npm-timing-summary');
    assert.equal(summary.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 16 * 1024);
    assert.equal(summary.timings[0].phase, 'idealTree:userRequests');
    assert.equal(summary.timings[0].totalMs, 340000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the initial Mac package resolution can use the fixed eight-minute diagnostic budget', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-mac-budget-test-'))), events = [];
  const options = { command: process.execPath, args: ['-e', 'console.log("bounded initial phase")'], cwd: root,
    env: { PATH: '/usr/bin:/bin' }, cache: root, log: value => events.push(JSON.parse(value)) };
  try {
    assert.equal(MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS, 480_000);
    for (const stage of ['offline-lifecycle', 'other-phase']) {
      assert.throws(() => runMacPublicInstallPhase({ ...options, stage, timeout: 180_001 }), /bounded timeout/);
      assert.throws(() => runMacPublicInstallPhase({ ...options, stage, timeout: MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS }), /bounded timeout/);
    }
    assert.throws(() => runMacPublicInstallPhase({ ...options, stage: 'scripts-disabled-install', timeout: 480_001 }), /bounded timeout/);
    assert.equal(runMacPublicInstallPhase({ ...options, stage: 'scripts-disabled-install', timeout: MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS })
      .toString().trim(), 'bounded initial phase');
    assert.deepEqual(events.map(event => [event.status, event.timeoutMs]), [['started', 480_000], ['passed', 480_000]]);
    events.length = 0;
    runMacPublicInstallPhase({ ...options, stage: 'offline-lifecycle' });
    assert.deepEqual(events.map(event => event.timeoutMs), [180_000, 180_000]);
    const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
    assert.match(source, /stage: 'scripts-disabled-install',[\s\S]*?cache, timeout: MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS \}\)/);
    assert.equal(source.split('timeout: MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS').length - 1, 1);
    assert.doesNotMatch(source, /process\.env\.[A-Z_]*(?:TIMEOUT|BUDGET)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hosted Mac lifecycle starts standalone Node 24 while denying other homes and loopback networking', {
  skip: process.platform !== 'darwin' || !process.versions.node.startsWith('24.')
    ? 'The hosted macOS lifecycle fixture selects standalone Node 24' : false,
}, async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-mac-lifecycle-test-')));
  const outside = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-mac-other-home-test-')));
  try {
    const bin = join(root, 'bin'), node = join(bin, 'node'), policy = join(root, 'lifecycle.sb'), oldPolicy = join(root, 'old-lifecycle.sb');
    await mkdir(bin);
    await cp(process.execPath, node);
    await chmod(node, 0o755);
    await writeFile(join(outside, 'fixture.txt'), 'harmless other-home control');
    const toolchain = discoverMacPublicInstallToolchain(), { developerRoot, compiler } = toolchain;
    const compilerOptions = { cwd: root, timeout: 10_000, encoding: 'utf8', maxBuffer: 16 * 1024,
      env: { HOME: root, TMPDIR: root, PATH: `${bin}:/usr/bin:/bin`, DEVELOPER_DIR: developerRoot },
      input: '__clang__ __GNUC__ __GNUC_MINOR__ __GNUC_PATCHLEVEL__ __clang_major__ __clang_minor__ __clang_patchlevel__\n', stdio: 'pipe' };
    await writeFile(oldPolicy, macPublicInstallLifecyclePolicy({ ownedRoot: root, npmRoot: join(root, 'npm') }));
    const oldCompilerOptions = { ...compilerOptions, env: { HOME: root, TMPDIR: root, PATH: `${bin}:/usr/bin:/bin` } };
    assert.throws(() => execFileSync('/usr/bin/sandbox-exec', ['-f', oldPolicy, '/usr/bin/cc', '-E', '-P', '-x', 'c', '-'], oldCompilerOptions));
    await writeFile(policy, macPublicInstallLifecyclePolicy({ ownedRoot: root, npmRoot: join(root, 'npm'), developerRoot }));
    const compilerIdentity = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, compiler, '-E', '-P', '-x', 'c', '-'], compilerOptions).trim();
    assert.match(compilerIdentity, /^1(?:\s+\d+){6}$/, 'The exact buildcheck compiler probe must work with only the selected toolchain read grant');
    assert.match(execFileSync('/usr/bin/sandbox-exec', ['-f', policy, toolchain.cxx, '-E', '-P', '-x', 'c++', '-'], compilerOptions).trim(), /^1(?:\s+\d+){6}$/);
    const pythonVersion = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, toolchain.python, '-c', 'import sys; print("%s.%s.%s" % sys.version_info[:3])'], {
      ...compilerOptions, input: undefined, env: { ...compilerOptions.env, SDKROOT: toolchain.sdk, PYTHONDONTWRITEBYTECODE: '1' } }).trim();
    assert.match(pythonVersion, /^3\.\d+\.\d+$/);
    assert.match(execFileSync('/usr/bin/sandbox-exec', ['-f', policy, '/usr/bin/make', '--version'], {
      ...compilerOptions, input: undefined }).trim(), /^GNU Make/, 'The make shim must load the selected Apple build tools');
    if (developerRoot.startsWith('/Applications/')) {
      const framework = join(dirname(developerRoot), 'SharedFrameworks/DVTSystemPrerequisites.framework/Versions/A/DVTSystemPrerequisites');
      const frameworkRead = `require('node:fs').closeSync(require('node:fs').openSync(${JSON.stringify(framework)},'r'))`;
      const developerOnlyPolicy = join(root, 'developer-only.sb');
      let withoutFrameworks = macPublicInstallLifecyclePolicy({ ownedRoot: root, npmRoot: join(root, 'npm'), developerRoot });
      for (const name of ['Frameworks', 'SharedFrameworks']) {
        withoutFrameworks = withoutFrameworks.replace(`(subpath ${JSON.stringify(join(dirname(developerRoot), name))})`, '');
      }
      await writeFile(developerOnlyPolicy, withoutFrameworks);
      assert.throws(() => execFileSync('/usr/bin/sandbox-exec', ['-f', developerOnlyPolicy, node, '-e', frameworkRead], {
        ...compilerOptions, input: undefined }), /EPERM/, 'The previous developer-only policy denies this runtime framework');
      execFileSync('/usr/bin/sandbox-exec', ['-f', policy, node, '-e', frameworkRead], { ...compilerOptions, input: undefined });
    }
    const readCompiler = `const fs=require('node:fs');try{fs.closeSync(fs.openSync(${JSON.stringify(compiler)},'r'));console.log('ALLOWED')}catch(e){console.log(e.code)}`;
    assert.equal(execFileSync('/usr/bin/sandbox-exec', ['-f', oldPolicy, node, '-e', readCompiler], {
      ...compilerOptions, input: undefined }).trim(), 'EPERM', 'The old policy denies selected toolchain file reads');
    const code = `const fs=require('node:fs'),net=require('node:net');
      const r={node:process.version};
      fs.writeFileSync(${JSON.stringify(join(root, 'owned-write'))},'ok');r.ownedWrite='ok';
      fs.closeSync(fs.openSync(${JSON.stringify(compiler)},'r'));r.selectedToolchainRead='ok';
      r.selectedSdkVersion=JSON.parse(fs.readFileSync(${JSON.stringify(join(toolchain.sdk, 'SDKSettings.json'))},'utf8')).Version;
      try{fs.readFileSync(${JSON.stringify(join(outside, 'fixture.txt'))});r.outsideRead='ALLOWED'}catch(e){r.outsideRead=e.code}
      try{fs.writeFileSync(${JSON.stringify(join(outside, 'output.txt'))},'control');r.outsideWrite='ALLOWED'}catch(e){r.outsideWrite=e.code}
      const s=net.connect({host:'127.0.0.1',port:9});
      s.on('connect',()=>{r.network='ALLOWED';console.log(JSON.stringify(r));s.destroy()});
      s.on('error',e=>{r.network=e.code;console.log(JSON.stringify(r))});`;
    const output = execFileSync('/usr/bin/sandbox-exec', ['-f', policy, node, '-e', code], {
      cwd: root, timeout: 10_000, maxBuffer: 65_536,
      env: { HOME: root, TMPDIR: root, PATH: `${bin}:/usr/bin:/bin`, NODE_PATH: '' },
      stdio: 'pipe',
    }).toString().trim();
    assert.deepEqual(JSON.parse(output), { node: process.version, ownedWrite: 'ok',
      selectedToolchainRead: 'ok', selectedSdkVersion: toolchain.sdkVersion, outsideRead: 'EPERM', outsideWrite: 'EPERM', network: 'EPERM' });
    assert.equal(readFileSync(join(root, 'owned-write'), 'utf8'), 'ok');
    assert.equal(readFileSync(join(outside, 'fixture.txt'), 'utf8'), 'harmless other-home control');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a root or malformed host identity cannot run lifecycle scripts', () => {
  for (const uid of [0, -1, undefined, '1001']) {
    assert.throws(() => grokConsumerDockerArgs({ ...paths, uid, command: ['npm', 'ci'] }), /unprivileged/);
  }
});

test('the scripts-disabled dependency download gets network access before offline lifecycle execution', () => {
  const args = grokConsumerDockerArgs({ ...paths, download: true, command: ['npm', 'install', '--ignore-scripts'] });
  assert.deepEqual(values(args, '--network'), ['bridge']);
  assert.ok(values(args, '--env').includes('npm_config_ignore_scripts=true'));
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

test('installed CLI startup stays offline with private state and a read-only installed graph', () => {
  const args = grokConsumerDockerArgs({ ...paths, uid: 1000, gid: 1000, runtimeSmoke: true, command: ['node', '/packages/installed-cli-probe.mjs'] });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.ok(values(args, '--mount').includes('type=bind,src=/private/staging/consumer,dst=/consumer,readonly'));
  assert.ok(values(args, '--env').includes('PAPERCLIP_TELEMETRY_DISABLED=1'));
  assert.throws(() => grokConsumerDockerArgs({ ...paths, runtimeSmoke: true, download: true }), /Runtime smoke/);
});

test('the separate optional browser fixture receives an owned network and loopback port', () => {
  const args = grokConsumerDockerArgs({ ...paths, uid: 1000, gid: 1000, runtimeSmoke: true,
    browserNetwork: 'paperclip-public-install-fixture', containerName: 'paperclip-public-install-fixture', command: ['node', '/packages/installed-cli-probe.mjs'] });
  assert.deepEqual(values(args, '--network'), ['paperclip-public-install-fixture']);
  assert.deepEqual(values(args, '--publish'), ['127.0.0.1::3100']);
  assert.ok(args.includes('--detach'));
  for (const browserNetwork of ['bridge', 'host', 'none']) {
    assert.throws(() => grokConsumerDockerArgs({ ...paths, uid: 1000, gid: 1000, runtimeSmoke: true, browserNetwork, containerName: 'paperclip-public-install-fixture' }), /owned network/);
  }
  const source = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('isolated(GROK_PUBLIC_INSTALL_LIFECYCLE)') < source.indexOf("run('docker', ['network', 'create', browserOwner])"));
  assert.doesNotMatch(source, /\['network', 'create', '--internal'/);
});

test('portable installed probe preserves Linux defaults and requires explicit owned paths and loopback', () => {
  assert.deepEqual(installedProbePaths(), { consumer: '/consumer', dataDirectory: '/tmp/paperclip-installed-smoke',
    readyPath: '/tmp/paperclip-installed-smoke-ready.json', base: 'http://127.0.0.1:3100' });
  const privatePaths = { consumer: '/private/tmp/installed/consumer', dataDirectory: '/private/tmp/installed/state',
    readyPath: '/private/tmp/installed/ready.json', base: 'http://127.0.0.1:39919' };
  assert.deepEqual(installedProbePaths(privatePaths), privatePaths);
  for (const base of ['http://localhost:39919', 'http://0.0.0.0:39919', 'https://example.com:39919', 'http://127.0.0.1:39919/path']) {
    assert.throws(() => installedProbePaths({ ...privatePaths, base }), /loopback/);
  }
  for (const consumer of ['relative', '/', '/private/tmp/installed/../consumer']) {
    assert.throws(() => installedProbePaths({ ...privatePaths, consumer }), /Invalid installed probe/);
  }
  assert.throws(() => installedProbePaths({ ...privatePaths, command: 'external' }), /Unknown installed probe/);
});

test('standard image qualification rejects mutable references and mismatched serving provenance', () => {
  const sourceRevision = 'a'.repeat(40), image = `ghcr.io/paperclipai/paperclip@sha256:${'b'.repeat(64)}`;
  const request = standardImageRequest(sourceRevision, image);
  const metadata = { Os: 'linux', Architecture: 'amd64', RepoDigests: [image], Config: { Labels: { 'org.opencontainers.image.revision': sourceRevision } } };
  assertStandardImageIdentity(request, metadata);
  for (const [source, target] of [['master', image], [sourceRevision, 'ghcr.io/paperclipai/paperclip:latest'], [sourceRevision, image.replace('paperclipai', 'other')], [sourceRevision, '']]) {
    assert.throws(() => standardImageRequest(source, target));
  }
  assert.throws(() => assertStandardImageIdentity(request, { ...metadata, RepoDigests: [] }), /requested digest/);
  assert.throws(() => assertStandardImageIdentity(request, { ...metadata, Config: { Labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) } } }), /requested source/);
});

test('standard image starts its shipped command with no network, host data, or elevated privileges', () => {
  const image = `ghcr.io/paperclipai/paperclip@sha256:${'b'.repeat(64)}`;
  const args = standardImageDockerArgs({ sourceRevision: 'a'.repeat(40), image,
    owner: 'paperclip-public-install-image-test', probePath: '/qa/installed-cli-probe.mjs', authSecret: 'c'.repeat(64) });
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--user'), ['1000:1000']);
  assert.deepEqual(values(args, '--mount'), ['type=bind,src=/qa/installed-cli-probe.mjs,dst=/qa/installed-cli-probe.mjs,readonly']);
  assert.equal(args.includes('--read-only'), false, 'The supported entrypoint must be able to prepare image-owned Postgres library aliases');
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--entrypoint'), []);
  assert.deepEqual(values(args, '--publish'), []);
  assert.equal(args.at(-1), image, 'No appended command may replace the shipped CMD');
  assert.ok(values(args, '--tmpfs').includes('/paperclip:rw,nosuid,nodev,size=1024m,mode=700,uid=1000,gid=1000'));
  assert.throws(() => standardImageDockerArgs({ sourceRevision: 'a'.repeat(40), image, owner: 'other-container', probePath: '/qa/installed-cli-probe.mjs', authSecret: 'c'.repeat(64) }));
});

test('installed UI readiness checks a real HTTP response, exact serving commit, and installed asset bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperclip-install-ui-test-'));
  const sourceRevision = 'a'.repeat(40), script = 'export const installed = true;';
  let commit = sourceRevision, servedScript = script, startingResponses = 1, healthRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      healthRequests += 1;
      response.end(JSON.stringify({ status: healthRequests <= startingResponses ? 'starting' : 'ok', commit }));
    }
    else if (request.url === '/onboarding') { response.setHeader('Content-Type', 'text/html'); response.end('<div id="root"></div><script src="/assets/installed.js"></script>'); }
    else if (request.url === '/assets/installed.js') response.end(servedScript);
    else { response.statusCode = 404; response.end(); }
  });
  try {
    await mkdir(join(root, 'ui-dist/assets'), { recursive: true });
    await writeFile(join(root, 'ui-dist/assets/installed.js'), script);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const options = { base: `http://127.0.0.1:${server.address().port}`, server: root, sourceRevision, timeoutMs: 500 };
    const receipt = await inspectInstalledUi(options);
    assert.equal(healthRequests, 2, 'HTTP 200 during startup cannot establish installed runtime readiness');
    assert.equal(receipt.servingCommit, sourceRevision);
    assert.equal(receipt.installedUiAssetsPassed, true);
    assert.equal(receipt.assets[0].bytes, Buffer.byteLength(script));
    await mkdir(join(root, 'monorepo-ui/assets'), { recursive: true });
    await writeFile(join(root, 'monorepo-ui/assets/installed.js'), script);
    const imageOptions = { ...options, uiDirectory: join(root, 'monorepo-ui') };
    assert.deepEqual((await inspectInstalledUi(imageOptions)).assets, receipt.assets);
    await assert.rejects(inspectInstalledUi({ ...options, uiDirectory: '../ui/dist' }), /Invalid installed UI directory/);
    commit = 'b'.repeat(40);
    await assert.rejects(inspectInstalledUi(options), /serving commit/);
    commit = sourceRevision; servedScript = 'export const substituted = true;';
    await assert.rejects(inspectInstalledUi(options), /must be the installed file/);
    await assert.rejects(inspectInstalledUi(imageOptions), /must be the installed file/);
    startingResponses = Infinity;
    await assert.rejects(inspectInstalledUi(options), /Installed CLI server did not become ready/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('installed provider readiness uses public login and OpenCode resolvers with the server-bound Claude verifier', async () => {
  // Unit fixtures exercise the probe contract. Actual package qualification
  // invokes these checks against the installed graph, never these fixtures.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-provider-readiness-test-')));
  const bin = join(root, 'bin'), server = join(root, 'server');
  const installed = join(server, 'dist/vendor/paperclip-runner/drivers/acpx');
  try {
    await mkdir(bin); await mkdir(installed, { recursive: true });
    await mkdir(join(server, 'dist/vendor/paperclip-runner/drivers/codex'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(server, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'opencode-ai': '1.18.34' } }));
    await writeFile(join(bin, 'codex'), `#!${process.execPath}\nimport fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(join(root, 'codex-arguments.json'))}, JSON.stringify(process.argv.slice(2)));
      if (process.argv.slice(2).join(' ') !== '--version') process.exit(9);
      console.log('codex-cli 0.160.0');\n`, { mode: 0o755 });
    await writeFile(join(server, 'dist/vendor/paperclip-runner/drivers/codex/codex-command.js'), `import fs from 'node:fs';
      export function resolvePinnedCodexCommand() {
        if (fs.existsSync(${JSON.stringify(join(root, 'missing-codex'))})) throw new Error('Pinned Codex runtime unavailable: missing installed package; choose Legacy runner in Advanced');
        return ${JSON.stringify(join(bin, 'codex'))};
      }`);
    await writeFile(join(bin, 'claude'), `#!${process.execPath}\nprocess.exit(9);\n`, { mode: 0o755 });
    await writeFile(join(bin, 'opencode'), `#!${process.execPath}\nimport fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(join(root, 'opencode-arguments.json'))}, JSON.stringify(process.argv.slice(2)));
      if (process.argv.slice(2).join(' ') !== '--version') process.exit(9);
      console.log('1.18.34');\n`, { mode: 0o755 });
    await writeFile(join(server, 'dist/vendor/paperclip-runner/index.js'), `import fs from 'node:fs';
      export { resolvePinnedCodexCommand } from './drivers/codex/codex-command.js';
      export async function resolvePinnedClaudeCommand() {
        if (fs.existsSync(${JSON.stringify(join(root, 'missing-claude'))})) throw new Error('Qualified Claude login bundle missing');
        return ${JSON.stringify(join(bin, 'claude'))};
      }
      export function resolvePinnedOpenCodeCommand() {
        if (fs.existsSync(${JSON.stringify(join(root, 'missing-opencode'))})) throw new Error('Packaged OpenCode runtime unavailable');
        return ${JSON.stringify(join(bin, 'opencode'))};
      }`);
    await writeFile(join(installed, 'qualified-profiles.js'), `export const QUALIFIED_ACPX_PROFILES={codex:{agentRuntimeVersion:'0.160.0'}};
      export function resolveQualifiedAcpxProfile(agent, model) {
      if (agent !== 'claude' || model !== 'claude-sonnet-5') throw new Error('Unexpected profile');
      return {agentServerPackage:'@agentclientprotocol/claude-agent-acp',agentServerVersion:'0.73.0',
        agentRuntimePackage:'@anthropic-ai/claude-agent-sdk',agentRuntimeVersion:'0.3.286',commandDigest:'sha256:fixture'};
    }`);
    await writeFile(join(installed, 'installation-integrity.js'), `import fs from 'node:fs';
      export function createAcpxPackageJsonResolver(root,manifest) {
        if(root!==${JSON.stringify(server)}||manifest!==${JSON.stringify(join(server, 'package.json'))})throw new Error('Wrong provider authority');
        return name=>name;
      }
      export async function verifyQualifiedAcpxInstallation(profile,resolver) {
        if (fs.existsSync(${JSON.stringify(join(root, 'bad-claude'))})) throw new Error('ACPX claude runtime version mismatch');
        if(resolver(profile.agentServerPackage)!==profile.agentServerPackage)throw new Error('Missing package resolver');
        fs.writeFileSync(${JSON.stringify(join(root, 'claude-model'))}, profile.agentServerPackage);
        return {openCommand:async()=>({close:async()=>{fs.writeFileSync(${JSON.stringify(join(root, 'claude-lease-closed'))},'closed');}})};
      }`);
    const daemon = await daemonFixture(root, server);
    const receipt = await inspectInstalledProviderReadiness({ server, commandPath: bin });
    assert.equal(receipt.providerCalls, 0);
    assert.equal(receipt.codex.executable, join(bin, 'codex'));
    assert.equal(receipt.codex.version, 'codex-cli 0.160.0');
    assert.equal(receipt.codex.publicEntryPointVerified, true);
    assert.equal(receipt.codex.loginCommandResolved, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'codex-arguments.json'), 'utf8')), ['--version']);
    assert.equal(readFileSync(join(root, 'claude-model'), 'utf8'), '@agentclientprotocol/claude-agent-acp');
    assert.equal(readFileSync(join(root, 'claude-lease-closed'), 'utf8'), 'closed');
    assert.equal(receipt.claude.packageAuthority, server);
    assert.equal(receipt.claude.agentRuntimeVersion, '0.3.286');
    assert.equal(receipt.claude.commandLeasePassed, true);
    assert.equal(receipt.claude.executable, join(bin, 'claude'));
    assert.equal(receipt.claude.publicEntryPointVerified, true);
    assert.equal(receipt.claude.loginCommandResolved, true);
    assert.equal(receipt.opencode.executable, join(bin, 'opencode'));
    assert.equal(receipt.opencode.version, '1.18.34');
    assert.equal(receipt.opencode.dependencyVersion, '1.18.34');
    assert.equal(receipt.opencode.publicEntryPointVerified, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'opencode-arguments.json'), 'utf8')), ['--version']);
    assert.equal(receipt.runnerd.manifestVerified, true);
    assert.equal(receipt.runnerd.executable, daemon.executable);
    assert.deepEqual(JSON.parse(readFileSync(daemon.argumentsPath, 'utf8')), ['--build-metadata']);

    const noGlobalCommands = await inspectInstalledProviderReadiness({ server, commandPath: join(root, 'empty-runtime-path') });
    assert.equal(noGlobalCommands.codex.versionProbePassed, true, 'A pinned executable does not require a global Codex command on PATH');
    assert.equal(noGlobalCommands.opencode.versionProbePassed, true, 'The default OpenCode path must use its packaged dependency');
    await writeFile(join(root, 'missing-codex'), 'missing installed package');
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: bin }), error => {
      assert.match(error.message, /Pinned Codex runtime unavailable.*Legacy runner/);
      assert.equal(error.providerReadiness.codex, undefined);
      assert.equal(error.providerReadiness.claude.installationIntegrityPassed, true, 'Preserve independently verified Claude readiness');
      return true;
    });
    await rm(join(root, 'missing-codex'));
    await writeFile(join(root, 'missing-claude'), 'missing installed login bundle');
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: bin }), error => {
      assert.match(error.message, /Qualified Claude login bundle missing/);
      assert.equal(error.providerReadiness.claude, undefined);
      assert.equal(error.providerReadiness.codex.versionProbePassed, true);
      assert.equal(error.providerReadiness.opencode.versionProbePassed, true);
      return true;
    });
    await rm(join(root, 'missing-claude'));
    await writeFile(join(root, 'missing-opencode'), 'missing packaged dependency');
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: bin }), error => {
      assert.match(error.message, /Packaged OpenCode runtime unavailable/);
      assert.equal(error.providerReadiness.opencode, undefined, 'An ambient OpenCode command cannot replace the missing package');
      assert.equal(error.providerReadiness.codex.versionProbePassed, true);
      assert.equal(error.providerReadiness.claude.installationIntegrityPassed, true);
      return true;
    });
    await rm(join(root, 'missing-opencode'));
    await writeFile(join(root, 'bad-claude'), 'mismatched installed runtime');
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: bin }), error => {
      assert.match(error.message, /Claude: ACPX claude runtime version mismatch/);
      assert.equal(error.providerReadiness.codex.versionProbePassed, true);
      assert.equal(error.providerReadiness.claude, undefined, 'An incomplete Claude verifier cannot qualify installation');
      return true;
    });
    await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconsole.log('authentication required');\n`, { mode: 0o755 });
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: bin }), /Codex did not return its CLI version/);
    await assert.rejects(inspectInstalledProviderReadiness({ server: '../checkout' }), /Invalid installed server/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed readiness rejects missing public resolver exports even when the deep Codex driver works', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-missing-public-resolver-test-')));
  const server = join(root, 'server'), installed = join(server, 'dist/vendor/paperclip-runner');
  try {
    await mkdir(join(installed, 'drivers/codex'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const executable = join(root, 'codex');
    await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 0.160.0');\n`, { mode: 0o755 });
    await writeFile(join(installed, 'drivers/codex/codex-command.js'), `export function resolvePinnedCodexCommand(){return ${JSON.stringify(executable)}}`);
    await mkdir(join(installed, 'drivers/acpx'));
    await writeFile(join(installed, 'drivers/acpx/qualified-profiles.js'), "export const QUALIFIED_ACPX_PROFILES={codex:{agentRuntimeVersion:'0.160.0'}};\n");
    await writeFile(join(installed, 'index.js'), 'export {};\n');
    await daemonFixture(root, server);
    const deepDriver = await import(pathToFileURL(join(installed, 'drivers/codex/codex-command.js')).href);
    assert.equal(execFileSync(deepDriver.resolvePinnedCodexCommand(), ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli 0.160.0');
    await assert.rejects(inspectInstalledProviderReadiness({ server, commandPath: '/usr/bin:/bin' }), error => {
      assert.match(error.message, /public runner entry point must export the qualified Codex login resolver/);
      assert.match(error.message, /public runner entry point must export the qualified Claude login resolver/);
      assert.match(error.message, /public runner entry point must export the packaged OpenCode command resolver/);
      assert.equal(error.providerReadiness.codex, undefined);
      assert.equal(error.providerReadiness.claude, undefined);
      assert.equal(error.providerReadiness.opencode, undefined);
      assert.equal(error.providerReadiness.runnerd.metadataProbePassed, true);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the explicit source-bound control permits a host-only daemon; assembled consumers require all three targets', () => {
  const source = 'a'.repeat(40);
  for (const mode of [undefined, 'offline', 'browser']) {
    const options = installedProbeMode(mode, source);
    assert.equal(options.allowHostOnlyDaemon, false);
    assert.equal(options.qualificationScope, 'assembled public npm package');
  }
  for (const mode of ['host-source', 'browser-host-source']) {
    const options = installedProbeMode(mode, source);
    assert.equal(options.allowHostOnlyDaemon, true);
    assert.equal(options.browser, mode === 'browser-host-source');
    assert.equal(options.qualificationScope, 'exact-source host-only packaging control');
    for (const invalid of [undefined, 'master', 'a'.repeat(39)]) assert.throws(() => installedProbeMode(mode, invalid), /exact source receipt/);
  }
  assert.throws(() => installedProbeMode('legacy', source), /Invalid installed probe mode/);
  const verifier = readFileSync(new URL('../verify-grok-npm-install.mjs', import.meta.url), 'utf8');
  assert.match(verifier, /assert\.equal\(builtRevision, sourceRevision[\s\S]*?const installedMode = env\.PAPERCLIP_RELEASE_RUNNER_ASSETS \? 'offline' : 'host-source'/);
  assert.match(verifier, /const installedBrowserMode = env\.PAPERCLIP_RELEASE_RUNNER_ASSETS \? 'browser' : 'browser-host-source'/);
  assert.match(verifier, /receipt\.releaseVersion, sourceRevision, 'offline', paths/);
});

test('installed daemon proof rejects source, target, digest, capability and resolver failures without ambient fallback', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-installed-daemon-test-'))), server = join(root, 'server');
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const fixture = await daemonFixture(root, server), target = `${process.platform}-${process.arch}`;
    const options = { server, sourceRevision: fixture.sourceRevision };
    const receipt = await inspectInstalledDaemon(options);
    assert.equal(receipt.sha256, hash(readFileSync(fixture.executable)));
    assert.equal(receipt.compatibilityPassed, true);
    for (const change of [manifest => { manifest.sourceRevision = 'b'.repeat(40); },
      manifest => { manifest.platforms[target].sha256 = `sha256:${'b'.repeat(64)}`; },
      manifest => { manifest.platforms[target].path = '../outside'; }]) {
      const manifest = structuredClone(fixture.manifest); change(manifest);
      await writeFile(fixture.manifestPath, JSON.stringify(manifest)); await rm(fixture.argumentsPath, { force: true });
      await assert.rejects(inspectInstalledDaemon(options), /manifest (?:source|target)|digest mismatch/);
      assert.equal((await import('node:fs')).existsSync(fixture.argumentsPath), false, 'Reject unbound bytes before execution');
    }
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    for (const change of [metadata => { metadata.nativeExecutionVersion = 999; }, metadata => { metadata.binaryName = 'other'; },
      metadata => { metadata.prp.maximumVersion = 1; }, metadata => { metadata.durableSessionCapabilities = []; }]) {
      const metadata = structuredClone(fixture.metadata); change(metadata);
      await writeFile(fixture.metadataPath, JSON.stringify(metadata));
      await assert.rejects(inspectInstalledDaemon(options), /incompatible|unexpected binary|protocol|missing durable/);
    }
    await writeFile(fixture.metadataPath, JSON.stringify(fixture.metadata));
    await writeFile(join(root, 'wrong-architecture'), 'wrong');
    await assert.rejects(inspectInstalledDaemon(options), /architecture mismatch/); await rm(join(root, 'wrong-architecture'));
    await writeFile(join(root, 'outside-resolver'), 'outside');
    await assert.rejects(inspectInstalledDaemon(options), /resolver must select/); await rm(join(root, 'outside-resolver'));
    await rm(fixture.manifestPath);
    await assert.rejects(inspectInstalledDaemon(options), /complete daemon release manifest/);
    const generic = join(fixture.installed, 'bin/paperclip-runnerd');
    await (await import('node:fs/promises')).rename(fixture.executable, generic);
    assert.equal((await inspectInstalledDaemon({ ...options, allowHostOnlyDaemon: true })).hostOnlySourceInstall, true);
    await rm(generic);
    await assert.rejects(inspectInstalledDaemon({ ...options, allowHostOnlyDaemon: true }), /no ambient fallback/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('service qualification binds a real managed shim and current link to the exact source payload', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'paperclip-service-install-test-')));
  const sourceRevision = 'a'.repeat(40), store = join(root, 'cli');
  const payload = join(store, 'installs/git', sourceRevision.slice(0, 12));
  const server = join(payload, 'node_modules/@paperclipai/server');
  const cli = join(payload, 'node_modules/paperclipai/dist/index.js');
  const manifestPath = join(store, 'install.json'), shimPath = join(root, 'paperclipai');
  const manifest = { schemaVersion: 1, source: 'git', repo: 'paperclipai/paperclip', sha: sourceRevision,
    ref: sourceRevision, payloadPath: payload, version: '0.3.1' };
  try {
    await mkdir(join(server, 'dist'), { recursive: true });
    await mkdir(join(payload, 'node_modules/paperclipai/dist'), { recursive: true });
    await writeFile(cli, `if (process.argv[2] !== '--version') process.exit(9); console.log('0.3.1');\n`);
    await writeFile(join(server, 'dist/build-info.json'), JSON.stringify({ commit: sourceRevision }));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await symlink(payload, join(store, 'current'));
    await writeFile(shimPath, `#!/bin/sh\n# paperclipai managed install shim v1\nexec "${process.execPath}" "${join(store, 'current/node_modules/paperclipai/dist/index.js')}" "$@"\n`, { mode: 0o755 });
    const options = { sourceRevision, manifestPath, shimPath };
    const receipt = inspectManagedServiceInstall(options);
    assert.equal(receipt.managedInstallCommit, sourceRevision);
    assert.equal(receipt.managedShimPassed, true);
    assert.equal(receipt.cliVersion, '0.3.1');
    for (const override of [{ source: 'npm' }, { ref: 'master' }, { sha: 'b'.repeat(40) }, { payloadPath: join(root, 'checkout') }]) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...override }));
      assert.throws(() => inspectManagedServiceInstall(options));
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(server, 'dist/build-info.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
    assert.throws(() => inspectManagedServiceInstall(options));
    await writeFile(join(server, 'dist/build-info.json'), JSON.stringify({ commit: sourceRevision }));
    await writeFile(shimPath, '#!/bin/sh\necho 0.3.1\n', { mode: 0o755 });
    assert.throws(() => inspectManagedServiceInstall(options), /real managed shim/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
