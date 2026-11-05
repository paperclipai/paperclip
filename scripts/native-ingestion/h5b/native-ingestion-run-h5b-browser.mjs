import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, access, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Prospective H5 application orchestrator. No launch without --execute and a
// byte-frozen root release. Original ce33 helper SHA is provenance only:
// 2244e238642caafd488a7c86fb463376c8459ee0f06f8054555407a174698fa1.
export const MODE = 'h5b-observe-original-sla-independent-agents';
export const PROTOCOL = 'v5b-independent-agents-complete-observation-original-sla';
export const WORKLOAD_SHA256 = '9d34b1511610cd5fcc73f8d734114e624105a3ee3b1e45c2b4d1cb721cad048c';
const H5_REVISION = '179fe6fa6da1b24ca08c1162301538d3e3788af6';
const OLD_NATIVE_TARGET = '/home/ubuntu/native-ingestion/aligned-baseline/packages/paperclip-runner/runner/target';
const H5_PROTOCOL_SHA256 = '452a5c8f0ad449b2db4ea3ca0bb6a6d19e8e6642eaac7b898caa55d1cedff40e';
const H5_COMPARATOR_SHA256 = '0c3ecc2e992a84a010e0132e8efb129f6b9c02e478c2f45028235fc67b5e6168';
const H5_INVENTORY_HELPER_SHA256 = '76b897dd6b7a90e784e228d78d79633a6d7011fe3ea01737f3bef9c6113298e9';
const H5_PROTOCOL_DOCUMENT_SHA256 = '60ae7052b9a58514d326109cdcf9f0c408d73acbff5d23be1fa92de1fcde8f54';
const INVENTORY_ROOTS = ['server/dist', 'ui/dist', 'packages/db/src', 'packages/shared/src'];
export const RESOURCE_WATCHDOG_MILLIS = 30 * 60_000;
export const STAGES = Object.freeze(['browser-aa-b0', 'browser-aa-b1', 'browser-b0-b1', 'browser-b1-b2', 'browser-b0-b2']);
export const FINALIZE_STAGE = 'browser-finalize-h4d';
const protocolFiles = ['native-event-ingestion.journey.ts', 'playwright-native-ingestion.config.ts', 'fixtures/in-feed-codex.mjs',
  'fixtures/native-ingestion-bin/codex', 'fixtures/composer-stop-codex-loader.mjs', 'fixtures/native-ingestion-bootstrap.mjs',
  'fixtures/native-ingestion-remote-server.mjs', 'fixtures/native-ingestion-protocol-qualification.mjs', 'fixtures/native-ingestion-h5.mjs'];
const BASELINES = Object.freeze({ B0: 'bac53ec3bfeaf6546e7aaeaee516487b30534654', B1: '07061a601cdc20603c8c7a46f9ddbad7ac5f5939' });
const OLD_B2 = 'ca7cba171cd5198ed569d75012edc858041cbc44';
const OLD_RECEIPT = 'a1259ba760f3cbbe44817e333f9f620bcf3769fb0a6c16f9ce2f0f5b2ed60d94';
const OLD_SUMMARY = 'd3766fc4206d569d10fd02224433f1e9a2caa6992a7c62216e80af368aa4e44d';
const OLD_BINARY = 'abb65bdc073991e428bd37f9809603ee7564543cca0ed0305dc231137c93070f';
const OLD_RUST = 'bbe29bba574ce8d5cfddf2f7461ae0eb5983df07';
const OLD_INVENTORIES = Object.freeze({
  B0: { manifestFileSha256: 'a1c797a75dd3174f414fc5529acf56783e1a3dfe7b22f1e460a87b60f6bff01d', aggregateSha256: 'a50720be2ce53f9222187d63609c5936f94b6a00c60df2ca112261abd1bf921e' },
  B1: { manifestFileSha256: 'df48e5c511a2f31e31180e05f18e2322ca4f384ea06f6f96a57de24d39849ef8', aggregateSha256: 'bca5b6fad62e70631c135a9ff377efeb587aba17ef0842c8fd82804ed99a81ab' },
});
const LOCK_SHA256 = '54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8';
const GATES_SHA256 = 'ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc';
const selfFile = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const getJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value, fresh = false) => writeFile(file, JSON.stringify(value, null, 2) + '\n', fresh ? { flag: 'wx' } : undefined);
const digest = (value, name) => assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `Missing exact ${name} SHA-256`);
const revision = (value, name) => assert.ok(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), `Missing immutable full ${name} revision`);
const absolute = (value, name) => assert.ok(typeof value === 'string' && path.isAbsolute(value), `Missing absolute ${name} path`);
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

export function stagePlan(stage) {
  assert.ok(STAGES.includes(stage) || stage === FINALIZE_STAGE, 'Select one registered H5 stage');
  if (stage === FINALIZE_STAGE) return { stage, requiredVariants: ['B0', 'B1', 'B2'], priorStages: [...STAGES], fullArms: 0, finalizationOnly: true };
  const [baseline, candidate] = stage === STAGES[0] ? ['B0', 'B0'] : stage === STAGES[1] ? ['B1', 'B1']
    : stage === STAGES[2] ? ['B0', 'B1'] : stage === STAGES[3] ? ['B1', 'B2'] : ['B0', 'B2'];
  const aa = baseline === candidate;
  return { stage, baseline, candidate, aa, expectation: stage === STAGES[2] ? 'nonregression' : 'improvement',
    candidatePolicy: aa ? null : stage === STAGES[2] ? 'cursor-nonregression' : 'final-b2',
    requiredVariants: [...new Set([baseline, candidate])], priorStages: STAGES.slice(0, STAGES.indexOf(stage)),
    pairs: 5, fullArms: 10, noiseStage: aa ? null : `browser-aa-${baseline.toLowerCase()}` };
}

async function hashedJson(file, expected, name, compressed = false) {
  absolute(file, name); digest(expected, name);
  const bytes = await readFile(file); assert.equal(hash(bytes), expected, `${name} bytes changed`);
  return { bytes, value: JSON.parse((compressed ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }) : bytes).toString('utf8')) };
}

