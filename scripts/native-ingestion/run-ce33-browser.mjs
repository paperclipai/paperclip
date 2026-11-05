import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// APPLICATION ONLY, prospective draft: execution still requires root release after H4c full qualification.
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = '/home/ubuntu/native-ingestion';
const harnessRoot = `${base}/harness-h4c`;
const harnessRevision = '7d7e7a88d562a95a1d407b76474763b666c181f5';
const trees = { B0: `${base}/ce33-baseline`, B1: `${base}/ce33-cursors`, B2: `${base}/ce33-batching` };
const revisions = { B0: 'a36567f9fbf805ad72207d54f539516e3121741e', B1: 'd8cd3be0aeed4f9fb93ecc3cf725f1d46d5a0310', B2: '914129afb141d81c0d6d8c5f0ea11c20bd69a3da' };
const browserHash = '5db4129bbdc1fa38775121aff5d0e68a8a11762519e41cfdf36eacd90ba7256b';
const comparatorHash = '01e0de114c886c255aaa7062a63f3e48788d8a83ce50921d672b2d661baef43b';
const lockHash = '54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8';
const out = option('output-root') ?? `${base}/evidence/ce33/browser`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const getJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
let commandIndex = 0; const commands = [];
let release;
const stages = ['browser-aa-b0','browser-b0-b1','browser-aa-b1','browser-b1-b2','browser-b0-b2'];


async function checkFrozen() {
  for (const key of ['DATABASE_URL','PAPERCLIP_RUNNER_STATE_DIR','PAPERCLIP_INGESTION_SERVER_COMMAND',
    'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS',
    'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR','PAPERCLIP_INGESTION_BROWSER_CAPTURE','NODE_OPTIONS'])
    assert.ok(!process.env[key], `Acceptance rejects ambient ${key}`);
  const qualifiedBytes = await readFile(`${base}/ce33-builds-qualified.json`);
  if (release) assert.equal(hash(qualifiedBytes), release.qualifiedInventorySha256, 'Qualified build inventory changed after root release');
  const qualified = JSON.parse(qualifiedBytes);
  for (const [label, tree] of Object.entries(trees)) {
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:tree,encoding:'utf8'}).trim(),revisions[label]);
    assert.equal(execFileSync('git',['status','--short'],{cwd:tree,encoding:'utf8'}).trim(),'');
    assert.equal((await getJson(path.join(tree,'server/dist/build-info.json'))).commit,revisions[label]);
    assert.equal(qualified.results.find(row=>row.variant===label).revision,revisions[label]);
  }
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:harnessRoot,encoding:'utf8'}).trim(),harnessRevision);
  assert.equal(execFileSync('git',['status','--short'],{cwd:harnessRoot,encoding:'utf8'}).trim(),'');
  const protocol = ['native-event-ingestion.journey.ts','playwright-native-ingestion.config.ts','fixtures/in-feed-codex.mjs',
    'fixtures/native-ingestion-bin/codex','fixtures/composer-stop-codex-loader.mjs','fixtures/native-ingestion-bootstrap.mjs',
    'fixtures/native-ingestion-remote-server.mjs','fixtures/native-ingestion-protocol-qualification.mjs'];
  assert.equal(hash(Buffer.concat(await Promise.all(protocol.map(file=>readFile(path.join(harnessRoot,'tests/e2e',file)))))),browserHash);
  assert.equal(hash(await readFile(path.join(harnessRoot,'scripts/compare-native-ingestion-browser.ts'))),comparatorHash);
  assert.equal(hash(await readFile(path.join(harnessRoot,'pnpm-lock.yaml'))),lockHash);
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
  assert.equal(evidence.complete, true);
  assert.equal(evidence.transport, 'sandbox-remote-with-local-stop');
  assert.equal(evidence.cleanup?.complete, true);
  assert.deepEqual(evidence.cleanup?.errors, []); assert.equal(evidence.measurementSha256, browserHash);
  assert.equal(evidence.protocolVersion, 'v4-remote-streaming-original-local-stop-clock-stream');
  assert.equal(evidence.harnessProvenance?.sourceRevision, harnessRevision);
  assert.equal(evidence.harnessProvenance?.sourceStatus, '');
  const file = path.join(directory, 'native-ingestion-evidence.json'); await saveJson(file, evidence);
  return { file, evidence };
}

