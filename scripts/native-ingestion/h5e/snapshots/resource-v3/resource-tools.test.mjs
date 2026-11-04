import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pins, transform } from './transforms.mjs';
import { MAIN, BASELINES, CANDIDATE, CONTROL_FILES, hash, validateRelease, validatePins, validateHelperApproval, startupTransform, scalarBounds } from './resource-contract.mjs';
import { serviceCommand, unitName, parseShow, validateUnit, validateStatus, validateCleanupUnit, environmentFile, environmentHash } from './pg-service.mjs';
import { diagnosticPlan, ownerWindowReport } from './run-resource-diagnostic.mjs';
import { exportPins } from './export-counter-pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(path.join(here, file));
const known = JSON.parse(read('known-builds.json'));
const digest = 'a'.repeat(64);
const release = () => ({ schema: 'native-ingestion-h5e-resource-release/v1', authorized: true, diagnosticOnly: true,
  performanceAcceptanceEligible: false, workload: 'SMALL', variant: 'B0', nonce: 'pure-unit-nonce', maxDurationMs: 1800000,
  harnessRevision: MAIN.revision, build: known.B0, output: '/tmp/unit-resource', harnessRoot: '/tmp/frozen-harness', appRoot: known.B0.appRoot,
  nodeExecutable: '/unit/node', pythonExecutable: '/unit/python3', pythonExecutableSha256: digest,
  sourcePacketFile: '/unit/source-packet.json', sourcePacketSha256: digest, counterPinsFile: '/unit/pins.json', counterPinsSha256: digest,
  mainHelperFile: '/unit/main-helper.mjs', mainHelperSha256: '9d3123024694930139369df5811c823ce3d28d216d71d1a9dd0f5f887c3ed170',
  mainHelperPacketFile: '/unit/main-packet.json', mainHelperPacketSha256: '013f84de7bfcacf989eba3932044eb1c3c52d2182efc843e65180cc71468297c',
  releaseFile: '/unit/release.json', releaseSha256: digest,
  pg: { user: 'ubuntu', group: 'ubuntu', uid: 1000, gid: 1000, postgresBinary: '/unit/pg/postgres', initdbBinary: '/unit/pg/initdb',
    nativeEntry: '/unit/pg/index.js', detectPortEntry: '/unit/detect-port.js', postgresSha256: digest, initdbSha256: digest,
    nativeEntrySha256: digest, detectPortSha256: digest, parentControlsSha256: digest,
    expectedEffectiveControls: Object.fromEntries(CONTROL_FILES.map(key => [key, null])),
    supervision: 'root-owned-systemd-exec-prestart-supported-reuse' } });
const unit = r => ({ Id: unitName(r.nonce), Type: 'exec', User: 'ubuntu', Group: 'ubuntu', MainPID: '123',
  ControlGroup: '/system.slice/' + unitName(r.nonce), InvocationID: 'a'.repeat(32), LoadState: 'loaded', ActiveState: 'active',
  SubState: 'running', Transient: 'yes', Delegate: 'no', NoNewPrivileges: 'yes', ProtectControlGroups: 'yes',
  CapabilityBoundingSet: '', AmbientCapabilities: '', CPUAccounting: 'yes', MemoryAccounting: 'yes', KillSignal: '2', RemainAfterExit: 'yes',
  KillMode: 'control-group', Restart: 'no', RuntimeMaxUSec: '30min', TimeoutStopUSec: '30s', Result: 'success' });

test('CF pins match sealed qualified B0/B1 inventories; actual B2 expected bytes remain serving-unqualified', () => {
  assert.equal(hash(read('baseline-metadata/aligned-cf-builds-qualified.json')), '5a849da1bc307f4f1fd05c70a75813f6f78acc9941a54cc01e945652a5a79d6b');
  for (const variant of ['B0', 'B1', 'B2']) {
    const bytes = read(`baseline-metadata/${variant}-artifact-inventory.json.gz`), manifest = JSON.parse(gunzipSync(bytes));
    assert.equal(hash(bytes), known[variant].manifestFileSha256);
    const r = { ...release(), variant, build: known[variant] }; validatePins(pins, r, manifest);
    assert.equal(manifest.revision, BASELINES[variant] ?? CANDIDATE);
  }
  assert.equal(pins.variants.B2.revision, CANDIDATE); assert.equal(known.B2ServingQualified, false);
  assert.throws(() => transform('port', read('test-fixtures/modules/port.js').toString(), 'B2'), /Unqualified/);
});