export async function validateVariantBuild(variant, descriptor) {
  assert.ok(descriptor && typeof descriptor === 'object', `Required ${variant} qualified build is missing`);
  absolute(descriptor.appRoot, `${variant} appRoot`); revision(descriptor.revision, variant);
  digest(descriptor.binarySha256, `${variant} binary`); revision(descriptor.rustSourceTree, `${variant} Rust source tree`);
  const receipt = (await hashedJson(descriptor.qualifiedReceiptFile, descriptor.qualifiedReceiptSha256, `${variant} qualified receipt`)).value;
  const summary = (await hashedJson(descriptor.inventorySummaryFile, descriptor.inventorySummarySha256, `${variant} inventory summary`)).value;
  const manifest = (await hashedJson(descriptor.manifestFile, descriptor.manifestFileSha256, `${variant} inventory manifest`, true)).value;
  digest(descriptor.aggregateSha256, `${variant} aggregate inventory`);
  const rows = receipt.results?.filter(row => row.variant === variant);
  assert.equal(rows?.length, 1, `${variant} qualified receipt must select this variant exactly once`);
  assert.equal(rows[0].revision, descriptor.revision, `${variant} qualified receipt revision mismatch`);
  assert.equal(rows[0].compiledBuildRevision, descriptor.revision, `${variant} qualified compiled revision mismatch`);
  assert.equal(rows[0].sourceClean, true, `${variant} qualified source was not clean`);
  const native = receipt.nativeStageHashes?.filter(row => row.variant === variant);
  assert.equal(native?.length, 1, `${variant} qualified native stage is missing`);
  assert.equal(native[0].binarySha256, descriptor.binarySha256, `${variant} native stage binary mismatch`);
  assert.equal(receipt.binarySha256, descriptor.binarySha256, `${variant} receipt binary mismatch`);
  assert.equal(receipt.rustSourceTree, descriptor.rustSourceTree, `${variant} Rust source identity mismatch`);
  assert.equal(receipt.rustInputObjects?.runner, descriptor.rustSourceTree, `${variant} qualified Rust input objects are missing`);
  absolute(native[0].targetRealPath, `${variant} qualified native target`);
  for (const [file, object] of Object.entries(receipt.rustInputObjects)) {
    assert.ok(file && !path.posix.isAbsolute(file) && path.posix.normalize(file) === file && !file.includes('\\') && !file.split('/').includes('..'), 'Qualified Rust input path is invalid');
    revision(object, `${variant} Rust input ${file}`);
  }
  assert.equal(receipt.artifactInventorySummary, descriptor.qualifiedInventorySummaryReference ?? descriptor.inventorySummaryFile, `${variant} receipt points to another inventory summary`);
  assert.equal(manifest.variant, variant); assert.equal(manifest.revision, descriptor.revision);
  assert.equal(manifest.compiledBuildRevision, descriptor.revision); assert.equal(manifest.aggregateSha256, descriptor.aggregateSha256);
  assert.deepEqual(manifest.roots, INVENTORY_ROOTS);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === manifest.fileCount && manifest.fileCount > 0);
  const row = summary.inventories?.[variant]; assert.ok(row, `${variant} inventory summary entry missing`);
  assert.equal(row.manifest, path.basename(descriptor.manifestFile)); assert.equal(row.manifestSha256, descriptor.manifestFileSha256);
  assert.equal(row.aggregateSha256, descriptor.aggregateSha256); assert.equal(row.fileCount, manifest.fileCount);
  if (Object.hasOwn(BASELINES, variant)) {
    assert.equal(descriptor.revision, BASELINES[variant], 'Original baseline reference must remain unchanged');
    assert.equal(descriptor.qualifiedReceiptSha256, OLD_RECEIPT, 'B0/B1 must use the original, unmodified aligned4a83 qualified receipt');
    assert.equal(descriptor.inventorySummarySha256, OLD_SUMMARY); assert.equal(descriptor.binarySha256, OLD_BINARY);
    assert.equal(descriptor.rustSourceTree, OLD_RUST);
    for (const [key, value] of Object.entries(OLD_INVENTORIES[variant])) assert.equal(descriptor[key], value, `Original ${variant} inventory changed`);
  } else {
    assert.equal(variant, 'B2');
    assert.ok(![...Object.values(BASELINES), OLD_B2].includes(descriptor.revision), 'Final B2 needs its new actual immutable product revision');
    assert.notEqual(descriptor.qualifiedReceiptSha256, OLD_RECEIPT, 'Final B2 needs its own new qualified receipt');
    assert.notEqual(descriptor.binarySha256, OLD_BINARY, 'Final Rust B2 needs its newly qualified binary');
    assert.notEqual(descriptor.rustSourceTree, OLD_RUST, 'Final Rust B2 needs its newly qualified Rust inputs');
    assert.notEqual(native[0].targetRealPath, OLD_NATIVE_TARGET, 'Final Rust B2 must not reuse the original B0/B1 target');
  }
  return { receipt, summary, manifest };
}

// Match the existing inventory generator and H5 helper exactly: Unicode code
// point order, Python ensure_ascii JSON with sorted bytes/path/sha256 keys.
function pythonOrder(left, right) {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}
const pythonRow = row => JSON.stringify({ bytes: row.bytes, path: row.path, sha256: row.sha256 })
  .replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
function inventoryPath(value) {
  assert.ok(typeof value === 'string' && value.length && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..')
    && INVENTORY_ROOTS.some(root => value.startsWith(`${root}/`)), 'Inventory filename escapes registered roots');
  return value;
}
export async function validateActualInventory(build, manifest) {
  const startedAtMs = Date.now(), started = performance.now(), canonicalRoot = await realpath(build.appRoot);
  assert.deepEqual(manifest.roots, INVENTORY_ROOTS);
  const expected = new Map(), canonicalFiles = new Set();
  for (const row of manifest.files) {
    const name = inventoryPath(row.path);
    assert.equal(expected.has(name), false, 'Duplicate inventory filename'); expected.set(name, row);
    digest(row.sha256, 'inventory file'); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
  }
  assert.equal(expected.size, manifest.fileCount, 'Inventory file count is incomplete');
  const actualNames = [], canonicalDirectories = new Set();
  const walk = async relative => {
    const directory = path.join(build.appRoot, relative), canonical = await realpath(directory);
    assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Inventory directory resolves outside APP_ROOT');
    assert.equal(canonicalDirectories.has(canonical), false, 'Inventory directory aliases another registered directory'); canonicalDirectories.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else {
        const file = path.join(build.appRoot, child), metadata = await lstat(file);
        if (metadata.isSymbolicLink()) assert.equal((await stat(file)).isDirectory(), false, 'Inventory directory symlink is not a frozen file');
        assert.ok(metadata.isFile() || metadata.isSymbolicLink(), 'Inventory includes a nonregular entry');
        inventoryPath(child); actualNames.push(child);
      }
    }
  };
  for (const root of INVENTORY_ROOTS) await walk(root);
  actualNames.sort(pythonOrder);
  assert.deepEqual(actualNames, [...expected.keys()].sort(pythonOrder), 'Actual APP_ROOT file set differs from frozen inventory');
  const actualRows = new Array(actualNames.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, actualNames.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= actualNames.length) return;
      const name = actualNames[index], file = path.join(build.appRoot, name), canonical = await realpath(file);
      assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Inventory file resolves outside APP_ROOT');
      assert.equal(canonicalFiles.has(canonical), false, 'Inventory filenames alias the same canonical file'); canonicalFiles.add(canonical);
      const before = await stat(file); assert.ok(before.isFile(), 'Inventory evidence must be a regular file');
      const content = createHash('sha256'); for await (const bytes of createReadStream(file)) content.update(bytes);
      const after = await stat(file);
      assert.equal(after.size, before.size, 'Artifact changed during inventory hashing'); assert.equal(after.mtimeMs, before.mtimeMs, 'Artifact changed during inventory hashing');
      const row = { bytes: after.size, path: name, sha256: content.digest('hex') }, frozen = expected.get(name);
      assert.equal(row.bytes, frozen.bytes, `Actual artifact size changed: ${name}`); assert.equal(row.sha256, frozen.sha256, `Actual artifact bytes changed: ${name}`);
      actualRows[index] = row;
    }
  }));
  const aggregateSha256 = hash(Buffer.from(`${actualRows.map(pythonRow).join('\n')}\n`, 'utf8'));
  assert.equal(aggregateSha256, manifest.aggregateSha256, 'Actual APP_ROOT aggregate differs from frozen inventory');
  assert.equal(aggregateSha256, build.aggregateSha256, 'Actual APP_ROOT aggregate differs from qualified build');
  return { appRoot: build.appRoot, canonicalAppRoot: canonicalRoot, fileCount: actualRows.length, aggregateSha256,
    startedAtMs, completedAtMs: Date.now(), elapsedMs: performance.now() - started,
    scope: 'Live registered file set, canonical containment/uniqueness, size and SHA checked before this arm; not an assertion of future immutability' };
}

