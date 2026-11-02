import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, realpath, cp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fullCatalogCases, catalogTargetSha } from './chat-full-catalog-testops-manifest.mjs';
import { hash, model } from './chat-completion-testops-contract.mjs';
import { run } from './chat-completion-testops-cli.mjs';
import { prepareCaseBundle, readCaseBundle, publishCaseBundle, publicationSet } from './chat-catalog-testops-streaming.mjs';
const context = { catalog: 'full', runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha: catalogTargetSha };
const caseIds = { 'tasks.create-backlog': 388, 'documents-artifacts.write-plan': 26, 'projects.project-defaults': 100 };
const cases = fullCatalogCases.filter(row => Object.hasOwn(caseIds, row.key)).map(row => ({ ...row, caseId: caseIds[row.key] }));
const selection = { schema: 'paperclip.chat-completion-testops-selection/v1', ...context, projectId: 1,
  planId: 102, jobId: 100, launchId: 12, allureJobRunId: '77', cases };
const digest = hash(JSON.stringify(selection)), current = cases.find(row => row.caseId === 388), runUrl = 'https://github.com/paperclipai/paperclip/actions/runs/123';
async function fixture(t, failed = false, owned = current) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'chat-stream-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'projection'), output = path.join(base, 'allure'); await mkdir(root);
  const original = { executionId: owned.executionId, suiteId: 'chat-features', caseId: owned.scenario,
    profileId: 'runner-opencode', provider: 'opencode', environmentId: 'local', model, runtimeMode: 'native', attempt: 1,
    source: { sha: catalogTargetSha, workflowRunUrl: runUrl }, status: failed ? 'failed' : 'passed', cleanup: failed ? 'failed' : 'passed',
    runIds: failed ? [] : Array.from({ length: owned.minimumRuns }, (_, i) => `synthetic-owned-run-${i}`), matcherResults: failed ? [] : Array.from({ length: owned.checks ?? 2 }, (_, i) => ({
      matcher: { kind: 'json_path', path: `owned.check${i}`, expected: true }, passed: true })), screenshots: [] };
  const files = new Map([['normalized-results.json', Buffer.from(JSON.stringify({ schema: 'paperclip.runner-e2e.campaign/v2',
    campaignId: 'gha-123-1', retries: 0, results: [original] }))], ['junit.xml', Buffer.from('<testsuite/>')]]);
  const binding = { schema: 'paperclip.chat-completion-testops-export/v1', ...context, campaignId: 'gha-123-1',
    executionIds: [owned.executionId], files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })),
    privateEvidence: [{ executionId: owned.executionId, requiredEvidenceComplete: !failed,
      finalScreenshot: failed ? null : { sha256: 'e'.repeat(64), bytes: 24 } }] };
  for (const [name, bytes] of files) await writeFile(path.join(root, name), bytes);
  await writeFile(path.join(root, 'binding.json'), JSON.stringify(binding));
  const prepared = await prepareCaseBundle(root, output, context, selection, owned.executionId, digest);
  return { root, output, prepared };
}
function server(prepared, { existing = false, uncertain = false, apply = true } = {}) {
  let present = existing, posts = 0; const calls = [];
  const api = async (route, method = 'GET', body) => {
    calls.push({ route, method });
    if (method === 'POST') {
      posts++; assert.equal(route, '/api/jobrun/77/upload');
      assert.deepEqual([...body.keys()], ['file','file','file']);
      const result = [...body.values()].find(value => value.name.endsWith('-result.json'));
      const parsed = JSON.parse(await result.text());
      assert.equal(parsed.status, prepared.exported[0].status); assert.equal(parsed.labels[0].value, '388');
      if (apply) present = true;
      if (uncertain) throw new Error('SYNTHETIC_PRIVATE_RESPONSE_MUST_NOT_ESCAPE');
      return { filesCount: 3 };
    }
    if (route === '/api/jobrun/77') return { id: 77, job: { id: 100, type: 'github' }, stage: 'finished', launchId: 12, url: runUrl };
    if (route === '/api/launch/12') return { id: 12, projectId: 1, closed: false };
    if (route.startsWith('/api/testresult?')) return { content: [...(present ? [{ id: 501, testCaseId: 388 }] : []),
      { id: 502, testCaseId: 26 }], totalElements: present ? 2 : 1, totalPages: 1, number: 0 };
    if (route === '/api/testresult/501') return { id: 501, testCaseId: 388, projectId: 1, launchId: 12,
      fullName: current.fullName, status: prepared.exported[0].status, jobRun: { id: 77, launchId: 12, url: runUrl }, links: [] };
    if (route.startsWith('/api/testresult/attachment?')) return { content: prepared.exported[0].attachments.map((row, index) => ({
      ...row, id: 700 + index, missed: false, fromTestCase: false })), totalElements: 2, totalPages: 1 };
    throw new Error(`Unexpected test route ${route}`);
  };
  return { api, calls, get posts() { return posts; } };
}
const immediate = { now: () => 0, wait: async () => {} };
async function publish(f, s, mark = async () => {}) {
  return publishCaseBundle(s.api, f.root, f.output, f.prepared, context, selection, current.executionId, digest, mark, immediate);
}
test('one frozen singleton bundle publishes into the bound shared launch beside siblings', async t => {
  const f = await fixture(t), s = server(f.prepared); let markers = 0;
  const names = await readdir(f.output), value = await publish(f, s, async () => { markers++; });
  assert.equal(value.verification, 'VERIFIED'); assert.equal(markers, 1); assert.equal(s.posts, 1);
  assert.equal(value.jobRunStageBefore, 'finished'); assert.equal(value.jobRunStageAfter, 'finished');
  assert.deepEqual(await readdir(f.output), names);
  await assert.rejects(prepareCaseBundle(f.root, f.output, context, selection, current.executionId, digest), /allure_output/);
});
test('an existing result is verified without another mutation or a regenerated UUID', async t => {
  const f = await fixture(t), s = server(f.prepared, { existing: true });
  const value = await publish(f, s, async () => assert.fail('must not mark another upload'));
  assert.equal(value.uploadSent, false); assert.equal(s.posts, 0); assert.equal(value.verification, 'VERIFIED');
});
test('an uncertain applied upload reconciles by GET while an absent upload stops without resend', async t => {
  for (const apply of [true, false]) {
    const f = await fixture(t), s = server(f.prepared, { uncertain: true, apply });
    if (apply) {
      const value = await publish(f, s); assert.equal(value.verification, 'VERIFIED');
      assert.equal(value.uncertainUpload.kind, 'transport_or_response_failure');
      assert.ok(!JSON.stringify(value).includes('SYNTHETIC_PRIVATE'));
    } else await assert.rejects(publish(f, s), error => error.message === 'chat_completion_testops_stream_upload_uncertain'
      && !JSON.stringify(error).includes('SYNTHETIC_PRIVATE'));
    assert.equal(s.posts, 1);
  }
});
test('failed originals remain failed, including zero-run setup or cleanup failure', async t => {
  const f = await fixture(t, true), s = server(f.prepared), value = await publish(f, s);
  assert.equal(value.exported.status, 'failed'); assert.equal(value.exported.cleanup, 'failed');
  assert.equal(value.verification, 'VERIFIED');
});
test('changed bundle bytes, source, selection digest and foreign case refuse before transport', async t => {
  const f = await fixture(t); let calls = 0;
  const noApi = async () => { calls++; assert.fail('untrusted bundle must not reach API'); };
  await assert.rejects(publishCaseBundle(noApi, f.root, f.output, f.prepared, { ...context, workflowSha: 'b'.repeat(40) }, selection,
    current.executionId, digest, async () => {}), /selection_binding/);
  await assert.rejects(readCaseBundle(f.root, f.output, f.prepared, context, selection, current.executionId, 'b'.repeat(64)), /stream_binding/);
  await assert.rejects(readCaseBundle(f.root, f.output, f.prepared, context, selection, 'foreign', digest), /stream_scope/);
  await writeFile(path.join(f.output, f.prepared.files[0].name), 'SYNTHETIC_PRIVATE_TAMPER');
  await assert.rejects(publishCaseBundle(noApi, f.root, f.output, f.prepared, context, selection, current.executionId, digest, async () => {}), /stream_bundle/);
  assert.equal(calls, 0);
});

 test('final coverage authenticates existing per-case bytes and keeps mixed original grades without re-export', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'chat-stream-final-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bundles = path.join(base, 'bundles'), publications = path.join(base, 'publications');
  await mkdir(bundles); await mkdir(publications);
  for (const [index, row] of cases.entries()) {
    const f = await fixture(t, index === 1, row);
    const bundle = path.join(bundles, `chat-catalog-case-bundle-123-1-${index}`);
    const receipt = path.join(publications, `chat-catalog-case-publication-123-1-${index}`);
    await mkdir(bundle); await mkdir(receipt);
    await cp(f.root, path.join(bundle, 'projection'), { recursive: true });
    await cp(f.output, path.join(bundle, 'allure'), { recursive: true });
    await writeFile(path.join(bundle, 'prepared.json'), JSON.stringify(f.prepared));
    await writeFile(path.join(receipt, 'publication.json'), JSON.stringify({ ...f.prepared,
      schema: 'paperclip.chat-catalog-testops-case-publication/v1', exported: f.prepared.exported[0],
      verification: 'VERIFIED', results: [{ executionId: row.executionId, caseId: row.caseId, attachmentsVerified: true }] }));
  }
  const rows = await publicationSet(bundles, publications, context, selection, digest);
  assert.deepEqual(rows.map(row => row.status), ['passed','failed','passed']);
  const receiptPath = path.join(publications, 'chat-catalog-case-publication-123-1-1', 'publication.json');
  const bad = JSON.parse(await readFile(receiptPath)); bad.exported.status = 'passed';
  await writeFile(receiptPath, JSON.stringify(bad));
  await assert.rejects(publicationSet(bundles, publications, context, selection, digest), /stream_publications/);
  await rm(path.dirname(receiptPath), { recursive: true });
  await assert.rejects(publicationSet(bundles, publications, context, selection, digest), /stream_publications/);
});