test('all six current source hooks retain exact byte guards, anchors and syntax', () => {
  for (const variant of ['B0', 'B1', 'B2']) for (const name of ['queue', 'port', 'resolver', 'runlog']) {
    const source = read(`test-fixtures/modules/${name === 'port' && variant === 'B2' ? 'port-B2' : name}.js`).toString(), transformed = transform(name, source, variant);
    assert.equal(hash(source), pins.variants[variant].modules[name].sha256);
    const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: transformed, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
  for (const [name, filename] of [['postgresIndex', 'index.js'], ['postgresConnection', 'connection.js']]) {
    const transformed = transform(name, read('test-fixtures/postgres/src/' + filename).toString(), 'B0');
    assert.equal(spawnSync(process.execPath, ['--check', '--input-type=module'], { input: transformed }).status, 0);
  }
});

test('startup hook checks actual CF entry bytes and exactly one existing reuse boundary', () => {
  const source = read('test-fixtures/modules/server-index-B1.js').toString(), expected = pins.variants.B1.serverIndex.sha256;
  const transformed = startupTransform(source, expected, 'file:///unit/pg-service.mjs');
  assert.ok(transformed.indexOf('prestartAtNormalBoundary') < transformed.indexOf('const runningPid = getRunningPid();'));
  assert.equal(spawnSync(process.execPath, ['--check', '--input-type=module'], { input: transformed }).status, 0);
  assert.throws(() => startupTransform(source + '\n', expected, 'file:///unit/pg-service.mjs'), /Unqualified/);
  assert.throws(() => startupTransform('missing', hash('missing'), 'file:///unit/callback'), /one normal/);
  assert.throws(() => startupTransform('const runningPid = getRunningPid();const runningPid = getRunningPid();',
    hash('const runningPid = getRunningPid();const runningPid = getRunningPid();'), 'file:///unit/callback'), /one normal/);
});

test('release rejects authorization, workload, budget, old runtime and missing actual PG pins before launch', () => {
  validateRelease(release());
  for (const mutate of [r => r.authorized = false, r => r.workload = 'reduced-full', r => r.maxDurationMs++,
    r => r.harnessRevision = '2df9897e1ce2ca90be29fa097d776c3766e217ad', r => r.pg.postgresSha256 = null,
    r => r.pg.user = 'root', r => r.pg.uid = 0, r => r.performanceAcceptanceEligible = true]) {
    const value = release(); mutate(value); assert.throws(() => validateRelease(value));
  }
});

test('parameterized candidate export requires its actual independent qualified manifest and preserves its own binary', () => {
  const baseline = JSON.parse(gunzipSync(read('baseline-metadata/B0-artifact-inventory.json.gz')));
  const build = { ...known.B0, revision: CANDIDATE, binarySha256: 'b'.repeat(64), qualifiedReceiptSha256: 'c'.repeat(64) };
  const manifest = { ...baseline, variant: 'B2', revision: CANDIDATE, compiledBuildRevision: CANDIDATE };
  const candidate = exportPins(pins, 'B2', build, manifest);
  assert.equal(candidate.variants.B2.revision, CANDIDATE); assert.equal(candidate.runtime.nativeBinarySha256, build.binarySha256);
  assert.equal(pins.variants.B2.revision, CANDIDATE, 'Existing actual expected pins are not mutated by metadata export');
  assert.throws(() => exportPins(pins, 'B2', build, baseline));
  assert.throws(() => exportPins(pins, 'B2', build, { ...manifest, variant: 'B0' }));
  assert.throws(() => exportPins(pins, 'B2', build, { ...manifest, compiledBuildRevision: BASELINES.B0 }));
  assert.throws(() => exportPins(pins, 'B2', build, { ...manifest, files: [] }));
});

test('service starts exact PG in root-owned nondelegated Type=exec scope before any child; no PID migration command', () => {
  const r = release(), args = serviceCommand(r, '/tmp/owned/db', 55432, '/tmp/owned/private-environment');
  assert.ok(args.includes('--service-type=exec')); assert.ok(args.includes('--property=User=ubuntu'));
  for (const flag of ['--property=NoNewPrivileges=yes', '--property=Delegate=no', '--property=ProtectControlGroups=yes',
    '--property=CapabilityBoundingSet=', '--property=RuntimeMaxSec=1800s', '--property=KillSignal=SIGINT']) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-6), ['--', r.pg.postgresBinary, '-D', '/tmp/owned/db', '-p', '55432']);
  assert.equal(args.some(value => value.includes('cgroup.procs')), false);
});

