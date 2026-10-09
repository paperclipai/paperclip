/** Explicit live acceptance; real browser UI + Speko, synthetic microphone only.
 * Requires the disposable server and prior provider-persona authorization.
 * No Playwright traces: setup carries a provider credential.
 */
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const origin = `http://127.0.0.1:${Number(process.env.SPEKO_NATIVE_PORT ?? 3449)}`;
const privateRoot = resolve(homedir(), '.paperclip/speko-proof');
const resumeIssueId = process.env.SPEKO_NATIVE_RESUME_ISSUE_ID;
const diskScenario = process.env.SPEKO_NATIVE_SCENARIO === 'disk';
const delayedTemplate = process.env.SPEKO_NATIVE_SCENARIO === 'template-delayed';
const templateScenario = diskScenario || delayedTemplate || process.env.SPEKO_NATIVE_SCENARIO === 'template';
const expectedWord = process.env.SPEKO_NATIVE_EXPECTED_WORD ?? 'marigold';
const evidencePath = process.env.SPEKO_NATIVE_EVIDENCE_PATH;
if (delayedTemplate && !evidencePath) throw new Error('The delayed real-agent scenario requires SPEKO_NATIVE_EVIDENCE_PATH for durable follow-up assertions');
const fixturePath = process.env.SPEKO_NATIVE_FIXTURE_PATH ?? resolve(privateRoot, templateScenario ? 'native-template-fixture.json' : 'native-fixture.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const out = resolve(privateRoot, `native-browser-${Date.now()}`);
await mkdir(out, { mode: 0o700 });
const changedFiles = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hashes = {};
for (const file of changedFiles) { try { hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex'); } catch { hashes[file] = 'deleted'; } }
await writeFile(resolve(out, 'source.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), changedFiles: hashes }, null, 2), { mode: 0o600 });
const key = (await readFile(resolve(homedir(), '.secrets'), 'utf8')).match(/^export SPEKO_MCP_API_KEY=['"]([^'"]+)['"]/m)?.[1];
if (!key) throw new Error('Saved Speko credential missing');
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const events = [], started = Date.now();
const idleProbe = process.env.SPEKO_NATIVE_IDLE_PROBE === "1";
if (idleProbe) await page.route("**/voice-sessions/*/notification", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
let session, progress;
const event = (kind, details = {}) => { events.push({ kind, elapsedMs: Date.now() - started, ...details }); console.log(JSON.stringify({ kind, ...details })); };
page.on('response', async (response) => {
  if (response.request().method() === 'POST' && /\/voice-sessions$/.test(new URL(response.url()).pathname) && response.ok()) {
    const result = await response.json(); session = result.session;
    await writeFile(resolve(out, 'session.json'), JSON.stringify(session), { mode: 0o600 });
    event('session_created', { sessionId: session.id, issueId: session.issueId });
  }
});
await page.addInitScript(() => {
  const state = window.spekoFixture = { tracks: [], events: [], context: null, destination: null, chunks: [], recorder: null, audioEdges: [], recordingStartedAt: null };
  navigator.mediaDevices.getUserMedia = async () => {
    state.context ??= new AudioContext({ sampleRate: 48000 });
    await state.context.resume();
    if (!state.destination) {
      state.destination = state.context.createMediaStreamDestination();
      const silence = state.context.createConstantSource(); silence.offset.value = 0.00001; silence.connect(state.destination); silence.start(); state.silence = silence;
    }
    const stream = state.destination.stream.clone(); state.tracks.push(...stream.getTracks());
    return stream;
  };
  new MutationObserver(() => {
    const audio = [...document.querySelectorAll('audio')].find((node) => node.srcObject);
    if (!audio || state.recorder) return;
    state.recorder = new MediaRecorder(audio.srcObject);
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recordingStartedAt = Date.now();
    state.recorder.start();
    // Measure received audio, independently of the model's transcript/state.
    state.context ??= new AudioContext({ sampleRate: 48000 });
    const source = state.context.createMediaStreamSource(audio.srcObject);
    const analyser = state.context.createAnalyser(); analyser.fftSize = 1024;
    const sink = state.context.createGain(); sink.gain.value = 0;
    source.connect(analyser); analyser.connect(sink); sink.connect(state.context.destination);
    const samples = new Float32Array(analyser.fftSize); let audible = false;
    state.audioTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const next = rms > 0.01;
      if (next) state.lastAudibleAt = Date.now();
      if (next !== audible) { state.audioEdges.push({ at: Date.now(), audible: next }); audible = next; }
    }, 20);
  }).observe(document, { childList: true, subtree: true });
});
async function speak(name) {
  const audioPath = process.env.SPEKO_NATIVE_AUDIO_DIR ? resolve(process.env.SPEKO_NATIVE_AUDIO_DIR, `${name}.pcm`) : new URL(`../../.paperclip-local/speko-proof-audio/${name}.pcm`, import.meta.url);
  const bytes = [...await readFile(audioPath)];
  event('input_started', { name });
  await page.evaluate(async (bytes) => {
    const state = window.spekoFixture, raw = new DataView(new Uint8Array(bytes).buffer);
    const buffer = state.context.createBuffer(1, bytes.length / 2, 48000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = raw.getInt16(i * 2, true) / 32768;
    const source = state.context.createBufferSource(); source.buffer = buffer; source.connect(state.destination);
    await new Promise((done) => { source.onended = done; source.start(); }); source.disconnect();
  }, bytes);
  event('input_ended', { name });
}
try {
  await expect.poll(async () => fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false), { timeout: 30000 }).toBe(true);
  await page.goto(origin);
  if (resumeIssueId) {
    await page.goto(`${origin}/${fixture.companyPrefix}/issues/${resumeIssueId}`);
    await page.getByRole('button', { name: `Talk to ${fixture.agentName}`, exact: true }).click();
  } else if (process.env.SPEKO_NATIVE_CONNECTED === '1') {
    if (!fixture.endpointId) throw new Error('Connected qualification requires the verified endpoint fixture');
    const taskResponse = await page.request.post(`${origin}/api/companies/${fixture.companyId}/issues`, {headers: {Origin: origin}, data: {title: "Speko live browser qualification", assigneeAgentId: fixture.agentId, status: "backlog"}});
    if (!taskResponse.ok()) throw new Error(`Qualification task creation rejected (${taskResponse.status()})`);
    const task = await taskResponse.json();
    await page.goto(`${origin}/${fixture.companyPrefix}/issues/${task.id}`);
    await page.getByRole('button', {name: `Talk to ${fixture.agentName}`, exact: true}).click();
    event('qualification_task_created', {issueId: task.id});
    event('existing_connection_used', {endpointId: fixture.endpointId});
  } else {
  await page.getByRole('link', { name: 'Connectors', exact: true }).first().click();
  if (fixture.endpointId) {
    // Resume the saved setup using the same UI route after an earlier failed test.
    await page.goto(`${origin}/${fixture.companyPrefix}/apps/chat/connect?provider=speko&resume=${fixture.endpointId}`);
  } else {
    await page.locator('[data-app-slug="speko"]').getByRole('button', { name: /^(Connect Speko|Add connection Speko)$/ }).click();
    await page.getByRole('button', { name: 'Choose an active agent', exact: true }).click();
    await page.getByRole('button', { name: `Select ${fixture.agentName ?? 'Existing Paperclip Agent'}`, exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await expect(page.getByLabel('Speko API key', { exact: true }).or(page.getByRole('button', { name: 'Start voice', exact: true })).filter({ visible: true }).first()).toBeVisible({ timeout: 30000 });
  if (await page.getByLabel('Speko API key', { exact: true }).isVisible()) {
    await page.getByRole('textbox', { name: 'Speko agent ID', exact: true }).fill(fixture.providerAgentId);
    await page.getByLabel('Speko API key', { exact: true }).fill(key);
    const responsePromise = page.waitForResponse((r) => r.request().method() === 'POST' && /\/chat-endpoints\/[^/]+\/setup$/.test(new URL(r.url()).pathname), { timeout: 60000 });
    await page.getByRole('button', { name: /^(Connect|Reconnect) Speko$/ }).click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`Setup rejected (${response.status()}): ${(await response.json()).error}`);
    const endpoint = await response.json(); fixture.endpointId = endpoint.id;
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    event('native_setup_verified', { endpointId: endpoint.id, status: endpoint.status });
  }
  }
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: resolve(out, 'before-call.png'), fullPage: true });
  await writeFile(resolve(out, 'intent.json'), JSON.stringify({ action: 'start_browser_voice', at: new Date().toISOString(), endpointId: fixture.endpointId }), { mode: 0o600 });
  if (process.env.SPEKO_NATIVE_FRESH_CONVERSATION === '1') await page.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('new');
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeEnabled({ timeout: 30000 });
  expect(session?.assignedAgentId).toBe(fixture.agentId);
  event('media_connected');
  if (resumeIssueId) { expect(session?.issueId).toBe(resumeIssueId); event('existing_task_resumed', { issueId: resumeIssueId }); }
  progress = setInterval(() => { void page.locator('body').innerText().then((text) => writeFile(resolve(out, 'latest-visible.txt'), text, { mode: 0o600 })).catch(() => {}); }, 3000);
  await expect(page.getByRole('list', { name: 'Conversation transcript' }).getByRole('listitem')).not.toHaveCount(0, { timeout: 20000 });
  await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.spekoFixture.lastAudibleAt && Date.now() - window.spekoFixture.lastAudibleAt > 900, undefined, { timeout: 15000 });
  await speak(diskScenario ? 'disk-request' : resumeIssueId ? 'template-resume' : delayedTemplate ? 'template-delayed-start' : templateScenario ? 'template-start' : 'start');
  await expect(page.getByRole('status').filter({ hasText: /^Speaking$/ })).toBeVisible({ timeout: 20000 });
  event('acknowledgment_speaking');
  if (evidencePath) {
    await expect.poll(async () => {
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      return evidence.tools.filter(tool => tool.sessionId === session.id && tool.tool === 'submit_request' && tool.response?.status === 'accepted').length;
    }, { timeout: 20000 }).toBeGreaterThanOrEqual(1);
    event('first_request_durably_accepted');
  }
  if (diskScenario) await speak('disk-followup');
  if (!resumeIssueId && !diskScenario) await speak(delayedTemplate ? 'template-delayed-followup' : templateScenario ? 'template-followup' : 'followup');
  const transcript = page.getByRole('list', { name: 'Conversation transcript', exact: true });
  if (evidencePath && !resumeIssueId) {
    await expect.poll(async () => {
      try {
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
        return evidence.tools.filter((tool) => tool.sessionId === session.id && tool.tool === 'submit_request' && tool.response?.status === 'accepted').length;
      } catch { return 0; }
    }, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    event('followup_durably_accepted');
  }
  const agentTranscript = transcript.getByRole('listitem').filter({ has: page.locator('span').filter({ hasText: fixture.agentName ?? 'Existing Paperclip Agent' }) });
  await expect(agentTranscript).toContainText([diskScenario ? /(?:10|ten) gigabytes[\s\S]*?(?:9[.,]7|nine point seven) gigabytes/i : templateScenario ? new RegExp(expectedWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /verification number/i], { timeout: templateScenario ? 180000 : 100000 });
  if (diskScenario) {
    await expect.poll(async () => {
      const response = await page.request.get(`${origin}/api/issues/${session.issueId}/comments`);
      if (!response.ok()) return false;
      return (await response.json()).some(comment => comment.authorAgentId === fixture.agentId
        && Date.parse(comment.createdAt) >= started && /(?:disk|space|storage|filesystem)/i.test(comment.body)
        && /(?:available|free)/i.test(comment.body));
    }, {timeout: 180000}).toBe(true);
    event('real_agent_disk_result_persisted');
  }
  if (delayedTemplate) {
    await expect.poll(async () => {
      const response = await page.request.get(`${origin}/api/issues/${session.issueId}/comments`);
      if (!response.ok()) return false;
      return (await response.json()).some((comment) => comment.authorAgentId === fixture.agentId && /silver lantern/i.test(comment.body));
    }, { timeout: 60000 }).toBe(true);
    await expect(agentTranscript.filter({ hasText: new RegExp(expectedWord, "i") })).toContainText([/silver lantern/i], { timeout: 60000 });
    event('followup_applied_by_agent');
    const comments = await (await page.request.get(`${origin}/api/issues/${session.issueId}/comments`)).json();
    const runIds = [...new Set(comments.map((comment) => comment.createdByRunId).filter(Boolean))];
    const runs = await Promise.all(runIds.map(async (id) => (await page.request.get(`${origin}/api/heartbeat-runs/${id}`)).json()));
    const executionMs = Math.max(...runs.filter((run) => run.status === 'succeeded').map((run) => Date.parse(run.finishedAt) - Date.parse(run.startedAt)));
    expect(executionMs).toBeGreaterThanOrEqual(65000);
    event('real_delayed_execution_verified', { executionMs, runIds });
  }
  if (!templateScenario && evidencePath) {
    const executionPath = resolve(dirname(evidencePath), 'execution.jsonl');
    await expect.poll(async () => {
      const executions = (await readFile(executionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      return executions.some(run => run.event === 'completed' && run.issueId === session.issueId && run.elapsedMs >= 60_000 && run.requests >= 2);
    }, { timeout: 30_000 }).toBe(true);
    const executions = (await readFile(executionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const execution = executions.find(run => run.event === 'completed' && run.issueId === session.issueId);
    await expect.poll(async () => (await agentTranscript.allTextContents()).join(' ').replaceAll('*', '').includes(String(execution.number)), { timeout: 30_000 }).toBe(true);
    // Wait for the queued amendment to be retrieved too. Ending as soon as the
    // first answer appears would hide the very self-interruption being tested.
    await expect.poll(async () => {
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      return new Set(evidence.tools.filter(tool => tool.sessionId === session.id && tool.tool === 'get_updates').flatMap(tool => (tool.response?.updates ?? []).map(update => update.publicationId))).size;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    event('delayed_execution_and_two_publications_verified', { executionMs: execution.elapsedMs, requests: execution.requests, runId: execution.runId });
  }
  if (!templateScenario) await expect(transcript).toContainText(/(?:received|included)[\s\S]{0,100}(?:one|1)[\s\S]{0,60}follow.up|(?:one|1)[\s\S]{0,60}follow.up[\s\S]{0,100}(?:received|included)/i, { timeout: 30000 });
  await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible({ timeout: 30000 });
  await expect(agentTranscript.last()).not.toContainText(' · Speaking', { timeout: 30000 });
  await page.waitForFunction(() => window.spekoFixture.lastAudibleAt && Date.now() - window.spekoFixture.lastAudibleAt > 1800, undefined, { timeout: 20000 });
  event('delayed_result_visible');
  await page.screenshot({ path: resolve(out, 'delayed-result.png'), fullPage: true });
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.spekoFixture.tracks.every((track) => !track.enabled))).toBe(true);
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  event('mute_verified');
} catch (error) {
  event('failed', { message: error.message.replaceAll(key, '[redacted]') });
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(progress);
  try {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'unavailable');
  await writeFile(resolve(out, 'visible.txt'), text.replaceAll(key, '[redacted]'), { mode: 0o600 });
  const audio = await page.evaluate(async () => {
    const state = window.spekoFixture;
    if (!state?.recorder) return null;
    if (state.recorder.state !== 'inactive') await new Promise((done) => { state.recorder.onstop = done; state.recorder.stop(); });
    return [...new Uint8Array(await new Blob(state.chunks, { type: 'audio/webm' }).arrayBuffer())];
  }).catch(() => null);
  const audioMeasurements = await page.evaluate(() => {
    const state = window.spekoFixture; if (!state) return null;
    clearInterval(state.audioTimer);
    return { recordingStartedAt: state.recordingStartedAt, edges: state.audioEdges, resolutionMs: 20, rmsThreshold: 0.01 };
  }).catch(() => null);
  if (audioMeasurements) await writeFile(resolve(out, 'audio-measurements.json'), JSON.stringify(audioMeasurements), { mode: 0o600 });
  if (audio) await writeFile(resolve(out, 'received.webm'), Buffer.from(audio), { mode: 0o600 });
  if (session) {
    const button = page.getByRole('button', { name: /^(End call|Retry ending call)$/ });
    if (await button.count()) await button.click().catch(() => {});
    try {
      const response = await page.request.post(`${origin}/api/companies/${fixture.companyId}/voice-sessions/${session.id}/end`, { headers: { Origin: origin }, data: {} });
      event('end_requested', { status: response.status() });
      await expect.poll(async () => {
        const inspected = await page.request.get(`${origin}/api/companies/${fixture.companyId}/voice-sessions/${session.id}`);
        return inspected.ok() ? (await inspected.json()).state : 'unavailable';
      }, { timeout: 30000, intervals: [500, 1000, 2000] }).toMatch(/^(ended|failed|expired)$/);
      expect(await page.evaluate(() => window.spekoFixture.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
      event('cleanup_verified');
    } catch { event('cleanup_unconfirmed'); process.exitCode = 1; }
  }
  } catch { event('evidence_cleanup_failed'); process.exitCode = 1; } finally {
  try {
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ startedAt: new Date(started).toISOString(), events, session, browserNotificationDisabledForIdleProbe: idleProbe, syntheticMicrophone: true, audioReview: 'required independently; script success does not confirm complete spoken playback', resumedIssueId: resumeIssueId, diskScenario, delayedTemplate, expectedWord: templateScenario ? expectedWord : undefined, executionProvider: templateScenario ? 'claude_local' : 'fixture', server: 'real', speko: 'live' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: out }));
  } finally { await browser.close(); }
  }
}