test('the real CLI prepares without TestOps credentials and retains closed failed or uncertain publication witnesses', async t => {
  for (const uncertain of [false, true]) {
  const f = await fixture(t, true), base = path.dirname(f.root);
  await rm(f.output, { recursive: true });
  const selectionRoot = path.join(base, 'chat-completion-testops-selection'); await mkdir(selectionRoot);
  await writeFile(path.join(selectionRoot, 'testops-pilot-selection.json'), JSON.stringify(selection));
  const event = { repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' },
    ref: 'refs/heads/master', sender: { id: 42 }, inputs: { operation: 'evaluate', ALLURE_JOB_RUN_ID: '77' } };
  const eventPath = path.join(base, 'event.json'); await writeFile(eventPath, JSON.stringify(event));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: event.repository.full_name,
    GITHUB_REF: event.ref, GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-catalog-testops.yml@refs/heads/master',
    GITHUB_SHA: context.workflowSha, GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_ACTOR_ID: '42',
    TESTOPS_ALLOWED_ACTOR_IDS: '[42]', GITHUB_RUN_NUMBER: '1', GITHUB_EVENT_PATH: eventPath,
    GH_TOKEN: 'SYNTHETIC_GITHUB_SECRET', RUNNER_TEMP: base, GITHUB_WORKSPACE: base, ALLURE_JOB_RUN_ID: '77',
    ALLURE_RESULTS: f.output, CHAT_TESTOPS_EXECUTION_ID: current.executionId, EXPECTED_SELECTION_SHA256: digest };
  const exec = async () => ({ stdout: JSON.stringify({ id: 123, run_attempt: 1, run_number: 1, workflow_id: 99,
    head_sha: context.workflowSha, head_branch: 'master', event: 'workflow_dispatch', path: '.github/workflows/chat-catalog-testops.yml',
    repository: event.repository, actor: { id: 42 }, triggering_actor: { id: 42 } }) });
  assert.equal(await run('prepare-case-upload', f.root, env, { exec, fetchImpl: () => assert.fail('reader must not authenticate to TestOps') }), 0);
  const preparedPath = path.join(base, 'chat-completion-testops-prepare-case-upload', 'prepared.json');
  const prepared = JSON.parse(await readFile(preparedPath)), s = server(prepared, { uncertain, apply: !uncertain });
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/uaa/oauth/token')) return Response.json({ access_token: 'SYNTHETIC_ACCESS_TOKEN' });
    if (uncertain && s.posts && new URL(url).pathname === '/api/jobrun/77') return Response.json({ id: 78 });
    return Response.json(await s.api(new URL(url).pathname + new URL(url).search, options.method, options.body));
  };
  let captured = ''; const capture = t.mock.method(process.stderr, 'write', value => { captured += value; return true; });
  assert.equal(await run('upload-case', f.root, { ...env, ALLURE_TOKEN: 'SYNTHETIC_TESTOPS_SECRET',
    CHAT_TESTOPS_PREPARED_FILE: preparedPath }, { exec, fetchImpl }), 1);
  capture.mock.restore();
  const state = path.join(base, 'chat-completion-testops-upload-case');
  assert.equal(s.posts, 1);
  const receipt = JSON.parse(await readFile(path.join(state, uncertain ? 'failure.json' : 'publication.json')));
  if (uncertain) {
    assert.equal(receipt.code, 'chat_completion_testops_stream_upload_uncertain');
    assert.equal(receipt.uploadFailure.kind, 'transport_or_response_failure');
    await assert.rejects(readFile(path.join(state, 'publication.json')), { code: 'ENOENT' });
  } else { assert.equal(receipt.verification, 'VERIFIED'); assert.equal(receipt.exported.status, 'failed'); }
  assert.deepEqual(JSON.parse(await readFile(path.join(state, 'once-upload_case.json'))),
    { stage: 'upload_case', status: 'STARTED_NO_AUTOMATIC_RESEND' });
  assert.doesNotMatch(captured + JSON.stringify(receipt), /SYNTHETIC_|ACCESS_TOKEN/);
  const yaml = await readFile(new URL('../../.github/workflows/chat-catalog-testops-case.yml', import.meta.url), 'utf8');
  for (const filename of ['publication.json', 'failure.json', 'once-upload_case.json']) {
    assert.ok(yaml.includes(`/chat-completion-testops-upload-case/${filename}`));
  }
  }
});

