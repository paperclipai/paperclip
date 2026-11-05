import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// Automation only. The acceptance harness and browser protocol remain frozen.
// Nothing launches unless --execute AND an explicit --stage are supplied.
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option('root') ?? process.cwd();
const harnessRoot = option('harness-root') ?? root;
const trees = { B0: option('b0-root') ?? '/private/tmp/paperclip-native-event-baseline', B1: root,
  B2: option('b2-root') ?? '/private/tmp/paperclip-native-event-batching' };
const revisions = { B0: '83b5f7d486e70e484acd9a41bc957054f4e10175', B1: '7922802f069ab3b39e9f79368c46615ba2201ba9', B2: '6afeba4edafd47120e8117f736641d5424b27d4a' };
const out = option('output-root') ?? (process.platform === 'darwin' ? '/private/tmp/native-ingestion-frozen-evidence' : '/tmp/native-ingestion-frozen-evidence');
const serviceHash = '48e967a5e7a8c803ff3bf4890a37ff70564ba1a618d83bcff5bb110b35ee8133';
const browserHash = '902c6a208793f0bcde1b326a1fee46d85df3274117754e3bfbbf77a65dc730ee';
const comparatorHash = 'e50d958532906d037413db6f66bdc02e60c93ddcacfe2e18e5b731d302f6a785';
const harnessRevision = 'f5c560d80d9d4ee089297d3b3f300c052db17c9e';
const gatesHash = 'ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc';
// Preregistered by the lead before fresh measurements on 2026-11-03.
const aaLimits = { maximumPairedRelativeDifference: 0.20, maximumMedianArmDrift: 0.10 };
const protocol = ['native-event-ingestion.journey.ts', 'playwright-native-ingestion.config.ts', 'fixtures/in-feed-codex.mjs',
  'fixtures/native-ingestion-bin/codex', 'fixtures/composer-stop-codex-loader.mjs', 'fixtures/native-ingestion-bootstrap.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const getJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const stages = ['service-aa-b0', 'service-b0-b1', 'service-aa-b1', 'service-b1-b2', 'service-b0-b2',
  'browser-smoke-b0', 'browser-smoke-b1', 'browser-smoke-b2', 'browser-full-qualification-b0',
  'browser-aa-b0', 'browser-b0-b1', 'browser-aa-b1', 'browser-b1-b2', 'browser-b0-b2'];
const commands = [];
let commandIndex = 0;

function service(stage, tree, baseline, phase, noise) {
  return { stage, cwd: trees[tree], args: ['--import', './server/node_modules/tsx/dist/loader.mjs', 'scripts/benchmark-native-event-ingestion.ts',
    `--baseline-ref=${revisions[baseline]}`, `--phase=${phase}`, `--output=${out}/${stage}.json`,
    ...(noise ? [`--noise-report=${out}/${noise}.json`, '--require-acceptance'] : ['--require-repeatability'])] };
}
const serviceCommands = {
  'service-aa-b0': service('service-aa-b0', 'B1', 'B0', 'aa'),
  'service-b0-b1': service('service-b0-b1', 'B1', 'B0', 'compare', 'service-aa-b0'),
  'service-aa-b1': service('service-aa-b1', 'B2', 'B1', 'aa'),
  'service-b1-b2': service('service-b1-b2', 'B2', 'B1', 'batch', 'service-aa-b1'),
  'service-b0-b2': service('service-b0-b2', 'B2', 'B0', 'batch', 'service-aa-b0'),
};

async function checkFrozen() {
  assert.notEqual(process.env.PAPERCLIP_INGESTION_BROWSER_CAPTURE, '1', 'Browser diagnostic recording cannot enter timed acceptance');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).trim(), harnessRevision, 'Browser harness revision changed');
  assert.equal(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR, undefined, 'Profile-only environment cannot enter an unprofiled acceptance run');
  assert.ok(!/native-ingestion-diagnostic|diagnostic-preload/.test(process.env.NODE_OPTIONS ?? ''), 'Diagnostic preload cannot enter acceptance');
  for (const [label, tree] of Object.entries(trees)) {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim(), revisions[label], `Revision changed: ${label}`);
    const stamp = await getJson(path.join(tree, 'server/dist/build-info.json'));
    assert.equal(stamp.commit, revisions[label], `Compiled build does not match: ${label}`);
  }
  for (const tree of [trees.B1, trees.B2]) {
    assert.equal(hash(await readFile(path.join(tree, 'scripts/benchmark-native-event-ingestion.ts'))), serviceHash);
    assert.equal(hash(await readFile(path.join(tree, 'scripts/native-ingestion-performance-gates.mjs'))), gatesHash);
  }
  assert.equal(hash(await readFile(path.join(harnessRoot, 'scripts/compare-native-ingestion-browser.ts'))), comparatorHash);
  assert.equal(hash(Buffer.concat(await Promise.all(protocol.map(file => readFile(path.join(harnessRoot, 'tests/e2e', file)))))), browserHash);
}

