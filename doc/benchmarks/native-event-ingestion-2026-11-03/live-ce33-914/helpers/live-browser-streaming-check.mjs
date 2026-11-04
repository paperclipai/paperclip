import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Exact concrete native interstitial from retained914 trace after@call@120.
// Original trace SHA256: a6337930fdeeca5aca127bd7c028ed5cd92e754412e2a6157a8ac3678776f5bb
// No server, provider or network is used; only the real browser DOM selector runs.
const capturedInterstitial = ["DIV", {"class": "min-w-0 px-1 text-sm text-foreground/90", "data-testid": "task-chat-phase-interstitial", "data-conversation-text": "progress"}, ["DIV", {"class": "paperclip-markdown prose prose-sm min-w-0 max-w-full break-words overflow-hidden", "style": "overflow-wrap: anywhere; word-break: break-word;"}, ["P", {"style": "overflow-wrap: anywhere; word-break: break-word;"}, "The progress message was sent and ", ["CODE", {"style": "overflow-wrap: anywhere; word-break: break-word;"}, "list_task_documents"], " returned 0 documents on this task."], "\n", ["P", {"style": "overflow-wrap: anywhere; word-break: break-word;"}, "1"]]];
const source = await readFile(new URL('./live-browser.mjs', import.meta.url), 'utf8');
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let browser, page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route('**/*', route => route.abort());
});
after(async () => { await browser?.close(); });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function html(node) {
  if (typeof node === 'string') return escape(node);
  if (!Array.isArray(node) || typeof node[0] !== 'string') return '';
  return '<' + node[0] + Object.entries(node[1]).map(([name, value]) => ' ' + name + '="' + escape(value) + '"').join('')
    + '>' + node.slice(2).map(html).join('') + '</' + node[0] + '>';
}
const owned = content => '<main data-testid="issue-detail-content"><div data-testid="task-chat-thread">' + content + '</div></main>';
const observerStart = source.indexOf('const visibleAgentText = ');
const observerEnd = source.indexOf('const normalizeVisible = ', observerStart);
assert.ok(observerStart >= 0 && observerEnd > observerStart);
const readVisible = new AsyncFunction('page', source.slice(observerStart, observerEnd) + '\nreturn visibleAgentText();');

test('captured partial native interstitial is observed while the original selector misses it', async () => {
  await page.setContent(owned('<div data-testid="task-chat-live-transcript"><div data-testid="task-chat-runner-turn">'
    + '<section data-testid="task-chat-activity-phase">' + html(capturedInterstitial) + '</section></div></div>'));
  const oldSelector = '[data-conversation-message="agent"] [data-conversation-text]:visible, [data-testid="task-chat-live-self-talk"]:visible';
  assert.deepEqual(await page.locator(oldSelector).allInnerTexts(), []);
  assert.ok((await readVisible(page)).includes('The progress message was sent and'));
  assert.ok((await readVisible(page)).endsWith('1'));
});

test('normal live-tail text and settled agent messages remain observable', async () => {
  await page.setContent(owned('<div data-testid="task-chat-live-text" data-conversation-text="progress">Live tail partial</div>'
    + '<div data-conversation-message="agent"><div data-conversation-text="final">Settled result</div></div>'));
  assert.equal(await readVisible(page), 'Live tail partial\nSettled result');
});

test('hidden output, human prompts and a different thread cannot prove owned live text', async () => {
  await page.setContent(owned('<div style="display:none">' + html(capturedInterstitial) + '</div>'
    + '<div data-conversation-message="human"><div data-conversation-text="human">The progress message was sent and</div></div>')
    + '<aside data-testid="task-chat-thread">' + html(capturedInterstitial) + '</aside>');
  assert.equal(await readVisible(page), '');
});

async function observation({ phase = 'observed', status = 'running', finishedAt = null,
  accepted = false, completedItem = false, startedItem = true, terminal = false, kind = 'agentMessage' } = {}) {
  const start = source.indexOf('  const streaming = await poll(');
  const end = source.indexOf('  await page.screenshot(', start);
  const normalizer = source.split('\n').find(line => line.startsWith('const normalizeVisible = '));
  const summaryStart = source.indexOf('const runSummary = '), summaryEnd = source.indexOf('async function taskRuns(', summaryStart);
  assert.ok(start >= 0 && end > start && normalizer && summaryStart >= 0 && summaryEnd > summaryStart);
  const execute = new AsyncFunction('poll', 'taskRuns', 'visibleAgentText', 'eventsFor', 'api', 'created', 'journey', 'expect',
    normalizer + '\n' + source.slice(summaryStart, summaryEnd) + '\n' + source.slice(start, end) + '\nreturn journey;');
  const active = { id: 'owned-run', status: 'running', runtimeMode: 'native' };
  const identity = { runId: active.id, sourceInstanceId: 'source-1', turnId: 'turn-1', itemId: 'item-1' };
  const row = event => ({ eventType: event.eventType, payload: { prpEvent: { ...identity, ...event } } });
  const events = [
    ...(startedItem ? [row({ eventType: 'item.started', sourceEventId: 'started' })] : []),
    row({ eventType: 'item.delta', sourceEventId: 'delta-29', sourceSeq: 29, payload: { kind, text: 'The progress message was sent and' } }),
    ...(completedItem ? [row({ eventType: 'item.completed' })] : []),
    ...(accepted ? [row({ eventType: 'run.result.accepted' })] : []),
    ...(terminal ? [row({ eventType: 'run.terminal' })] : []),
  ];
  return execute(async (_label, load, accept) => {
    const value = await load();
    if (!accept(value)) throw new Error('streaming_observation_not_proven');
    return value;
  }, async () => [active], async () => 'The progress message was sent and', async () => events,
  async () => ({ ...active, status, nativePhase: phase, finishedAt }), { issueId: 'owned-issue' }, {},
  value => ({ toBe(expected) { assert.equal(value, expected); } }));
}

test('fresh running observation with a still-open ordinary item proves streaming', async () => {
  const value = await observation();
  assert.equal(value.visibleBeforeTerminal, true);
  assert.equal(value.visibleDelta.sourceEventId, 'delta-29');
  assert.equal(value.streamingRunStatuses[0].nativePhase, 'observed');
  // Native phases are not a closed verification allowlist.
  assert.equal((await observation({ phase: 'another_nonfinal_phase' })).visibleBeforeTerminal, true);
});

test('known finalization, accepted results, terminal state and closed items are rejected', async () => {
  for (const options of [{ phase: 'workspace_finalizing' }, { accepted: true }, { terminal: true },
    { completedItem: true }, { startedItem: false }, { status: 'succeeded' }, { finishedAt: 'fixture-time' }, { kind: 'reasoning' }]) {
    await assert.rejects(observation(options), /streaming_observation_not_proven/);
  }
});