test('normal PG environment is privately encoded and compared by hashes without appearing in argv', () => {
  const values = { PATH: '/unit/bin:/usr/bin', LC_MESSAGES: 'C', FIXTURE_VALUE: 'quote" slash\\ dollar$ backtick`' };
  const encoded = environmentFile(values); assert.ok(encoded.includes('quote\\"')); assert.ok(encoded.includes('slash\\\\'));
  assert.equal(environmentHash(values), environmentHash(Object.fromEntries(Object.entries(values).reverse())));
  assert.throws(() => environmentFile({ SECRET: 'line\nbreak' }));
  const command = serviceCommand(release(), '/tmp/owned/db', 55432, '/tmp/owned/private-environment');
  assert.equal(JSON.stringify(command).includes(values.FIXTURE_VALUE), false);
});

test('service proof rejects proxy PID, wrong unit/user, delegation, capabilities and writable-control configuration', () => {
  const r = release(), valid = unit(r), identity = { pid: 123, ppid: 1, starttimeTicks: '55' };
  validateUnit(valid, r, identity, ['123']);
  for (const [key, value] of [['MainPID', '124'], ['Type', 'simple'], ['User', 'root'], ['Delegate', 'yes'],
    ['NoNewPrivileges', 'no'], ['ProtectControlGroups', 'no'], ['CapabilityBoundingSet', 'cap_sys_admin'], ['ControlGroup', '/foreign'],
    ['RuntimeMaxUSec', 'infinity'], ['TimeoutStopUSec', '5min'], ['Restart', 'on-failure']])
    assert.throws(() => validateUnit({ ...valid, [key]: value }, r, identity, ['123']));
  const status = 'Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nNoNewPrivs:\t1\nCapEff:\t00000000\nCapBnd:\t00000000\n';
  validateStatus(status, r); assert.throws(() => validateStatus(status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), r));
  assert.deepEqual(parseShow(Object.entries(valid).map(([key, value]) => key + '=' + value).join('\n')), valid);
});

test('SMALL/FULL composition keeps frozen assembly and workload flags, bootstrap uninstrumented, PG hook server-only', () => {
  const r = release(), small = diagnosticPlan(r, 31000), full = diagnosticPlan({ ...r, workload: 'FULL' }, 31000);
  assert.equal(small.environment.PAPERCLIP_INGESTION_SMOKE, '1'); assert.equal(full.environment.PAPERCLIP_INGESTION_SMOKE, '0');
  assert.equal(small.environment.NODE_OPTIONS, '');
  const [bootstrap, server] = small.environment.PAPERCLIP_INGESTION_SERVER_COMMAND.split(' && ');
  assert.equal(bootstrap.includes('preload'), false); assert.ok(server.includes('counter-preload.mjs')); assert.ok(server.includes('pg-service-preload.mjs'));
  assert.ok(server.includes('native-ingestion-remote-server.mjs')); assert.ok(server.endsWith('--compiled-entry=server/dist/index.js'));
});

test('resource bounds retain five interior intervals and independent 10-percent uncertainty per numerator', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ atMs: i * 1000, value: i < 1 ? 0 : Math.min(600, (i - 1) * 100), cpu: i > 1 && i < 8 ? 100 : 1 }));
  const valid = scalarBounds(rows, 500, 7500, row => row.value);
  assert.equal(valid.eligible, true); assert.equal(valid.interiorIntervals, 6);
  assert.equal(scalarBounds(rows, 1500, 2500, row => row.value).eligible, false);
  const sparse = rows.map(row => ({ ...row, value: row.atMs >= 8000 ? 1 : 0 }));
  assert.equal(scalarBounds(sparse, 500, 7500, row => row.value).eligible, false);
});

test('Stop is excluded from CPU/SQL/TX ratios and every reported denominator is exact independently durable text count', () => {
  const values = ownerWindowReport({ cases: [{ stop: true }] }, []); assert.deepEqual(values, []);
  assert.throws(() => ownerWindowReport({ cases: [{ stop: false, runs: 1, events: 2, durable: [{ individualDeltas: 1 }] }] }, []));
});