async function execute(step) {
  const index = ++commandIndex, startedAt = new Date().toISOString();
  const log = path.join(out, `${step.stage}.log`);
  const command = { index, stage: step.stage, cwd: step.cwd, executable: process.execPath, args: step.args,
    environmentOverrides: step.env ?? {}, startedAt, log };
  commands.push(command); await saveJson(path.join(out, `${option('stage')}-commands.json`), commands);
  console.log(`START ${step.stage} ${startedAt}; log=${log}`);
  const handle = await open(log, 'wx');
  const stream = handle.createWriteStream();
  const child = spawn(process.execPath, step.args, { cwd: step.cwd, env: { ...process.env, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  command.childPid = child.pid;
  await saveJson(path.join(out, `${option('stage')}-commands.json`), commands);
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  const watchdogMillis = step.stage.startsWith('service-') ? 30 * 60_000 : 20 * 60_000;
  const watchdog = setTimeout(() => { command.watchdogExpired = true; child.kill('SIGTERM'); }, watchdogMillis);
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(watchdog); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await new Promise(resolve => stream.end(resolve));
  Object.assign(command, { finishedAt: new Date().toISOString(), ...exit });
  await saveJson(path.join(out, `${option('stage')}-commands.json`), commands);
  console.log(`END ${step.stage} code=${exit.code} signal=${exit.signal ?? 'none'}`);
  assert.equal(command.watchdogExpired, undefined, 'Resource watchdog expired; run is incomplete, not acceptance');
  assert.equal(exit.code, 0, `Stage ${step.stage} failed; preserve ${log} and diagnose before continuing`);
  return command;
}

async function qualifyAa(file) {
  const report = await getJson(file);
  assert.equal(report.candidateSourceHashes['scripts/benchmark-native-event-ingestion.ts'], serviceHash);
  assert.equal(report.candidateSourceHashes['scripts/native-ingestion-performance-gates.mjs'], gatesHash);
  const { evaluateServiceRepeatability } = await import(path.join(root, 'scripts/native-ingestion-performance-gates.mjs'));
  const result = { report: file, ...evaluateServiceRepeatability(report) };
  await saveJson(file.replace(/\.json$/, '.repeatability.json'), result);
  assert.equal(result.passed, true, 'A/A repeatability failed; no candidate comparison may start');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function extractEvidence(directory) {
  const report = await getJson(path.join(directory, 'playwright.json'));
  const attachments = [];
  const visit = node => {
    if (Array.isArray(node)) for (const child of node) visit(child);
    else if (node && typeof node === 'object') {
      if (Array.isArray(node.attachments)) attachments.push(...node.attachments.filter(value => value.name === 'native-ingestion-evidence'));
      for (const [key, child] of Object.entries(node)) if (key !== 'attachments') visit(child);
    }
  };
  visit(report); assert.equal(attachments.length, 1, 'Exactly one complete native-ingestion evidence attachment is required');
  const attachment = attachments[0];
  const evidence = attachment.body ? JSON.parse(Buffer.from(attachment.body, 'base64').toString()) : await getJson(attachment.path);
  assert.equal(evidence.complete, true); assert.equal(evidence.measurementSha256, browserHash);
  assert.equal(evidence.protocolVersion, 'v2-compact-markers-original-clock-stream');
  assert.equal(evidence.harnessProvenance?.sourceRevision, harnessRevision);
  assert.equal(evidence.harnessProvenance?.sourceStatus, '');
  const file = path.join(directory, 'native-ingestion-evidence.json'); await saveJson(file, evidence);
  return { file, evidence };
}

async function browserRun(stage, tree, smoke) {
  const directory = path.join(out, stage); await mkdir(directory, { recursive: false });
  const port = await freePort();
  await execute({ stage, cwd: harnessRoot, args: ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright-native-ingestion.config.ts'],
    env: { PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_INGESTION_SMOKE: smoke ? '1' : '0', PAPERCLIP_INGESTION_VARIANT: `${stage}-${tree}`,
      PAPERCLIP_INGESTION_APP_ROOT: trees[tree], PAPERCLIP_INGESTION_EVIDENCE_DIR: directory,
      PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Driver-only tooling links to frozen B1 locked dependencies; measured applications each use independent locked installs' } });
  const { file, evidence } = await extractEvidence(directory);
  assert.equal(evidence.sourceRevision, revisions[tree]); assert.equal(evidence.compiledBuildRevision, revisions[tree]);
  assert.equal(evidence.serverArtifact, 'compiled'); assert.equal(evidence.qualificationOnly, smoke);
  assert.equal(evidence.diagnosticOnly, false); assert.equal(evidence.performanceAcceptanceEligible, true);
  if (!smoke) {
    const loaded = evidence.cases.find(item => item.name === 'burst512');
    assert.equal(loaded.runs, 100); assert.equal(loaded.participants, 100); assert.equal(loaded.durable.length, 100);
  }
  // An invocation is complete only when its own HTTP server has released the port.
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => listener.close(resolve));
  return file;
}

async function browserSeries(stage, baseline, candidate, aa = false, expectation = 'improvement') {
  const manifest = [], file = path.join(out, `${stage}-pairs.json`);
  if (!aa) {
    const noise = await getJson(path.join(out, `browser-aa-${baseline.toLowerCase()}.json`));
    assert.equal(noise.complete, true); assert.equal(noise.phase, 'aa');
  }
  for (let pair = 0; pair < 5; pair++) {
    const entry = {};
    const arms = pair % 2 ? [['candidate', candidate], ['baseline', baseline]] : [['baseline', baseline], ['candidate', candidate]];
    for (const [arm, tree] of arms) entry[`${arm}File`] = await browserRun(`${stage}-pair${pair + 1}-${arm}`, tree, false);
    manifest.push(entry); await saveJson(file, manifest);
  }
  await execute({ stage: `${stage}-comparison`, cwd: harnessRoot, args: ['scripts/compare-native-ingestion-browser.ts', `--phase=${aa ? 'aa' : 'compare'}`,
    `--expect=${expectation}`, `--pairs=${file}`, `--output=${out}/${stage}.json`,
    ...(aa ? [] : [`--noise-report=${out}/browser-aa-${baseline.toLowerCase()}.json`, '--require-acceptance'])] });
}

const stage = option('stage');
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ mode: 'DRY RUN; no load launched', revisions, out, aaLimits, stages, serviceCommands,
    note: 'Execute one released stage at a time with --execute --stage=<name>. Do not run builds/tests concurrently. Browser series perform five fresh alternating pairs, never reuse remote baseline samples.' }, null, 2));
  process.exit(0);
}
assert.ok(stages.includes(stage), 'Choose an explicit --stage from the dry run');
await mkdir(out, { recursive: true });
await checkFrozen();
const stageReceipt = await open(path.join(out, `${stage}.started.json`), 'wx');
await stageReceipt.writeFile(JSON.stringify({ stage, pid: process.pid, startedAt: new Date().toISOString(), revisions }, null, 2) + '\n');
await stageReceipt.close();
// Never overwrite evidence. A retry must use a new output root or a new stage name.
if (serviceCommands[stage]) {
  const step = serviceCommands[stage];
  const prior = step.args.find(value => value.startsWith('--noise-report='));
  if (prior) await qualifyAa(prior.slice('--noise-report='.length));
  await execute(step);
  if (stage.startsWith('service-aa-')) await qualifyAa(path.join(out, `${stage}.json`));
} else if (stage.startsWith('browser-smoke-')) {
  await browserRun(stage, stage.slice(-2).toUpperCase(), true);
} else if (stage === 'browser-full-qualification-b0') {
  await browserRun(stage, 'B0', false);
} else if (stage === 'browser-aa-b0') await browserSeries(stage, 'B0', 'B0', true);
else if (stage === 'browser-aa-b1') await browserSeries(stage, 'B1', 'B1', true);
else if (stage === 'browser-b0-b1') await browserSeries(stage, 'B0', 'B1', false, 'nonregression');
else if (stage === 'browser-b1-b2') await browserSeries(stage, 'B1', 'B2');
else if (stage === 'browser-b0-b2') await browserSeries(stage, 'B0', 'B2');
console.log(`COMPLETE ${stage}`);