function harnessFields(release) {
  return Object.fromEntries(['harnessRevision', 'protocolSha256', 'comparatorSha256', 'inventoryHelperSha256', 'protocolDocumentSha256', 'lockSha256', 'gatesSha256', 'workloadSha256', 'observationMode', 'protocolVersion'].map(key => [key, release[key]]));
}

export async function loadRelease(releaseFile, stage, outputRoot) {
  absolute(releaseFile, 'root release'); absolute(outputRoot, 'output root');
  const releaseBytes = await readFile(releaseFile), release = JSON.parse(releaseBytes);
  const plan = stagePlan(stage);
  assert.equal(release.authorized, true, 'Root release is not authorized'); assert.equal(release.stage, stage);
  assert.equal(release.outputRoot, outputRoot, 'Root release freezes a different exact output path');
  assert.equal(release.orchestratorSha256, hash(await readFile(selfFile)), 'Orchestrator changed after release');
  absolute(release.harnessRoot, 'H5 harness'); revision(release.harnessRevision, 'H5 harness');
  assert.equal(release.harnessRevision, H5_REVISION, 'Use the actual independently frozen H5 full revision');
  assert.equal(release.observationMode, MODE); assert.equal(release.protocolVersion, PROTOCOL);
  assert.equal(release.workloadSha256, WORKLOAD_SHA256);
  assert.equal(release.resourceWatchdogMillis, RESOURCE_WATCHDOG_MILLIS, 'Resource watchdog registration changed; this is not an SLA');
  assert.equal(release.lockSha256, LOCK_SHA256); assert.equal(release.gatesSha256, GATES_SHA256);
  for (const [key, expected] of [['protocolSha256', H5_PROTOCOL_SHA256], ['comparatorSha256', H5_COMPARATOR_SHA256], ['inventoryHelperSha256', H5_INVENTORY_HELPER_SHA256], ['protocolDocumentSha256', H5_PROTOCOL_DOCUMENT_SHA256]])
    assert.equal(release[key], expected, `Reviewed H5 source pin changed: ${key}`);
  for (const variant of plan.requiredVariants) await validateVariantBuild(variant, release.perVariantBuilds?.[variant]);
  const context = { releaseFile, releaseBytesSha256: hash(releaseBytes), release, plan, out: outputRoot, commands: [], commandIndex: 0 };
  await checkPriorStages(context);
  if (plan.noiseStage) await checkNoise(context);
  if (plan.finalizationOnly) await checkFinalizationInputs(context);
  return context;
}

async function checkReleaseBytes(context) {
  assert.equal(hash(await readFile(context.releaseFile)), context.releaseBytesSha256, 'Exact root release bytes changed');
  assert.equal(hash(await readFile(selfFile)), context.release.orchestratorSha256, 'Orchestrator changed after release');
  if (context.rootReleaseCopy) assert.equal(hash(await readFile(context.rootReleaseCopy)), context.releaseBytesSha256, 'Preserved root release bytes changed');
}

function checkComparisonIdentity(report, context) {
  assert.equal(report.complete, true); assert.equal(report.observationMode, MODE); assert.equal(report.protocolVersion, PROTOCOL);
  assert.equal(report.workloadSha256, WORKLOAD_SHA256); assert.equal(report.measurementSha256, context.release.protocolSha256);
  assert.equal(report.comparatorSha256, context.release.comparatorSha256); assert.equal(report.gatesSha256, GATES_SHA256);
  assert.equal(report.pairCount, 5);
}

async function checkPriorStages(context) {
  for (const stage of context.plan.priorStages) {
    const pin = context.release.priorStageReports?.[stage]; assert.ok(pin, `Stage order requires frozen ${stage} first`);
    assert.equal(pin.file, path.join(context.out, `${stage}.json`), 'Prior stage report path changed');
    const report = (await hashedJson(pin.file, pin.sha256, stage)).value;
    checkComparisonIdentity(report, context);
    const priorPlan = stagePlan(stage);
    assert.equal(report.phase, priorPlan.aa ? 'aa' : 'compare');
    assert.equal(report.baselineRevision, BASELINES[priorPlan.baseline]);
    const candidateRevision = BASELINES[priorPlan.candidate] ?? context.release.perVariantBuilds.B2?.revision;
    assert.equal(report.candidateRevision, candidateRevision, 'Prior stage used a different measured candidate revision');
    for (const [arm, variant] of [['baseline', priorPlan.baseline], ['candidate', priorPlan.candidate]]) {
      const expected = context.release.perVariantBuilds?.[variant] ?? (BASELINES[variant] ? { ...OLD_INVENTORIES[variant], qualifiedReceiptSha256: OLD_RECEIPT, inventorySummarySha256: OLD_SUMMARY } : undefined);
      assert.ok(expected, 'Prior candidate qualified build is unavailable');
      for (const key of ['manifestFileSha256', 'aggregateSha256', 'qualifiedReceiptSha256', 'inventorySummarySha256'])
        assert.equal(report.artifactInventories?.[arm]?.[key], expected[key], 'Prior stage changed a measured qualified inventory');
    }
    if (!priorPlan.aa) assert.equal(report.performancePassed, true, `Prior ${stage} performance failed`);
  }
}