test('source host admission follows only the fixed same-commit callee with empty caller secret placeholders', async () => {
  const { parse } = await import('yaml');
  const { paidWorker } = await import('./chat-completion-testops-host-control.mjs');
  const main = parse(await readFile(new URL('../../.github/workflows/chat-catalog-testops.yml', import.meta.url), 'utf8'));
  const callee = parse(await readFile(new URL('../../.github/workflows/chat-catalog-testops-case.yml', import.meta.url), 'utf8'));
  assert.equal(paidWorker(main, callee).environment, 'runner-e2e-private-paid');
  for (const change of [
    value => { value.jobs.chat.uses = 'foreign/repository/workflow.yml@master'; },
    value => { value.jobs.chat.secrets = 'inherit'; },
    value => { value.jobs.chat_external.secrets.ALLURE_TOKEN = '${{ secrets.ALLURE_TOKEN }}'; },
    value => { value.jobs.chat.with.selection_sha256 = 'arbitrary'; },
  ]) { const mutant = structuredClone(main); change(mutant); assert.throws(() => paidWorker(mutant, callee), /boundary/); }
  const wrong = structuredClone(callee); wrong.jobs.chat.environment = 'runner-e2e-testops-reporting';
  assert.throws(() => paidWorker(main, wrong), /boundary/);
});
