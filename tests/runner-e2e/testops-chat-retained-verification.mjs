import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testopsClient, verifyChatUpload, failureProjection } from './chat-feature-testops-api.mjs';
import { readBoundChatExport } from './chat-feature-testops-results.mjs';

const execute = promisify(execFile);
const repository = 'paperclipai/paperclip';
const workflow = '.github/workflows/chat-feature-testops-retained-verification.yml';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
export const origin = Object.freeze({ runId: '41217990335', attempt: '1', workflowSha: 'e40de0c9e88210dc476dcf651461c0a8d1b98a59',
  targetSha: 'e40de0c9e88210dc476dcf651461c0a8d1b98a59', workflowId: 402193022, jobRunId: 1031,
  projectId: 1, planId: 36, caseId: 388, jobId: 34, launchId: 1069, resultId: 2675 });
const artifacts = [
  { id: 13048363226, name: 'chat-testops-selection-41217990335-1', root: 'selection', limit: 65_536,
    sha256: '5cb9c399746ac4e94c36a64bc4b0b5d40fe1e4b1b9979f1c2c00df9b22ff11f1' },
  { id: 13049196662, name: 'runner-e2e-testops-41217990335-1', root: 'safe-export', limit: 32 * 1024 * 1024,
    sha256: '73853c35455586ad675f165d3056493650cc1182bb1e79dfd04c35905dfd8ec3' },
];
const selector = 'chat-features.runner-opencode-deepseek-1017.local.create-backlog';
const selectionHash = '32736bd5d8ebdc971157e7c42c6fd3dc86bf0ed8fe425015a3855266454699f8';
const bindingHash = '3d383a8b8d6e10526a9ea408734ab74b3c1015659368f3c451a56db5a170e897';
const originalHelpers = [
  ['chat-feature-testops-api.mjs', 'b89fa3bd1fcd46a7da00d0ec04422cb523d166ba12255ff7b1df80d046b1839e'],
  ['chat-feature-testops-results.mjs', 'a53923326c8c97e5305f25b864b9bb56d2d33dc8d0365b93017c8033f3007b74'],
];
const expectedAttachments = [
  { name: 'Synthetic task and source conversation', contentType: 'image/png', contentLength: 104828 },
  { name: 'Execution provenance and checks', contentType: 'application/json', contentLength: 1443 },
  { name: 'Sanitized Product E2E record and accounting', contentType: 'application/json', contentLength: 9516 },
];
export const routes = Object.freeze(['/api/jobrun/1031', '/api/launch/1069',
  '/api/testresult?launchId=1069&page=0&size=100', '/api/testresult/2675',
  '/api/testresult/attachment?testResultId=2675&page=0&size=100']);
const reject = code => { throw new Error(code); };
const codes = new Set(['executor_rejected', 'origin_rejected', 'artifact_rejected', 'selection_rejected', 'export_rejected',
  'network_route_rejected', 'output_rejected', 'retained_snapshot_rejected']);

