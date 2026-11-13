import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { admitExecutor, admitOrigin, admitArtifact, admitSelection, attachmentProjection, snapshotAndReplay, extractArchive, origin, routes } from './testops-chat-retained-verification.mjs';

const workflow = '.github/workflows/chat-feature-testops-retained-verification.yml';
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'paperclipai/paperclip',
  GITHUB_REF: 'refs/heads/master', GITHUB_WORKFLOW_REF: `paperclipai/paperclip/${workflow}@refs/heads/master`,
  GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '900', GITHUB_SHA: 'a'.repeat(40), GITHUB_ACTOR_ID: '34892728', TESTOPS_ALLOWED_ACTOR_IDS: '[34892728]' };
const repo = { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' };
const event = { repository: repo, ref: 'refs/heads/master', sender: { id: 34892728 }, inputs: {} };
const ownRun = { id: 900, run_attempt: 1, head_sha: env.GITHUB_SHA, head_branch: 'master', event: 'workflow_dispatch', path: workflow,
  workflow_id: 901, repository: repo, actor: { id: 34892728 }, triggering_actor: { id: 34892728 } };
const registered = { id: 901, path: workflow };
const selection = { schema: 'paperclip.chat-feature-testops-selection/v1', runId: origin.runId, attempt: origin.attempt,
  workflowSha: origin.workflowSha, targetSha: origin.targetSha, allureJobRunId: String(origin.jobRunId),
  projectId: 1, planId: 36, jobId: 34, caseId: 388, launchId: 1069, fullName: 'paperclip.Product E2E.chat-features.create-backlog',
  executionId: 'chat-features.runner-opencode-deepseek-1017.local.create-backlog', canonicalScenario: 'tasks.create-backlog' };
const attachmentMetadata = [
  { name: 'Synthetic task and source conversation', contentType: 'image/png', contentLength: 104828 },
  { name: 'Execution provenance and checks', contentType: 'application/json', contentLength: 1443 },
  { name: 'Sanitized Product E2E record and accounting', contentType: 'application/json', contentLength: 9516 },
];
const receipt = { status: 'passed', cleanup: 'passed', caseId: 388, campaignId: `gha-${origin.runId}-1`, count: 1, attachmentMetadata };
function responses() {
  const jobrun = { id: 1031, job: { id: 34, type: 'github' }, launchId: 1069,
    url: `https://github.com/paperclipai/paperclip/actions/runs/${origin.runId}`, stage: 'finished' };
  const { job, ...embedded } = jobrun;
  return [jobrun, { id: 1069, projectId: 1 }, { content: [{ id: 2675, testCaseId: 388 }], totalElements: 1, totalPages: 1 },
    { id: 2675, projectId: 1, launchId: 1069, testCaseId: 388, fullName: selection.fullName, jobRun: embedded, links: [], status: 'passed' },
    { content: attachmentMetadata.map((row, index) => ({ ...row, id: index + 9274, missed: false, fromTestCase: false })), totalElements: 3, totalPages: 1 }];
}

test('retained executor uses its own live identity rather than the originating evaluation identity', () => {
  const actual = admitExecutor(env, event, repo, ownRun, registered);
  assert.equal(actual.runId, '900');
  assert.equal(actual.source, 'a'.repeat(40));
  assert.notEqual(actual.runId, origin.runId);
  assert.notEqual(actual.source, origin.workflowSha);
  assert.equal(admitExecutor(env, { ...event, inputs: undefined }, repo, ownRun, registered).workflowId, 901);
});

test('foreign source, branch, workflow, actor, replay or caller-selected origin cannot acquire executor admission', () => {
  for (const changed of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_RUN_ID: origin.runId }, { GITHUB_ACTOR_ID: '1' }, { GITHUB_WORKFLOW_REF: 'other' }]) {
    assert.throws(() => admitExecutor({ ...env, ...changed }, event, repo, ownRun, registered), /executor_rejected/);
  }
  assert.throws(() => admitExecutor(env, { ...event, inputs: { origin: 'other' } }, repo, ownRun, registered), /executor_rejected/);
  assert.throws(() => admitExecutor(env, event, repo, { ...ownRun, triggering_actor: { id: 1 } }, registered), /executor_rejected/);
  assert.throws(() => admitExecutor(env, event, { ...repo, default_branch: 'other' }, ownRun, registered), /executor_rejected/);
  assert.throws(() => admitExecutor(env, event, repo, ownRun, { ...registered, id: 902 }), /executor_rejected/);
});

test('fixed originating measurement requires actual workflow/source/attempt and terminal history', () => {
  const original = { ...ownRun, id: Number(origin.runId), run_attempt: 1, workflow_id: origin.workflowId, head_sha: origin.workflowSha,
    path: '.github/workflows/chat-feature-testops.yml', status: 'completed', conclusion: 'failure' };
  admitOrigin(original);
  for (const changed of [{ head_sha: 'b'.repeat(40) }, { run_attempt: 2 }, { workflow_id: 902 }, { head_branch: 'feature' },
    { conclusion: 'success' }, { actor: { id: 1 } }, { status: 'in_progress' }]) assert.throws(() => admitOrigin({ ...original, ...changed }), /origin_rejected/);
});

