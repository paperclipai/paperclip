import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './chat-feature-testops-cli.mjs';
import { fullName, planName } from './chat-feature-testops-api.mjs';
const context = { GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master' };

test('actual metadata bootstrap caller creates no result or agent and reuses exact case/plan', async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'testops-bootstrap-')));
  t.after(() => rm(temporary, { recursive: true }));
  const state = path.join(temporary, 'state'), requests = [];
  const eventPath = path.join(temporary, 'event.json'); await writeFile(eventPath, JSON.stringify({ inputs: { operation: 'bootstrap', ALLURE_JOB_RUN_ID: '' } }));
  const response = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method });
    if (url.endsWith('/api/uaa/oauth/token')) return response({ access_token: 'SYNTHETIC_BEARER' });
    const route = new URL(url).pathname;
    if (route === '/api/testcase') return response({ number: 0, totalPages: 1, totalElements: 1, content: [{ id: 91, name: 'Not projected', automated: true }] });
    if (route === '/api/testcase/91') return response({ id: 91, projectId: 1, fullName, automated: true });
    if (route === '/api/testplan') return response({ totalPages: 1, content: [{ id: 8, projectId: 1, name: planName, testCasesCount: 1 }] });
    if (route === '/api/integration/project/1') return response({ totalPages: 1, content: [] });
    if (route === '/api/jobrun/9') return response({ id: 9, job: { id: 7 }, launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' });
    if (route === '/api/job/7') return response({ id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml', parameters: [{ id: 17, value: 'bootstrap' }] });
    if (route === '/api/environment/17') return response({ id: 17, name: 'operation' });
    assert.equal(route, '/api/testplan/8');
    return response({ id: 8, projectId: 1, name: planName, testCasesCount: 1, treeSelection: { leafsInclude: [91], inverted: false } });
  };
  assert.equal(await run({ ...context, RUNNER_TEMP: temporary, CHAT_TESTOPS_STATE_ROOT: state,
    CHAT_TESTOPS_OPERATION: 'bootstrap', GITHUB_EVENT_PATH: eventPath, ALLURE_JOB_RUN_ID: '9', ALLURE_TOKEN: 'SYNTHETIC_API_TOKEN' }, fetchImpl), 0);
  const plan = JSON.parse(await readFile(path.join(state, 'plan.json')));
  assert.equal(plan.actualResult, null);
  assert.equal(requests.filter(value => value.method === 'POST').length, 1, 'only auth token exchange; no case/plan write');
  await assert.rejects(readFile(path.join(state, 'allure-results.json')), { code: 'ENOENT' });
});

test('actual public caller retains only safe auth status on failure before discovery', async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'testops-failure-')));
  t.after(() => rm(temporary, { recursive: true }));
  const messages = [], original = process.stderr.write;
  process.stderr.write = value => { messages.push(String(value)); return true; };
  try {
    const state = path.join(temporary, 'state');
    const eventPath = path.join(temporary, 'event.json'); await writeFile(eventPath, JSON.stringify({ inputs: { operation: 'bootstrap' } }));
    assert.equal(await run({ ...context, RUNNER_TEMP: temporary, CHAT_TESTOPS_STATE_ROOT: state,
      CHAT_TESTOPS_OPERATION: 'bootstrap', GITHUB_EVENT_PATH: eventPath, ALLURE_TOKEN: 'SYNTHETIC_PRIVATE_TOKEN' },
      async () => ({ ok: false, status: 403, text: () => assert.fail('must not read denial body') })), 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(state, 'failure.json'))), { stage: 'authentication', code: 'testops_auth_http', httpStatus: 403 });
    assert.ok(!messages.join('').includes('SYNTHETIC_PRIVATE_TOKEN'));
  } finally { process.stderr.write = original; }
});


test('original TestOps-triggered bootstrap is rejected even if its official environment is populated', async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'testops-wrong-bootstrap-')));
  t.after(() => rm(temporary, { recursive: true }));
  const event = path.join(temporary, 'event.json'); await writeFile(event, JSON.stringify({ inputs: { operation: 'bootstrap', ALLURE_JOB_RUN_ID: '9' } }));
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await run({ ...context, GITHUB_EVENT_PATH: event, RUNNER_TEMP: temporary, CHAT_TESTOPS_STATE_ROOT: path.join(temporary, 'state'),
      CHAT_TESTOPS_OPERATION: 'bootstrap', ALLURE_JOB_RUN_ID: '9' }, () => assert.fail('no API access')), 1);
  } finally { process.stderr.write = original; }
});