async function browserRun(stage, tree, smoke) {
  await checkFrozen();
  const directory = path.join(out, stage); await mkdir(directory, { recursive: false });
  const port = await freePort();
  await execute({ stage, cwd: harnessRoot, args: ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright-native-ingestion.config.ts'],
    env: { PAPERCLIP_RUNNER_BINARY: path.join(trees[tree], 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'),
      PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: path.join(trees[tree], 'packages/paperclip-runner/runner/target/release/paperclip-runnerd'), PAPERCLIP_INGESTION_TRANSPORT: 'sandbox-remote-with-local-stop', PAPERCLIP_E2E_PORT: String(port), PAPERCLIP_INGESTION_SMOKE: smoke ? '1' : '0', PAPERCLIP_INGESTION_VARIANT: `${stage}-${tree}`,
      PAPERCLIP_INGESTION_APP_ROOT: trees[tree], PAPERCLIP_INGESTION_EVIDENCE_DIR: directory,
      PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES: 'Independent H4c locked offline ignore-scripts driver install; measured applications own independent normal locked installs/builds' } });
  const { file, evidence } = await extractEvidence(directory);
  assert.equal(evidence.sourceRevision, revisions[tree]); assert.equal(evidence.compiledBuildRevision, revisions[tree]);
  assert.equal(evidence.serverArtifact, 'compiled'); assert.equal(evidence.qualificationOnly, smoke);
  assert.equal(evidence.diagnosticOnly, false); assert.equal(evidence.performanceAcceptanceEligible, true);
  assert.equal(evidence.browserRecording?.trace, 'off'); assert.equal(evidence.browserRecording?.video, 'off');
  assert.equal(evidence.browserRecording?.screencast, false);
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
  const noisePath = path.join(out, `browser-aa-${baseline.toLowerCase()}.json`);
  const checkNoise = async () => {
    assert.match(release.noiseReportSha256, /^[a-f0-9]{64}$/, 'Candidate release must freeze the reviewed A/A bytes');
    const bytes = await readFile(noisePath);
    assert.equal(hash(bytes), release.noiseReportSha256, 'Reviewed A/A noise report changed after release');
    const noise = JSON.parse(bytes);
    assert.equal(noise.complete, true); assert.equal(noise.phase, 'aa');
  };
  if (!aa) await checkNoise();
  for (let pair = 0; pair < 5; pair++) {
    const entry = {};
    const arms = pair % 2 ? [['candidate', candidate], ['baseline', baseline]] : [['baseline', baseline], ['candidate', candidate]];
    for (const [arm, tree] of arms) entry[`${arm}File`] = await browserRun(`${stage}-pair${pair + 1}-${arm}`, tree, false);
    manifest.push(entry); await saveJson(file, manifest);
  }
  if (!aa) await checkNoise();
  await execute({ stage: `${stage}-comparison`, cwd: harnessRoot, args: ['scripts/compare-native-ingestion-browser.ts', `--phase=${aa ? 'aa' : 'compare'}`,
    `--expect=${expectation}`, `--pairs=${file}`, `--output=${out}/${stage}.json`,
    ...(aa ? [] : [`--noise-report=${noisePath}`, '--require-acceptance'])] });
}

const stage = option('stage');
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({draft:true, stages, revisions, harnessRevision, browserHash, comparatorHash,
    note:'No execution in dry run. Root must release after latest full H4c qualification. Separate A/A suitability review before each candidate series.'},null,2));
  process.exit(0);
}
assert.ok(stages.includes(stage), 'Select exactly one browser stage');
await checkFrozen();
await mkdir(out,{recursive:true});
// The owner supplies a prospectively frozen root release and full qualification evidence.
const releaseBytes = await readFile(option('release'));
release = JSON.parse(releaseBytes);
assert.match(release.qualifiedInventorySha256, /^[a-f0-9]{64}$/);
assert.equal(release.orchestratorSha256, hash(await readFile(new URL(import.meta.url))), 'Orchestrator changed after release');
await checkFrozen();
assert.equal(release.stage,stage); assert.equal(release.harnessRevision,harnessRevision);
assert.deepEqual(release.revisions,revisions); assert.equal(release.protocolSha256,browserHash);
assert.equal(release.comparatorSha256,comparatorHash); assert.equal(release.authorized,true);
await saveJson(path.join(out, `${stage}-release-record.json`), {
  ...release, releaseFileSha256: hash(releaseBytes), recordedAt: new Date().toISOString(),
});
if(stage==='browser-aa-b0') await browserSeries(stage,'B0','B0',true);
else if(stage==='browser-aa-b1') await browserSeries(stage,'B1','B1',true);
else if(stage==='browser-b0-b1') await browserSeries(stage,'B0','B1',false,'nonregression');
else if(stage==='browser-b1-b2') await browserSeries(stage,'B1','B2');
else if(stage==='browser-b0-b2') await browserSeries(stage,'B0','B2');