export function admitExecutor(env, event, repo, run, registered) {
  let allowed;
  try { allowed = JSON.parse(env.TESTOPS_ALLOWED_ACTOR_IDS); } catch { reject('executor_rejected'); }
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== repository
    || env.GITHUB_REF !== 'refs/heads/master' || env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/master`
    || env.GITHUB_RUN_ATTEMPT !== '1' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') || env.GITHUB_RUN_ID === origin.runId
    || repo.full_name !== repository || repo.private !== false || repo.default_branch !== 'master'
    || event.repository?.full_name !== repository || event.repository?.private !== false || event.ref !== 'refs/heads/master'
    || event.inputs != null && (typeof event.inputs !== 'object' || Array.isArray(event.inputs) || Object.keys(event.inputs).length !== 0)
    || !Array.isArray(allowed) || allowed.length === 0 || allowed.some(value => !positive(value))
    || !allowed.includes(Number(env.GITHUB_ACTOR_ID)) || event.sender?.id !== Number(env.GITHUB_ACTOR_ID)
    || run.id !== Number(env.GITHUB_RUN_ID) || run.run_attempt !== 1 || run.head_sha !== env.GITHUB_SHA
    || run.head_branch !== 'master' || run.event !== 'workflow_dispatch' || run.path !== workflow
    || run.repository?.full_name !== repository || run.actor?.id !== Number(env.GITHUB_ACTOR_ID)
    || !allowed.includes(run.triggering_actor?.id) || registered.path !== workflow || registered.id !== run.workflow_id) reject('executor_rejected');
  return { runId: env.GITHUB_RUN_ID, attempt: '1', source: env.GITHUB_SHA, workflowId: run.workflow_id,
    workflow, actorId: run.actor.id, triggeringActorId: run.triggering_actor.id };
}

export function admitOrigin(run) {
  if (run.id !== Number(origin.runId) || run.run_attempt !== 1 || run.workflow_id !== origin.workflowId
    || run.head_sha !== origin.workflowSha || run.head_branch !== 'master' || run.event !== 'workflow_dispatch'
    || run.path !== '.github/workflows/chat-feature-testops.yml' || run.repository?.full_name !== repository
    || run.actor?.id !== 34892728 || run.triggering_actor?.id !== 34892728
    || run.status !== 'completed' || run.conclusion !== 'failure') reject('origin_rejected');
}

export function admitArtifact(actual, expected, archive) {
  if (actual.id !== expected.id || actual.name !== expected.name || actual.expired !== false
    || !positive(actual.size_in_bytes) || actual.size_in_bytes > expected.limit || archive.length > expected.limit
    || actual.workflow_run?.id !== Number(origin.runId) || actual.workflow_run?.head_sha !== origin.workflowSha
    || actual.digest !== `sha256:${expected.sha256}` || hash(archive) !== expected.sha256) reject('artifact_rejected');
}

export function admitSelection(bytes) {
  if (bytes.length > 16_384 || hash(bytes) !== selectionHash) reject('selection_rejected');
  const selected = JSON.parse(bytes);
  if (selected.runId !== origin.runId || selected.attempt !== origin.attempt || selected.workflowSha !== origin.workflowSha
    || selected.targetSha !== origin.targetSha || selected.allureJobRunId !== String(origin.jobRunId)
    || selected.projectId !== origin.projectId || selected.planId !== origin.planId || selected.caseId !== origin.caseId
    || selected.jobId !== origin.jobId || selected.launchId !== origin.launchId || selected.executionId !== selector) reject('selection_rejected');
  return selected;
}

const type = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array'
  : ['string', 'number', 'boolean', 'object'].includes(typeof value) ? typeof value : 'other';
export function attachmentProjection(page) {
  return { contentType: type(page?.content), rows: Array.isArray(page?.content) ? page.content.slice(0, 10).map(row => {
    const expected = expectedAttachments.find(value => value.name === row?.name);
    return { idType: type(row?.id), idPositiveSafeInteger: positive(row?.id), ...(positive(row?.id) ? { id: row.id } : {}),
      missedType: type(row?.missed), missed: typeof row?.missed === 'boolean' ? row.missed : null,
      fromTestCaseType: type(row?.fromTestCase), fromTestCase: typeof row?.fromTestCase === 'boolean' ? row.fromTestCase : null,
      role: expected ? expected.name : 'unknown', contentTypeMatches: !!expected && row.contentType === expected.contentType,
      contentLengthType: type(row?.contentLength), contentLengthMatches: !!expected && row.contentLength === expected.contentLength };
  }) : [] };
}

export async function snapshotAndReplay(api, selected, exported) {
  const snapshots = new Map();
  for (const route of routes) snapshots.set(route, await api(route, 'GET'));
  const measurementContext = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ATTEMPT: origin.attempt, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/chat-feature-testops.yml@refs/heads/master`,
    GITHUB_SHA: origin.workflowSha, GITHUB_RUN_ID: origin.runId, ALLURE_JOB_RUN_ID: String(origin.jobRunId) };
  const projection = attachmentProjection(snapshots.get(routes[4]));
  try {
    const verification = await verifyChatUpload(async (route, method = 'GET') => {
      if (method !== 'GET' || !snapshots.has(route)) reject('network_route_rejected');
      return snapshots.get(route);
    }, measurementContext, selected, exported, { now: () => 0, wait: async () => {} });
    if (verification.resultId !== origin.resultId) reject('retained_snapshot_rejected');
    return { attachmentRows: projection, verification, snapshotReplay: 'unchanged verifier against one current protected response snapshot' };
  } catch (error) {
    return { attachmentRows: projection, failure: failureProjection(error, 'upload_verification'), snapshotReplay: 'unchanged verifier against one current protected response snapshot' };
  }
}

const extraction = `import sys,zipfile,pathlib,stat,os
archive,target,kind=sys.argv[1:]
root=pathlib.Path(target);root.mkdir(mode=0o700)
selector='chat-features.runner-opencode-deepseek-1017.local.create-backlog'
allowed={'testops-selection.json'} if kind=='selection' else {'binding.json','normalized-results.json','junit.xml','evidence/'+selector+'/attempt-1/final-state.png'}
with zipfile.ZipFile(archive) as z:
 infos=z.infolist();assert len(infos)<=12
 names=set();total=0
 for item in infos:
  if item.is_dir():
   assert item.filename.rstrip('/') in ['evidence','evidence/'+selector,'evidence/'+selector+'/attempt-1'];continue
  assert item.filename in allowed and item.filename not in names and not stat.S_ISLNK(item.external_attr>>16)
  assert item.file_size<=12*1024*1024
  total+=item.file_size;assert total<=32*1024*1024
  names.add(item.filename);out=root/item.filename;out.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  with out.open('xb') as f:f.write(z.read(item))
  os.chmod(out,0o600)
 assert names==allowed
`;
async function gh(route, binary = false) {
  const { stdout } = await execute('gh', ['api', route], { encoding: binary ? 'buffer' : 'utf8', timeout: 30_000, maxBuffer: 34 * 1024 * 1024 });
  return binary ? stdout : JSON.parse(stdout);
}

