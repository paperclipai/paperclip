import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const statePath = process.argv[2];
assert(statePath && path.isAbsolute(statePath));
const guard = globalThis[Symbol.for('paperclip.skill.default-cadence.prewire')];
assert(guard?.stats().loaded && guard.stats().pid === process.pid, 'Actual agent process requires prewire before imports');
const originPath = process.env.STATUS_OBJECT_EXPECTED_API_ORIGIN_FILE;
assert(originPath && path.isAbsolute(originPath), 'Expected fixture API origin file is required');
const expectedOrigin = await readFile(originPath, 'utf8');
const expected = new URL(expectedOrigin);
assert(expected.protocol === 'http:' && expected.hostname === '127.0.0.1' && expected.port
  && expected.pathname === '/' && !expected.username && !expected.password && !expected.search && !expected.hash);
assert.equal(expectedOrigin, expected.origin, 'Expected fixture API origin must be canonical');
const base = new URL(process.env.PAPERCLIP_API_URL);
assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.pathname === '/'
  && !base.username && !base.password && !base.search && !base.hash);
assert.equal(base.origin, expected.origin, 'Product-provided API origin must match the actual fixture server port');
const token = process.env.PAPERCLIP_API_KEY, runId = process.env.PAPERCLIP_RUN_ID;
assert(token && runId && process.env.PAPERCLIP_AGENT_ID && process.env.PAPERCLIP_COMPANY_ID);
guard.allowOrigin(base.origin);
const receipt = async event => appendFile(statePath + '.runs.jsonl', JSON.stringify({ event, at: Date.now(), pid: process.pid, runId, providedApiOrigin: base.origin, expectedApiOrigin: expected.origin,
  companyId: process.env.PAPERCLIP_COMPANY_ID, agentId: process.env.PAPERCLIP_AGENT_ID, guard: guard.stats() }) + '\n');
await receipt('started');
let state;
const readyBy = Date.now() + 10_000;
while (!state?.cardId && Date.now() < readyBy) {
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state?.cardId) await delay(25);
}
assert(state?.cardId && Number.isSafeInteger(state.revision) && state.revision > 0, 'Producer must publish the actual returned card id');
async function api(method, route, body) {
  const response = await fetch(new URL('/api' + route, base), {
    method, signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, 'X-Paperclip-Run-Id': runId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `Authorized status writer API ${method} returned ${response.status}`);
  return response.json();
}
const card = await api('GET', `/status-cards/${state.cardId}`);
assert.equal(card.companyId, process.env.PAPERCLIP_COMPANY_ID);
assert.equal(card.agentId, process.env.PAPERCLIP_AGENT_ID);
assert(card.generatingIssueId);
const generation = await api('GET', `/issues/${card.generatingIssueId}`);
assert.equal(generation.assigneeAgentId, process.env.PAPERCLIP_AGENT_ID);
assert(generation.checkoutRunId === runId || generation.executionRunId === runId, 'Normal dispatcher must own the generation run');
if (card.state === 'compiling') await api('PUT', `/status-cards/${card.id}/query`, {
  queries: [{ scope: 'issues', status: ['blocked'] }], title: 'Current blockers',
  changeSummary: 'Compiled the normal blocked-issue query', generationIssueId: generation.id,
});
const preview = await api('GET', `/status-cards/${card.id}/dry-run`);
assert.equal(preview.cardId, card.id);
assert(Array.isArray(preview.queries));
const facts = preview.queries.flatMap(page => {
  assert(Array.isArray(page.result?.results));
  return page.result.results;
}).map(result => {
  assert.equal(result.type, 'issue');
  assert(result.issue && typeof result.issue.id === 'string' && typeof result.issue.title === 'string');
  assert(typeof result.issue.identifier === 'string');
  return `${result.issue.identifier}: ${result.issue.title}`;
});
assert(facts.length > 0, 'Useful summary must describe actual normal company-search results');
const markdown = `Useful status revision ${state.revision}.\n\n${facts.join('\n')}`;
const summary = await api('PUT', `/status-cards/${card.id}/summary`, {
  markdown,
  changeSummary: `Observed revision ${state.revision} through the actual query`,
  generationIssueId: generation.id, model: 'controlled-local-status-model',
});
assert.equal(summary.card.id, card.id);
assert.equal(summary.card.companyId, process.env.PAPERCLIP_COMPANY_ID);
assert.equal(summary.card.state, 'active');
assert.equal(summary.card.generatingIssueId, null);
assert.equal(summary.document.latestBody, markdown);
const completed = await api('PATCH', `/issues/${generation.id}`, { status: 'done' });
assert.equal(completed.id, generation.id);
assert.equal(completed.companyId, process.env.PAPERCLIP_COMPANY_ID);
assert.equal(completed.status, 'done');
await receipt('completed');
console.log(JSON.stringify({ event: 'status-interval-agent-completed', at: Date.now(), pid: process.pid,
  runId, generationIssueId: generation.id, cardId: card.id, revision: state.revision, guard: guard.stats() }));