export async function checkNoise(context) {
  const { release, plan, out } = context;
  const expected = path.join(out, `${plan.noiseStage}.json`);
  assert.equal(release.noiseReportFile, expected, 'Use the same exact frozen A/A noise path');
  const noise = (await hashedJson(expected, release.noiseReportSha256, 'Reviewed A/A noise report')).value;
  checkComparisonIdentity(noise, context); assert.equal(noise.phase, 'aa');
  assert.equal(noise.baselineRevision, release.perVariantBuilds[plan.baseline].revision);
  assert.equal(noise.candidateRevision, noise.baselineRevision);
  assert.equal(noise.h5Assessments?.length, 5, 'Reviewed A/A must contain all five complete assessments');
  assert.ok(noise.measurements?.length > 0 && noise.measurements.every(row => Number.isFinite(row.aaNoiseEnvelopeRelative) && row.aaNoiseEnvelopeRelative >= 0), 'A/A noise envelope is invalid');
  const build = release.perVariantBuilds[plan.baseline];
  for (const arm of ['baseline', 'candidate']) for (const key of ['manifestFileSha256', 'aggregateSha256', 'qualifiedReceiptSha256', 'inventorySummarySha256'])
    assert.equal(noise.artifactInventories?.[arm]?.[key], build[key], 'Frozen A/A baseline inventory differs from required build');
  return noise;
}

const QUIET_SETTLE_MILLIS = 30_000, QUIET_POLL_MILLIS = 1_000, QUIET_PS_TIMEOUT_MILLIS = 2_000;
const QUIET_SCHEMA = 'paperclip.native-ingestion.physical-quiet.v1';
const QUIET_SCOPE = 'Dedicated Linux process-name guard for specified Node/PostgreSQL/Runner/browser/Rust-build names only; not a claim that every possible host activity is absent. Qualified H5 Stop proof separately covers provider/sleep control groups.';
const QUIET_ZOMBIE_POLICY = 'Strict: matched zombie/dead rows remain blockers until absent; no automatic killing or silent zombie exclusion.';
function processFamily(comm) {
  if (/^(node|node-MainThread)$/.test(comm)) return 'node';
  if (/^(postgres|postmaster|pg_ctl|initdb)$/.test(comm)) return 'postgresql';
  if (/^(paperclip-runne|paperclip-runner.*|Runner)$/.test(comm)) return 'runner';
  if (/^(chrome|headless|chromium)/i.test(comm)) return 'browser';
  if (/^(rustc|cargo)$/.test(comm)) return 'rust-build';
  return null;
}
export function classifyLinuxProcesses(text, orchestratorPid = process.pid) {
  assert.ok(typeof text === 'string' && text.trim(), 'Linux ps returned no process rows');
  assert.ok(Number.isSafeInteger(orchestratorPid) && orchestratorPid > 0, 'Invalid orchestrator PID');
  const seen = new Set(), matched = []; let rowCount = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s+([DIRSTtWXZPK])\s*$/);
    assert.ok(fields, 'Malformed Linux ps PID/PPID/comm/state row');
    const row = { pid: Number(fields[1]), ppid: Number(fields[2]), comm: fields[3].trim(), state: fields[4] };
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && row.comm.length > 0 && row.comm.length <= 256 && !row.comm.includes('\0'), 'Malformed Linux ps process fields');
    assert.equal(seen.has(row.pid), false, 'Duplicate Linux ps PID'); seen.add(row.pid); rowCount++;
    const family = processFamily(row.comm);
    if (family) matched.push({ ...row, family, allowed: row.pid === orchestratorPid && !['Z', 'X'].includes(row.state) });
  }
  assert.ok(seen.has(orchestratorPid), 'Linux ps omitted the current orchestrator PID');
  return { rowCount, matched, blockers: matched.filter(row => !row.allowed) };
}
function linuxProcessRows(timeoutMillis) {
  return execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,comm=,state='], {
    encoding: 'utf8', timeout: timeoutMillis, maxBuffer: 2 * 1024 * 1024, env: { LC_ALL: 'C' },
  });
}
export async function physicalQuietGuard({ receiptFile, phase, armStage, primaryFailureAlreadyPresent = false,
  platform = process.platform, orchestratorPid = process.pid, readPs = linuxProcessRows,
  now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  absolute(receiptFile, 'physical quiet receipt');
  const started = now(), receipt = { schema: QUIET_SCHEMA, scope: QUIET_SCOPE, phase, armStage, platform, orchestratorPid,
    fields: ['pid', 'ppid', 'comm', 'state'], zombiePolicy: QUIET_ZOMBIE_POLICY,
    resourceSettleLimitMillis: QUIET_SETTLE_MILLIS, pollIntervalMillis: QUIET_POLL_MILLIS, psTimeoutMillis: QUIET_PS_TIMEOUT_MILLIS,
    primaryFailureAlreadyPresent, startedAtMs: Date.now(), passed: false, observations: [] };
  let failure;
  try {
    assert.equal(platform, 'linux', 'Accepted H5 physical quiet guard requires Linux');
    assert.ok(['pre-arm', 'post-arm'].includes(phase), 'Unknown physical quiet phase');
    for (;;) {
      const remaining = QUIET_SETTLE_MILLIS - (now() - started);
      assert.ok(remaining > 0, 'Physical quiet settle deadline expired; stop for cleanup');
      const observed = classifyLinuxProcesses(readPs(Math.max(1, Math.min(QUIET_PS_TIMEOUT_MILLIS, Math.floor(remaining)))), orchestratorPid);
      receipt.observations.push({ atMs: Date.now(), elapsedMillis: now() - started, ...observed });
      assert.ok(now() - started < QUIET_SETTLE_MILLIS, 'Physical quiet settle deadline expired; stop for cleanup');
      if (observed.blockers.length === 0) { receipt.passed = true; break; }
      const wait = Math.min(QUIET_POLL_MILLIS, QUIET_SETTLE_MILLIS - (now() - started));
      assert.ok(wait > 0, 'Physical quiet settle deadline expired; stop for cleanup');
      await pause(wait);
    }
  } catch (error) {
    failure = error;
    receipt.failure = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) };
  }
  receipt.completedAtMs = Date.now(); receipt.elapsedMillis = now() - started;
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(receiptFile, bytes, { flag: 'wx' });
  const result = { file: receiptFile, bytes: bytes.length, sha256: hash(bytes), passed: receipt.passed };
  if (failure) {
    const error = new Error(`Physical quiet guard failed (${phase}); receipt=${receiptFile}; sha256=${result.sha256}`, { cause: failure });
    Object.assign(error, { receiptFile, receiptSha256: result.sha256 }); throw error;
  }
  return result;
}
export async function assertNoPreferredUiShadow(appRoot, statPath = lstat) {
  const preferredIndex = path.join(appRoot, 'server/ui-dist/index.html'), preferredDirectory = path.dirname(preferredIndex);
  try { await statPath(preferredIndex); assert.fail('Preferred server/ui-dist/index.html exists (including a symlink); ui/dist inventory cannot attest the selected UI'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { assert.equal((await statPath(preferredDirectory)).isSymbolicLink(), false, 'Preferred server/ui-dist directory symlink prevents the absence guard'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { checkedAtMs: Date.now(), preferredIndex, preferredIndexAbsent: true, preferredDirectorySymlink: false,
    selectedUiRoot: path.join(appRoot, 'ui/dist'),
    assumption: 'Preferred server/ui-dist index absent at preflight; inventoried ui/dist is the compiled fallback. No routing/build changes or future immutability claim.' };
}

async function checkFrozen(context, selectedVariant) {
  await checkReleaseBytes(context);
  for (const key of ['DATABASE_URL', 'PAPERCLIP_RUNNER_STATE_DIR', 'PAPERCLIP_INGESTION_SERVER_COMMAND', 'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR',
    'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS', 'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR', 'PAPERCLIP_INGESTION_BROWSER_CAPTURE', 'NODE_OPTIONS'])
    assert.ok(!process.env[key], `Acceptance rejects ambient ${key}`);
  const { release, plan } = context, actualInventories = {};
  for (const variant of plan.requiredVariants) {
    const build = release.perVariantBuilds[variant], qualified = await validateVariantBuild(variant, build);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: build.appRoot, encoding: 'utf8' }).trim(), build.revision, `${variant} SUT revision changed`);
    assert.equal(execFileSync('git', ['status', '--short'], { cwd: build.appRoot, encoding: 'utf8' }).trim(), '', `${variant} SUT is dirty`);
    assert.equal((await getJson(path.join(build.appRoot, 'server/dist/build-info.json'))).commit, build.revision);
    const binaryFile = path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd');
    const native = qualified.receipt.nativeStageHashes.find(row => row.variant === variant);
    const actualTarget = await realpath(path.join(build.appRoot, 'packages/paperclip-runner/runner/target'));
    assert.equal(actualTarget, native.targetRealPath, `${variant} actual native target differs from qualified receipt`);
    assert.equal(await realpath(binaryFile), path.join(actualTarget, 'release/paperclip-runnerd'), `${variant} native binary resolves outside its exact qualified target`);
    assert.equal(hash(await readFile(binaryFile)), build.binarySha256, `${variant} actual native binary changed`);
    for (const [file, object] of Object.entries(qualified.receipt.rustInputObjects))
      assert.equal(execFileSync('git', ['rev-parse', `${build.revision}:packages/paperclip-runner/${file}`], { cwd: build.appRoot, encoding: 'utf8' }).trim(), object, `${variant} qualified Rust input changed: ${file}`);
    assert.equal(execFileSync('git', ['rev-parse', `${build.revision}:packages/paperclip-runner/runner`], { cwd: build.appRoot, encoding: 'utf8' }).trim(), build.rustSourceTree);
    if (!selectedVariant || selectedVariant === variant) actualInventories[variant] = {
      ...await validateActualInventory(build, qualified.manifest), uiServing: await assertNoPreferredUiShadow(build.appRoot),
    };
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: release.harnessRoot, encoding: 'utf8' }).trim(), release.harnessRevision);
  assert.equal(execFileSync('git', ['status', '--short'], { cwd: release.harnessRoot, encoding: 'utf8' }).trim(), '');
  assert.equal(hash(Buffer.concat(await Promise.all(protocolFiles.map(file => readFile(path.join(release.harnessRoot, 'tests/e2e', file)))))), release.protocolSha256);
  for (const [file, expected] of [['scripts/compare-native-ingestion-browser.ts', release.comparatorSha256], ['scripts/native-ingestion-h5-inventory.mjs', release.inventoryHelperSha256], ['tests/e2e/fixtures/native-ingestion-h5.md', release.protocolDocumentSha256], ['scripts/native-ingestion-performance-gates.mjs', release.gatesSha256], ['pnpm-lock.yaml', release.lockSha256]])
    assert.equal(hash(await readFile(path.join(release.harnessRoot, file))), expected, `Frozen H5 support changed: ${file}`);
  await checkPriorStages(context);
  if (plan.noiseStage) await checkNoise(context);
  return { checkedAtMs: Date.now(), releaseFileSha256: context.releaseBytesSha256, actualInventories };
}