test('default command performs no serving action and marks actual B2 source pins serving-unqualified', () => {
  const result = spawnSync(process.execPath, ['run-resource-diagnostic.mjs'], { cwd: here, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
  assert.equal(plan.sourceOnly, true); assert.equal(plan.B2Build.revision, CANDIDATE); assert.equal(plan.B2ServingQualified, false); assert.equal(plan.performanceAcceptanceEligible, false);
});

test('actual old wrapper pins and ordinary startup lack CF resource qualification; adapted pins and one startup hook pass', () => {
  const old = JSON.parse(read('test-fixtures/old-wrapper-pins.json'));
  const manifest = JSON.parse(gunzipSync(read('baseline-metadata/B0-artifact-inventory.json.gz')));
  assert.throws(() => assert.equal(old.variants.B0.revision, known.B0.revision), 'RED: actual old B0 provenance is not current CF');
  validatePins(pins, release(), manifest);
  const source = read('test-fixtures/modules/server-index-B1.js').toString();
  assert.equal(source.includes('prestartAtNormalBoundary'), false, 'RED: ordinary serving bytes have no dedicated scope startup callback');
  assert.ok(startupTransform(source, pins.variants.B1.serverIndex.sha256, 'file:///unit/pg-service.mjs').includes('prestartAtNormalBoundary'));
});

test('partial startup cleanup binds its fresh ledger, exact PG argv and current unit; receipt rejects PID reuse', () => {
  const r = release(), identity = { pid: 123, starttimeTicks: '55' }, value = unit(r);
  const ledger = { unit: unitName(r.nonce), unitAbsentBefore: true, sourceReleaseSha256: r.releaseSha256,
    dataDir: '/tmp/owned/db', selectedPort: 55432 };
  const argv = [r.pg.postgresBinary, '-D', ledger.dataDir, '-p', '55432'];
  validateCleanupUnit(r, ledger, value, identity, argv);
  const receipt = { sourceReleaseSha256: r.releaseSha256, nonce: r.nonce, pid: 123, starttimeTicks: '55', invocationId: value.InvocationID };
  validateCleanupUnit(r, ledger, value, identity, argv, receipt);
  for (const bad of [{ ...ledger, unitAbsentBefore: false }, { ...ledger, sourceReleaseSha256: 'b'.repeat(64) }])
    assert.throws(() => validateCleanupUnit(r, bad, value, identity, argv));
  assert.throws(() => validateCleanupUnit(r, ledger, value, { ...identity, starttimeTicks: '56' }, argv, receipt));
  assert.throws(() => validateCleanupUnit(r, ledger, value, identity, [...argv.slice(0, -1), '55433'], receipt));
  assert.throws(() => validateCleanupUnit(r, ledger, { ...value, InvocationID: 'b'.repeat(32) }, identity, argv, receipt));
});

test('future main-helper metadata and execution share exact independently reviewed approval guards', () => {
  const approval = { schema: 'native-ingestion-resource-main-helper-approval/v1', sourceClear: true, harnessRevision: MAIN.revision,
    helperSha256: 'b'.repeat(64), packetSha256: 'c'.repeat(64), independentReviewSha256: 'd'.repeat(64) };
  validateHelperApproval(approval, approval.helperSha256, approval.packetSha256);
  for (const [key, value] of [['sourceClear', false], ['schema', 'old'], ['harnessRevision', 'old'],
    ['independentReviewSha256', null], ['helperSha256', 'e'.repeat(64)], ['packetSha256', 'e'.repeat(64)]])
    assert.throws(() => validateHelperApproval({ ...approval, [key]: value }, approval.helperSha256, approval.packetSha256));
});

test('actual B2 appendEvents wrapper preserves one batch, receipt order, immediate invocation and exact failures', async () => {
  const original = read('test-fixtures/modules/port-B2.js').toString(), adapted = transform('port', original, 'B2');
  const suffix = adapted.slice(adapted.indexOf('// DIAGNOSTIC ONLY: public call elapsed'));
  const calls = [], receipts = [{ id: 'first' }, { id: 'second' }], failure = new Error('synthetic-persist-failure');
  let resolve, invoked = 0; const gate = new Promise(value => { resolve = value; });
  class FixturePort { async appendEvents(events) { invoked++; if (events[0] === 'fail') throw failure; await gate; return receipts; } }
  const symbol = Symbol.for('paperclip.native-ingestion.resource-counter'), previous = globalThis[symbol];
  globalThis[symbol] = { portAppend(method, size, work) { calls.push({ method, size }); return work(); } };
  try {
    new Function('PaperclipControlPlanePort', suffix)(FixturePort);
    const pending = new FixturePort().appendEvents(['a', 'b']); assert.equal(invoked, 1);
    resolve(); assert.equal(await pending, receipts); assert.deepEqual(calls[0], { method: 'appendEvents', size: 2 });
    await assert.rejects(new FixturePort().appendEvents(['fail']), error => error === failure);
    assert.equal(invoked, 2); assert.deepEqual(calls[1], { method: 'appendEvents', size: 1 });
  } finally { if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous; }
});
