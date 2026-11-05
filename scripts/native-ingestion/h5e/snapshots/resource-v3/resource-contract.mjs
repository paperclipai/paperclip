import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAIN = Object.freeze({ revision: '73ea8516739e81fa7f37cd67651b4a2c73674014',
  measurement: '7995ffdbf14b772e4c39444f6b89ba8684bcd86ef8ae866ffb0f5dbd89f35ccd',
  workload: '68863d27c95106852050a5eedf8b76ab47aa854c6bd9038afc0fbbfdc6500e2a',
  comparator: '3deceda0ef909829dfc3c2169d5d88ccb7c1ce9aa2881998e8ee07d23c1b56dc',
  lock: '54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8' });
export const HELPERS = Object.freeze({
  aee665daaf901aad535ba0678c00bebc0f7816f1cd155238007d9e7f85889a21: '18a991b486d40cf7c40519de0d98b232e7971c65ae94ba0b61bd28b971ff9949',
  '9d3123024694930139369df5811c823ce3d28d216d71d1a9dd0f5f887c3ed170': '013f84de7bfcacf989eba3932044eb1c3c52d2182efc843e65180cc71468297c',
});
export const BASELINES = Object.freeze({ B0: '7550ffa5d6447d2615bc89fc5313f4cbb958b615', B1: '2cf1454406cbd582a11f04476713eceb746eada5' });
export const CANDIDATE = '75b3578cfccf040b087a55a624e01baa2bca37f9';
export const MAX_MS = 1_800_000;
export const CONTROL_FILES = Object.freeze(['cpu.max', 'cpu.weight', 'cpuset.cpus.effective', 'memory.max', 'memory.high', 'io.max', 'io.weight', 'pids.max']);
export const PG_ANCHOR = 'const runningPid = getRunningPid();';
export function startupTransform(source, expectedHash, callbackUrl) {
  assert.equal(hash(source), expectedHash, 'Unqualified compiled PG startup owner');
  assert.equal(source.split(PG_ANCHOR).length - 1, 1, 'Expected one normal embedded reuse boundary');
  return source.replace(PG_ANCHOR,
    `await (await import(${JSON.stringify(callbackUrl)})).prestartAtNormalBoundary({ dataDir, configuredPort });\n    ${PG_ANCHOR}`);
}
export const shaFile = async file => hash(await readFile(file));
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const absolute = value => assert.ok(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value);
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);

export function validateRelease(value) {
  assert.equal(value.schema, 'native-ingestion-h5e-resource-release/v1');
  assert.equal(value.authorized, true); assert.equal(value.diagnosticOnly, true); assert.equal(value.performanceAcceptanceEligible, false);
  assert.ok(['SMALL', 'FULL'].includes(value.workload)); assert.ok(['B0', 'B1', 'B2'].includes(value.variant));
  assert.equal(value.maxDurationMs, MAX_MS); assert.match(value.nonce, /^[a-z0-9-]{8,64}$/);
  assert.equal(value.harnessRevision, MAIN.revision);
  assert.equal(value.build.revision, BASELINES[value.variant] ?? CANDIDATE);
  for (const key of ['output', 'harnessRoot', 'appRoot', 'nodeExecutable', 'pythonExecutable', 'sourcePacketFile',
    'counterPinsFile', 'mainHelperFile', 'mainHelperPacketFile']) absolute(value[key]);
  assert.equal(value.appRoot, value.build.appRoot);
  for (const key of ['sourcePacketSha256', 'counterPinsSha256', 'mainHelperSha256', 'mainHelperPacketSha256', 'pythonExecutableSha256']) digest(value[key]);
  if (HELPERS[value.mainHelperSha256]) assert.equal(HELPERS[value.mainHelperSha256], value.mainHelperPacketSha256);
  else { absolute(value.mainHelperApprovalFile); digest(value.mainHelperApprovalSha256); }
  assert.equal(value.pg.user, 'ubuntu'); assert.equal(value.pg.group, 'ubuntu');
  assert.ok(Number.isSafeInteger(value.pg.uid) && value.pg.uid > 0 && Number.isSafeInteger(value.pg.gid) && value.pg.gid > 0);
  for (const key of ['postgresBinary', 'initdbBinary', 'nativeEntry', 'detectPortEntry']) absolute(value.pg[key]);
  for (const key of ['postgresSha256', 'initdbSha256', 'nativeEntrySha256', 'detectPortSha256', 'parentControlsSha256']) digest(value.pg[key]);
  assert.ok(value.pg.expectedEffectiveControls && typeof value.pg.expectedEffectiveControls === 'object');
  assert.deepEqual(Object.keys(value.pg.expectedEffectiveControls).sort(), [...CONTROL_FILES].sort());
  assert.ok(Object.values(value.pg.expectedEffectiveControls).every(entry => entry === null || typeof entry === 'string'));
  assert.equal(value.pg.supervision, 'root-owned-systemd-exec-prestart-supported-reuse');
  return value;
}