export async function extractArchive(file, destination, kind) {
  if (!['selection', 'safe-export'].includes(kind)) reject('artifact_rejected');
  await execute('python3', ['-c', extraction, file, destination, kind], { timeout: 30_000, maxBuffer: 1024 });
}

export async function run(env = process.env) {
  let output, executor, apiFailure, stage = 'executor_admission';
  try {
    if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) reject('output_rejected');
    if (!/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '')) reject('executor_rejected');
    const eventStat = await lstat(env.GITHUB_EVENT_PATH);
    if (!eventStat.isFile() || eventStat.isSymbolicLink() || eventStat.size > 65_536) reject('executor_rejected');
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    executor = admitExecutor(env, event, await gh(`repos/${repository}`), await gh(`repos/${repository}/actions/runs/${env.GITHUB_RUN_ID}`),
      await gh(`repos/${repository}/actions/workflows/${path.basename(workflow)}`));
    output = path.join(env.RUNNER_TEMP, 'chat-testops-retained-verification');
    await mkdir(output, { mode: 0o700 });
    stage = 'origin_admission';
    for (const [file, digest] of originalHelpers) if (hash(await readFile(new URL(file, import.meta.url))) !== digest) reject('origin_rejected');
    admitOrigin(await gh(`repos/${repository}/actions/runs/${origin.runId}`));
    stage = 'artifact_admission';
    for (const artifact of artifacts) {
      const actual = await gh(`repos/${repository}/actions/artifacts/${artifact.id}`);
      const archive = await gh(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true);
      admitArtifact(actual, artifact, archive);
      const file = path.join(output, `${artifact.root}.zip`);
      await writeFile(file, archive, { flag: 'wx', mode: 0o600 });
      await extractArchive(file, path.join(output, artifact.root), artifact.root);
    }
    const selected = admitSelection(await readFile(path.join(output, 'selection/testops-selection.json')));
    const exportRoot = path.join(output, 'safe-export');
    if (hash(await readFile(path.join(exportRoot, 'binding.json'))) !== bindingHash) reject('export_rejected');
    const bound = await readBoundChatExport(exportRoot, origin);
    const png = bound.retained.get(`evidence/${selector}/attempt-1/final-state.png`);
    if (png?.length !== expectedAttachments[0].contentLength || bound.retained.get('normalized-results.json')?.length !== expectedAttachments[2].contentLength) reject('export_rejected');
    const exported = { status: bound.result.status === 'passed' && bound.result.cleanup === 'passed' ? 'passed' : 'failed',
      cleanup: bound.result.cleanup, caseId: origin.caseId, campaignId: bound.binding.campaignId,
      count: 1, attachmentMetadata: expectedAttachments };
    stage = 'protected_authentication';
    const api = await testopsClient(env.ALLURE_TOKEN).catch(error => {
      apiFailure = failureProjection(error, 'authentication'); throw error;
    });
    stage = 'protected_snapshot';
    const result = await snapshotAndReplay(async (route, method) => {
      if (method !== 'GET' || !routes.includes(route)) reject('network_route_rejected');
      try { return await api(route, 'GET'); }
      catch (error) { apiFailure = failureProjection(error, 'upload_verification'); throw error; }
    }, selected, exported);
    const record = { schema: 'paperclip.chat-feature-testops-retained-verification/v1', executor, origin,
      observedAt: new Date().toISOString(), authentication: 'existing protected reporting ALLURE_TOKEN',
      historicalFailureCause: 'not established by this later snapshot', originalGradeUnchanged: true,
      selectionSha256: selectionHash, bindingSha256: bindingHash, ...result };
    stage = 'receipt';
    await writeFile(path.join(output, 'retained-verification.json'), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    return result.verification ? 0 : 1;
  } catch (error) {
    if (output) await writeFile(path.join(output, 'failure.json'), JSON.stringify({ schema: 'paperclip.chat-feature-testops-retained-failure/v1',
      executor, origin, stage, code: codes.has(error.message) ? error.message : 'retained_verification_failed',
      ...(apiFailure ? { apiFailure } : {}) }, null, 2), { flag: 'wx', mode: 0o600 });
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run();