test('artifact bytes and metadata must bind the exact admitted origin before TestOps authentication', () => {
  const archive = Buffer.from('synthetic archive');
  const expected = { id: 1, name: 'fixed', limit: 1024, sha256: createHash('sha256').update(archive).digest('hex') };
  const actual = { id: 1, name: 'fixed', size_in_bytes: archive.length, expired: false, digest: `sha256:${expected.sha256}`,
    workflow_run: { id: Number(origin.runId), head_sha: origin.workflowSha } };
  admitArtifact(actual, expected, archive);
  for (const changed of [{ id: 2 }, { name: 'other' }, { expired: true }, { digest: 'sha256:wrong' },
    { workflow_run: { id: 2, head_sha: origin.workflowSha } }]) assert.throws(() => admitArtifact({ ...actual, ...changed }, expected, archive), /artifact_rejected/);
  assert.throws(() => admitArtifact(actual, expected, Buffer.from('changed')), /artifact_rejected/);
  assert.throws(() => admitSelection(Buffer.from(JSON.stringify(selection))), /selection_rejected/);
});

test('fixed protected snapshot performs only the five known GETs and replays the unchanged verifier without replacing live environment', async () => {
  const before = { run: process.env.GITHUB_RUN_ID, source: process.env.GITHUB_SHA }, calls = [], values = responses();
  const result = await snapshotAndReplay(async (route, method) => { calls.push([route, method]); return values[routes.indexOf(route)]; }, selection, receipt);
  assert.deepEqual(calls, routes.map(route => [route, 'GET']));
  assert.equal(result.verification.verification, 'VERIFIED');
  assert.equal(result.verification.resultId, 2675);
  assert.equal(result.verification.runId, origin.runId);
  assert.deepEqual({ run: process.env.GITHUB_RUN_ID, source: process.env.GITHUB_SHA }, before);
  assert.equal(result.attachmentRows.rows.every(row => row.idPositiveSafeInteger && row.missed === false && row.fromTestCase === false), true);
});

test('actual three-way attachment row refusal retains the precise current protected flags without raw fields', async () => {
  for (const change of [{ id: '9274' }, { missed: true }, { fromTestCase: true }]) {
    const values = responses();
    Object.assign(values[4].content[0], change, { secret: 'do-not-retain', source: 'unknown-private-url' });
    const result = await snapshotAndReplay(async route => values[routes.indexOf(route)], selection, receipt);
    assert.equal(result.failure.verification.phase, change.missed === true ? 'attachment_readiness' : 'attachment_page');
    assert.equal(result.failure.verification.firstFailedPredicate,
      change.missed === true ? 'attachments_not_missed' : change.fromTestCase === true ? 'not_inherited' : 'ids_valid');
    const safe = JSON.stringify(result);
    assert.ok(!safe.includes('do-not-retain') && !safe.includes('unknown-private-url'));
    assert.equal(result.verification, undefined);
    if (typeof change.id === 'string') assert.equal(result.attachmentRows.rows[0].idType, 'string');
    if (change.missed === true) assert.equal(result.attachmentRows.rows[0].missed, true);
    if (change.fromTestCase === true) assert.equal(result.attachmentRows.rows[0].fromTestCase, true);
  }
  const safe = attachmentProjection({ content: [{ id: 1, name: 'raw secret name', contentType: 'raw secret type', missed: 'raw secret flag' }] });
  assert.ok(!JSON.stringify(safe).includes('raw secret'));
  assert.equal(safe.rows[0].missedType, 'string');
});

test('authoritative wrong job, wrong result jobrun and contradictory source remain failures during historical replay', async () => {
  for (const [mutate, expected] of [[values => { values[0].job.id = 35; }, 'chat_testops_jobrun_mismatch'],
    [values => { values[3].jobRun.id = 1032; }, 'chat_testops_upload_mismatch'],
    [values => { values[3].links = [{ url: 'https://github.com/paperclipai/paperclip/commit/' + 'b'.repeat(40) }]; }, 'chat_testops_upload_mismatch']]) {
    const values = responses(); mutate(values);
    const result = await snapshotAndReplay(async route => values[routes.indexOf(route)], selection, receipt);
    assert.equal(result.verification, undefined);
    assert.equal(result.failure.code, expected);
  }
});

test('real archive extraction admits only the fixed selection file and rejects traversal or symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-chat-archive-'));
  try {
    for (const kind of ['valid', 'traversal', 'symlink']) {
      const archive = path.join(root, `${kind}.zip`), target = path.join(root, kind);
      execFileSync('python3', ['-c', "import zipfile,sys; p,k=sys.argv[1:]; z=zipfile.ZipFile(p,'w'); n='testops-selection.json' if k!='traversal' else '../escaped'; i=zipfile.ZipInfo(n); i.external_attr=(0o120777 if k=='symlink' else 0o100600)<<16; z.writestr(i,b'{}'); z.close()", archive, kind]);
      if (kind === 'valid') { await extractArchive(archive, target, 'selection'); assert.equal(await readFile(path.join(target, 'testops-selection.json'), 'utf8'), '{}'); }
      else await assert.rejects(extractArchive(archive, target, 'selection'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manual workflow has no selection inputs or provider/upload path and retains closed receipts only', async () => {
  const yaml = await readFile(new URL('../../.github/workflows/chat-feature-testops-retained-verification.yml', import.meta.url), 'utf8');
  assert.match(yaml, /workflow_dispatch:/);
  assert.ok(!yaml.includes('inputs:') && !yaml.includes('allurectl') && !yaml.includes('OPENROUTER') && !yaml.includes('id-token: write'));
  assert.match(yaml, /environment: runner-e2e-testops-reporting/);
  assert.match(yaml, /ref: \$\{\{ github.sha \}\}/);
  assert.match(yaml, /chat-testops-retained-verification\/retained-verification.json/);
  assert.ok(!yaml.includes('safe-export\n') && !yaml.includes('selection.zip'));
});