export function validatePins(pins, release, manifest) {
  assert.equal(pins.schema, 'native-ingestion-resource-pins/h5e-v1');
  const current = pins.variants[release.variant]; assert.ok(current, 'Actual qualified variant pins required');
  assert.equal(current.revision, release.build.revision);
  assert.equal(manifest.variant, release.variant);
  assert.equal(manifest.revision, release.build.revision);
  assert.equal(manifest.compiledBuildRevision, release.build.revision);
  assert.equal(current.manifestSha256, release.build.manifestFileSha256);
  assert.equal(current.aggregateSha256, release.build.aggregateSha256);
  assert.equal(pins.harness.revision, MAIN.revision); assert.equal(pins.harness.measurementSha256, MAIN.measurement);
  assert.equal(pins.harness.workloadSha256, MAIN.workload); assert.equal(pins.harness.comparatorSha256, MAIN.comparator);
  assert.equal(pins.runtime.node, 'v26.4.0'); assert.equal(pins.runtime.playwright, '1.62.1');
  assert.equal(pins.runtime.nativeBinarySha256, release.build.binarySha256);
  assert.deepEqual(Object.keys(current.modules).sort(), ['port', 'queue', 'resolver', 'runlog']);
  for (const row of [...Object.values(current.modules), current.serverIndex])
    assert.deepEqual(manifest.files.find(file => file.path === row.path), row);
  return current;
}

export function validateHelperApproval(approval, helperSha256, packetSha256) {
  assert.equal(approval.schema, 'native-ingestion-resource-main-helper-approval/v1');
  assert.equal(approval.sourceClear, true); assert.equal(approval.harnessRevision, MAIN.revision);
  assert.equal(approval.helperSha256, helperSha256); assert.equal(approval.packetSha256, packetSha256);
  digest(approval.independentReviewSha256); return approval;
}

export async function loadRelease(file, expectedHash) {
  assert.equal(await shaFile(file), expectedHash); const release = validateRelease(await json(file));
  assert.equal(await shaFile(release.sourcePacketFile), release.sourcePacketSha256);
  const packet = await json(release.sourcePacketFile), root = path.dirname(release.sourcePacketFile);
  assert.equal(packet.schema, 'native-ingestion-h5e-resource-source/v1');
  assert.ok(Array.isArray(packet.sourceFiles) && packet.sourceFiles.length > 0);
  for (const row of packet.sourceFiles) {
    assert.ok(!path.isAbsolute(row.path) && !row.path.split('/').includes('..'));
    assert.equal(await shaFile(path.join(root, row.path)), row.sha256, `Diagnostic source changed: ${row.path}`);
  }
  assert.equal(await shaFile(release.counterPinsFile), release.counterPinsSha256);
  assert.equal(await shaFile(release.mainHelperFile), release.mainHelperSha256);
  assert.equal(await shaFile(release.mainHelperPacketFile), release.mainHelperPacketSha256);
  if (!HELPERS[release.mainHelperSha256]) {
    assert.equal(await shaFile(release.mainHelperApprovalFile), release.mainHelperApprovalSha256);
    validateHelperApproval(await json(release.mainHelperApprovalFile), release.mainHelperSha256, release.mainHelperPacketSha256);
  }
  const helper = await import(pathToFileURL(release.mainHelperFile).href);
  const qualified = await helper.validateVariantBuild(release.variant, release.build);
  const pins = await json(release.counterPinsFile); validatePins(pins, release, qualified.manifest);
  for (const [key, expected] of [['postgresBinary', 'postgresSha256'], ['initdbBinary', 'initdbSha256'],
    ['nativeEntry', 'nativeEntrySha256'], ['detectPortEntry', 'detectPortSha256']]) {
    assert.equal(await realpath(release.pg[key]), release.pg[key]); assert.equal(await shaFile(release.pg[key]), release.pg[expected]);
  }
  const dependency = await json(path.join(root, 'embedded-source-pins.json'));
  // nativeEntry points at @embedded-postgres/linux-x64 entry, not embedded-postgres.
  // The exact normal embedded-postgres JS paths are resolved and checked at the startup seam.
  assert.ok(dependency.files['dist/index.js'] && dependency.files['dist/binary.js']);
  assert.equal(await shaFile(release.pythonExecutable), release.pythonExecutableSha256);
  assert.equal(process.platform, 'linux'); assert.equal(process.version, 'v26.4.0');
  assert.equal(await realpath(process.execPath), await realpath(release.nodeExecutable));
  return { release, helper, pins, qualified, root, dependency };
}

export function scalarBounds(samples, start, end, read, interval = false) {
  const before = samples.filter(row => row.atMs < start).at(-1), after = samples.find(row => row.atMs > end);
  const inside = samples.filter(row => row.atMs >= start && row.atMs <= end);
  if (!before || !after || inside.length < 6) return { eligible: false, reason: 'missing brackets or five interior intervals' };
  const between = (left, right) => samples.filter(row => row.atMs > left.atMs && row.atMs <= right.atMs);
  const upper = interval ? between(before, after).reduce((sum, row) => sum + read(row), 0) : read(after) - read(before);
  const lower = interval ? between(inside[0], inside.at(-1)).reduce((sum, row) => sum + read(row), 0) : read(inside.at(-1)) - read(inside[0]);
  assert.ok(Number.isFinite(upper) && Number.isFinite(lower) && upper >= lower && lower >= 0);
  return { eligible: upper > 0 && (upper - lower) / upper <= .10, lower, upper,
    boundaryUncertainty: upper ? (upper - lower) / upper : null, interiorIntervals: inside.length - 1,
    bracket: [before.atMs, after.atMs], interior: [inside[0].atMs, inside.at(-1).atMs] };
}