async function execute(context, step) {
  const index = ++context.commandIndex, startedAt = new Date().toISOString(), log = path.join(context.out, `${step.stage}.log`);
  const command = { index, stage: step.stage, cwd: step.cwd, executable: process.execPath, args: step.args, environmentOverrides: step.env ?? {}, startedAt, log,
    resourceWatchdogMillis: RESOURCE_WATCHDOG_MILLIS, resourceWatchdogScope: 'Resource-only cap including startup/test/teardown; original SLA and H5 observation limits remain driver-owned' };
  context.commands.push(command);
  const save = () => saveJson(path.join(context.out, `${context.plan.stage}-commands.json`), context.commands);
  await save(); console.log(`START ${step.stage} ${startedAt}; log=${log}`);
  const stream = (await open(log, 'wx')).createWriteStream();
  const child = spawn(process.execPath, step.args, { cwd: step.cwd, env: { ...process.env, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  command.childPid = child.pid; await save();
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let forcedStop;
  const watchdog = setTimeout(() => {
    command.watchdogExpired = true; child.kill('SIGTERM');
    forcedStop = setTimeout(() => { command.forcedDriverKill = true; child.kill('SIGKILL'); }, 30_000);
  }, RESOURCE_WATCHDOG_MILLIS);
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  let exit;
  try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(watchdog); clearTimeout(forcedStop); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); await new Promise(resolve => stream.end(resolve)); }
  Object.assign(command, { finishedAt: new Date().toISOString(), ...exit }); await save();
  console.log(`END ${step.stage} code=${exit.code} signal=${exit.signal ?? 'none'}`);
  assert.equal(command.watchdogExpired, undefined, 'Resource watchdog expired; stop for physical cleanup, never accept or advance');
  assert.equal(exit.code, 0, `Stage ${step.stage} failed; retain raw files and perform physical cleanup before continuing`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function assertPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
async function extractEvidence(directory) {
  const playwrightFile = path.join(directory, 'playwright.json'), report = await getJson(playwrightFile), attachments = [];
  const visit = node => { if (Array.isArray(node)) for (const child of node) visit(child); else if (node && typeof node === 'object') {
    if (Array.isArray(node.attachments)) attachments.push(...node.attachments.filter(value => value.name === 'native-ingestion-evidence'));
    for (const [key, child] of Object.entries(node)) if (key !== 'attachments') visit(child);
  } };
  visit(report); assert.equal(attachments.length, 1, 'Exactly one native-ingestion evidence attachment is required');
  const attachment = attachments[0];
  const evidence = attachment.body ? JSON.parse(Buffer.from(attachment.body, 'base64').toString()) : await getJson(path.resolve(directory, attachment.path));
  const file = path.join(directory, 'native-ingestion-evidence.json'); await saveJson(file, evidence, true);
  return { file, evidence, playwrightFile };
}

async function armSidecar(directory, variant, build) {
  const destination = path.join(directory, 'inventory'); await mkdir(destination);
  const copies = {};
  for (const [key, sha] of [['manifestFile', 'manifestFileSha256'], ['inventorySummaryFile', 'inventorySummarySha256'], ['qualifiedReceiptFile', 'qualifiedReceiptSha256']]) {
    const bytes = await readFile(build[key]); assert.equal(hash(bytes), build[sha], 'Per-arm provenance changed while copying');
    const file = path.join(destination, path.basename(build[key])); await writeFile(file, bytes, { flag: 'wx' }); copies[key] = path.relative(directory, file);
  }
  const sidecar = { schema: 'paperclip.native-ingestion.arm-inventory.v1', variant, sourceRevision: build.revision, compiledBuildRevision: build.revision,
    playwrightReportSha256: hash(await readFile(path.join(directory, 'playwright.json'))), ...copies,
    manifestFileSha256: build.manifestFileSha256, aggregateSha256: build.aggregateSha256,
    qualifiedReceiptSha256: build.qualifiedReceiptSha256, inventorySummarySha256: build.inventorySummarySha256 };
  const file = path.join(directory, 'arm-inventory.json'); await saveJson(file, sidecar, true); return file;
}

async function armArtifactFiles(result) {
  const sidecar = await getJson(result.inventoryFile), base = path.dirname(result.inventoryFile);
  return [result.file, result.playwrightFile, result.inventoryFile,
    ...['manifestFile', 'inventorySummaryFile', 'qualifiedReceiptFile'].map(key => path.resolve(base, sidecar[key])),
    path.join(base, 'pre-arm-inventory-check.json'), path.join(base, 'physical-http-port-check.json'),
    path.join(base, 'physical-quiet-pre.json'), path.join(base, 'physical-quiet-post.json')];
}
export async function sealArmArtifacts(out, result) {
  const canonicalRoot = await realpath(out), files = await armArtifactFiles(result), seen = new Set(), seals = [];
  for (const file of files) {
    absolute(file, 'raw arm artifact'); const canonical = await realpath(file);
    assert.ok(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'Raw arm artifact resolves outside owned output');
    assert.equal(seen.has(canonical), false, 'Duplicate raw arm artifact'); seen.add(canonical);
    const bytes = await readFile(file); seals.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return seals;
}
export async function verifyRawArtifactSeals(out, manifest) {
  const canonicalRoot = await realpath(out);
  for (const entry of manifest) for (const arm of ['baseline', 'candidate']) {
    const seals = entry[`${arm}Artifacts`]; assert.ok(Array.isArray(seals) && seals.length === 10, 'Raw arm byte seals are incomplete');
    const seen = new Set();
    for (const seal of seals) {
      absolute(seal.file, 'sealed arm artifact'); digest(seal.sha256, 'sealed arm artifact');
      assert.equal(seen.has(seal.file), false, 'Duplicate sealed arm artifact'); seen.add(seal.file);
      assert.ok((await realpath(seal.file)).startsWith(`${canonicalRoot}${path.sep}`), 'Sealed arm artifact resolves outside output');
      const bytes = await readFile(seal.file);
      assert.equal(bytes.length, seal.bytes, 'Raw arm artifact size changed after timing');
      assert.equal(hash(bytes), seal.sha256, 'Raw arm artifact bytes changed after timing');
    }
    const expected = await armArtifactFiles({ file: entry[`${arm}File`], playwrightFile: entry[`${arm}PlaywrightFile`], inventoryFile: entry[`${arm}InventoryFile`] });
    assert.deepEqual([...seen].sort(), expected.sort(), 'Raw seals do not cover this exact evidence/PW/sidecar/inventory set');
    for (const [filename, phase] of [['physical-quiet-pre.json', 'pre-arm'], ['physical-quiet-post.json', 'post-arm']]) {
      const receipt = await getJson(path.join(path.dirname(entry[`${arm}InventoryFile`]), filename));
      assert.equal(receipt.schema, QUIET_SCHEMA); assert.equal(receipt.passed, true); assert.equal(receipt.platform, 'linux');
      assert.equal(receipt.phase, phase); assert.equal(receipt.zombiePolicy, QUIET_ZOMBIE_POLICY);
    }
  }
}

function physicalGuardReferences(manifest) {
  return manifest.flatMap((entry, pair) => ['baseline', 'candidate'].map(arm => ({ pair: pair + 1, arm,
    receipts: entry[`${arm}Artifacts`].filter(seal => /^physical-quiet-(pre|post)\.json$/.test(path.basename(seal.file))) })));
}

async function browserRun(context, armStage, variant) {
  const preflight = await checkFrozen(context, variant); // ALL receipts; selected live artifact inventory before EVERY arm.
  const { release } = context, build = release.perVariantBuilds[variant], directory = path.join(context.out, armStage);
  await mkdir(directory, { recursive: false }); await saveJson(path.join(directory, 'pre-arm-inventory-check.json'), preflight, true);
  await physicalQuietGuard({ receiptFile: path.join(directory, 'physical-quiet-pre.json'), phase: 'pre-arm', armStage });
  const port = await freePort();
  let primaryError, inventoryFile, extracted;
  try {
    await execute(context, { stage: armStage, cwd: release.harnessRoot,
      args: ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright-native-ingestion.config.ts'],
      env: { PAPERCLIP_INGESTION_OBSERVATION_MODE: MODE, PAPERCLIP_RUNNER_BINARY: path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'),
        PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: path.join(build.appRoot, 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'),
        PAPERCLIP_INGESTION_TRANSPORT: 'sandbox-remote-with-local-stop', PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_INGESTION_SMOKE: '0',
        PAPERCLIP_INGESTION_VARIANT: `${armStage}-${variant}`, PAPERCLIP_INGESTION_APP_ROOT: build.appRoot, PAPERCLIP_INGESTION_EVIDENCE_DIR: directory,
        PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Independent frozen H5 driver install; each measured variant owns its separately qualified application/native build' } });
  } catch (error) { primaryError = error; }
  try {
    inventoryFile = await armSidecar(directory, variant, build); extracted = await extractEvidence(directory);
    if (!primaryError) {
      const { evidence } = extracted;
      assert.equal(evidence.complete, true); assert.equal(evidence.observationComplete, true); assert.equal(evidence.observationMode, MODE);
      assert.equal(evidence.workloadSha256, WORKLOAD_SHA256); assert.equal(evidence.protocolVersion, PROTOCOL);
      assert.equal(evidence.transport, 'sandbox-remote-with-local-stop'); assert.equal(evidence.cleanup?.complete, true); assert.deepEqual(evidence.cleanup.errors, []);
      assert.equal(evidence.measurementSha256, release.protocolSha256); assert.equal(evidence.harnessProvenance?.sourceRevision, release.harnessRevision); assert.equal(evidence.harnessProvenance?.sourceStatus, '');
      assert.equal(evidence.sourceRevision, build.revision); assert.equal(evidence.compiledBuildRevision, build.revision);
      assert.equal(evidence.serverArtifact, 'compiled'); assert.equal(evidence.qualificationOnly, false); assert.equal(evidence.diagnosticOnly, false); assert.equal(evidence.performanceAcceptanceEligible, true);
      assert.equal(evidence.browserRecording?.trace, 'off'); assert.equal(evidence.browserRecording?.video, 'off'); assert.equal(evidence.browserRecording?.screencast, false);
      const loaded = evidence.cases.find(item => item.name === 'burst512'); assert.equal(loaded.runs, 100); assert.equal(loaded.participants, 100); assert.equal(loaded.durable.length, 100);
      const { validateArmInventory } = await import(pathToFileURL(path.join(release.harnessRoot, 'scripts/native-ingestion-h5-inventory.mjs')).href);
      await validateArmInventory(inventoryFile, { evidence, owningPlaywright: { reportSha256: hash(await readFile(extracted.playwrightFile)) } });
    }
  } catch (error) { primaryError ??= error; }
  try { await assertPortReleased(port); await saveJson(path.join(directory, 'physical-http-port-check.json'), { released: true, port, scope: 'Owned HTTP listener only; PG/Runner/provider physical cleanup is separately required before the next release' }, true); }
  catch (error) { primaryError ??= error; }
  try { await physicalQuietGuard({ receiptFile: path.join(directory, 'physical-quiet-post.json'), phase: 'post-arm', armStage,
    primaryFailureAlreadyPresent: Boolean(primaryError) }); }
  catch (error) {
    if (primaryError) console.error(`Secondary physical quiet failure; primary fixture failure is retained: ${error.message}`);
    primaryError ??= error;
  } // Failed guard receipt and SHA remain independent evidence; the fixture failure stays primary.
  if (primaryError) throw primaryError;
  const result = { file: extracted.file, playwrightFile: extracted.playwrightFile, inventoryFile };
  return { ...result, artifacts: await sealArmArtifacts(context.out, result) };
}

function comparatorArgs(context, plan, pairsFile, output, originalProof) {
  const args = ['scripts/compare-native-ingestion-browser.ts', `--observation-mode=${MODE}`, `--phase=${plan.aa ? 'aa' : 'compare'}`,
    `--expect=${plan.expectation}`, `--pairs=${pairsFile}`, `--output=${output}`];
  if (!plan.aa) args.push(`--candidate-policy=${plan.candidatePolicy}`, `--noise-report=${path.join(context.out, `${plan.noiseStage}.json`)}`,
    ...(originalProof ? [`--original-h4d-proof=${originalProof.proofFile}`, `--original-h4d-inventory=${originalProof.inventoryFile}`, '--require-acceptance'] : ['--require-performance']));
  return args;
}

async function browserSeries(context) {
  const { plan, release } = context, manifest = [], file = path.join(context.out, `${plan.stage}-pairs.json`), comparisonFile = path.join(context.out, `${plan.stage}.json`);
  await access(comparisonFile).then(() => assert.fail('Prior comparison output already exists'), error => { if (error.code !== 'ENOENT') throw error; });
  await saveJson(file, manifest, true);
  for (let pair = 0; pair < 5; pair++) {
    const entry = {}, arms = pair % 2 ? [['candidate', plan.candidate], ['baseline', plan.baseline]] : [['baseline', plan.baseline], ['candidate', plan.candidate]];
    for (const [arm, variant] of arms) {
      const result = await browserRun(context, `${plan.stage}-pair${pair + 1}-${arm}`, variant);
      entry[`${arm}File`] = result.file; entry[`${arm}PlaywrightFile`] = result.playwrightFile; entry[`${arm}InventoryFile`] = result.inventoryFile; entry[`${arm}Artifacts`] = result.artifacts;
    }
    manifest.push(entry); await saveJson(file, manifest);
  }
  await checkFrozen(context); // Same exact release/noise path and bytes pre-comparator.
  await verifyRawArtifactSeals(context.out, manifest);
  const manifestSha256 = hash(await readFile(file));
  await execute(context, { stage: `${plan.stage}-comparison`, cwd: release.harnessRoot, args: comparatorArgs(context, plan, file, comparisonFile) });
  assert.equal(hash(await readFile(file)), manifestSha256, 'Raw paired manifest changed during comparison');
  await verifyRawArtifactSeals(context.out, manifest);
  const result = await getJson(comparisonFile); checkComparisonIdentity(result, context);
  if (!plan.aa) assert.equal(result.performancePassed, true);
  await saveJson(path.join(context.out, `${plan.stage}.completion.json`), { stage: plan.stage, complete: true, fullArms: 10, completedAtMs: Date.now(),
    releaseFile: context.rootReleaseCopy, originalReleaseFile: context.releaseFile, releaseFileSha256: context.releaseBytesSha256, harnessPins: harnessFields(release),
    perVariantBuilds: Object.fromEntries(plan.requiredVariants.map(variant => [variant, release.perVariantBuilds[variant]])),
    manifestFile: file, manifestSha256, comparisonFile, comparisonSha256: hash(await readFile(comparisonFile)),
    physicalGuards: physicalGuardReferences(manifest),
    ...(plan.noiseStage ? { noiseReportFile: release.noiseReportFile, noiseReportSha256: release.noiseReportSha256 } : {}),
    performancePassed: result.performancePassed ?? null, acceptancePassed: result.acceptancePassed ?? null,
    finalOriginalH4dConfirmationPending: plan.candidatePolicy === 'final-b2' }, true);
}

async function checkFinalizationInputs(context) {
  const proof = context.release.originalH4dProof;
  assert.ok(proof, 'One later unchanged H4d proof is required for both final comparisons');
  for (const [key, sha] of [['proofFile', 'proofSha256'], ['inventoryFile', 'inventorySha256']]) await hashedJson(proof[key], proof[sha], `Original H4d ${key}`);
  const proofReport = await getJson(proof.proofFile), proofAttempts = [];
  const visit = value => {
    if (Array.isArray(value)) for (const child of value) visit(child);
    else if (value && typeof value === 'object') {
      if (Array.isArray(value.results) && Object.hasOwn(value, 'expectedStatus')) proofAttempts.push(...value.results);
      for (const [key, child] of Object.entries(value)) if (key !== 'results') visit(child);
    }
  };
  visit(proofReport); assert.equal(proofAttempts.length, 1, 'One later unchanged original H4d attempt must confirm both stages');
  const proofStartedAtMs = Date.parse(proofAttempts[0].startTime);
  assert.ok(Number.isFinite(proofStartedAtMs), 'Original H4d proof has no actual attempt start time');
  for (const stage of ['browser-b1-b2', 'browser-b0-b2']) {
    const pin = context.release.completedSeries?.[stage]; assert.ok(pin, `Missing frozen completed ${stage}`);
    assert.equal(pin.file, path.join(context.out, `${stage}.completion.json`));
    const completion = (await hashedJson(pin.file, pin.sha256, `${stage} completion`)).value;
    assert.equal(completion.stage, stage); assert.equal(completion.complete, true); assert.equal(completion.fullArms, 10); assert.equal(completion.performancePassed, true);
    assert.ok(Number.isFinite(completion.completedAtMs) && completion.completedAtMs < proofStartedAtMs, 'Original H4d proof must run after BOTH timing stages complete');
    assert.deepEqual(completion.harnessPins, harnessFields(context.release));
    const plan = stagePlan(stage);
    for (const variant of plan.requiredVariants) assert.deepEqual(completion.perVariantBuilds[variant], context.release.perVariantBuilds[variant], 'Finalization changed a measured qualified build');
    assert.equal(completion.manifestFile, path.join(context.out, `${stage}-pairs.json`));
    assert.equal(completion.comparisonFile, path.join(context.out, `${stage}.json`));
    assert.equal(hash(await readFile(completion.manifestFile)), completion.manifestSha256, 'Raw timing manifest changed before finalization');
    const manifest = await getJson(completion.manifestFile); assert.equal(manifest.length, 5);
    await verifyRawArtifactSeals(context.out, manifest);
    assert.deepEqual(completion.physicalGuards, physicalGuardReferences(manifest), 'Completion physical-guard receipts differ from sealed arm bytes');
    assert.equal(hash(await readFile(completion.comparisonFile)), completion.comparisonSha256, 'Preliminary performance assessment changed');
    assert.equal(completion.noiseReportFile, path.join(context.out, `${plan.noiseStage}.json`), 'Finalization rebound the frozen noise path');
    assert.equal(hash(await readFile(completion.noiseReportFile)), completion.noiseReportSha256, 'Frozen noise bytes changed before finalization');
    const originalRelease = await hashedJson(completion.releaseFile, completion.releaseFileSha256, `${stage} original release`);
    assert.equal(originalRelease.value.noiseReportFile, completion.noiseReportFile); assert.equal(originalRelease.value.noiseReportSha256, completion.noiseReportSha256);
  }
}

async function finalizeSeries(context) {
  await checkFrozen(context); await checkFinalizationInputs(context);
  for (const stage of ['browser-b1-b2', 'browser-b0-b2']) {
    await checkFrozen(context); await checkFinalizationInputs(context);
    const pin = context.release.completedSeries[stage], completion = (await hashedJson(pin.file, pin.sha256, `${stage} completion`)).value;
    const output = path.join(context.out, `${stage}.final.json`);
    await access(output).then(() => assert.fail('Final assessment output already exists'), error => { if (error.code !== 'ENOENT') throw error; });
    await execute(context, { stage: `${stage}-original-h4d-finalization`, cwd: context.release.harnessRoot,
      args: comparatorArgs(context, stagePlan(stage), completion.manifestFile, output, context.release.originalH4dProof) });
    await checkFinalizationInputs(context);
    assert.equal((await getJson(output)).acceptancePassed, true);
  }
}

async function main() {
  const stage = option('stage');
  if (!process.argv.includes('--execute') && !process.argv.includes('--validate-release')) {
    console.log(JSON.stringify({ draft: true, observationMode: MODE, protocolVersion: PROTOCOL, workloadSha256: WORKLOAD_SHA256,
      stages: STAGES.map(stagePlan), fullArms: 50, finalization: stagePlan(FINALIZE_STAGE),
      baselines: BASELINES, originalReceiptSha256: OLD_RECEIPT, resourceWatchdogMillis: RESOURCE_WATCHDOG_MILLIS,
      frozenH5: { revision: H5_REVISION, protocolSha256: H5_PROTOCOL_SHA256, comparatorSha256: H5_COMPARATOR_SHA256, inventoryHelperSha256: H5_INVENTORY_HELPER_SHA256, protocolDocumentSha256: H5_PROTOCOL_DOCUMENT_SHA256 },
      pendingPins: 'Future B2 has no descriptor until its actual new source and separately qualified native/application build are available. No H5 VM execution is released by this file.',
      note: 'Plan only; no SUT/build/VM/network or arm starts. Root and independent peer review plus qualification release required.' }, null, 2)); return;
  }
  const out = option('output-root') ?? '/home/ubuntu/native-ingestion/evidence/h5/browser';
  const context = await loadRelease(option('release'), stage, out);
  if (process.argv.includes('--validate-release') && !process.argv.includes('--execute')) {
    console.log(JSON.stringify({ valid: true, stage, requiredVariants: context.plan.requiredVariants,
      validationScope: 'Static immutable release/receipt/manifest/noise/stage-order bindings only; no live SUT/driver/build attestation and no arm execution', releaseFileSha256: context.releaseBytesSha256 })); return;
  }
  await checkFrozen(context); await mkdir(out, { recursive: true });
  // Keep the exact release bytes as a distinct artifact, so later stages never
  // require an owner to retain an overwriteable release-input filename.
  context.rootReleaseCopy = path.join(out, `${stage}-root-release.json`);
  const releaseBytes = await readFile(context.releaseFile);
  assert.equal(hash(releaseBytes), context.releaseBytesSha256, 'Root release changed before preservation');
  await writeFile(context.rootReleaseCopy, releaseBytes, { flag: 'wx' });
  await saveJson(path.join(out, `${stage}-release-record.json`), { ...context.release, releaseFile: context.releaseFile,
    releaseFileSha256: context.releaseBytesSha256, recordedAt: new Date().toISOString() }, true);
  if (context.plan.finalizationOnly) await finalizeSeries(context); else await browserSeries(context);
}
if (process.argv[1] && path.resolve(process.argv[1]) === selfFile) await main();
