import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./in-feed-codex.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('./native-ingestion-bin/codex', import.meta.url));
const output = process.argv[2];
assert.ok(output, 'Pass an owned output JSON path');
const reports = [];
assert.equal(spawnSync(process.execPath, [fixture, '--version'], { encoding: 'utf8' }).stdout.trim(), 'codex-cli 0.115.0 (in-feed fixture)');

async function run({ name, count, intervalMs = 0, stopAfter, clockStatus = 200, prelude = 0 }) {
  const nonce = randomUUID().replaceAll('-', ''), key = randomUUID().replaceAll('-', ''), markerCode = 'q7';
  const messages = [], emissions = [], clockRecords = [], deltas = [];
  let clockPosts = 0, gateGets = 0, hello, pendingGate, clockResponse, clockEnded = false;
  let terminal, interruptRequestedAt, interruptAcknowledgedAt, uploadResponseAt, completedItem;
  let epochMs, stderr = '', failure, child, finished = false;
  const fail = error => { failure ??= error; child?.kill('SIGTERM'); };
  const maybeGate = () => {
    if (!hello || !pendingGate) return;
    epochMs = Date.now() + 25;
    pendingGate.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ epochMs }));
    pendingGate = null;
  };
  const maybeFinishUpload = () => {
    if (!clockEnded || !terminal || !clockResponse || (stopAfter && !interruptAcknowledgedAt)) return;
    uploadResponseAt = Date.now();
    clockResponse.writeHead(clockStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ received: emissions.length }));
    clockResponse = null;
    child.stdin.end();
  };
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      assert.equal(url.searchParams.get('participant'), nonce);
      if (req.method === 'POST' && url.pathname === `/native-ingestion-gate/${key}/clock`) {
        clockPosts++;
        clockResponse = res;
        let buffer = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          try {
            buffer += chunk;
            while (buffer.includes('\n')) {
              const cut = buffer.indexOf('\n'), record = JSON.parse(buffer.slice(0, cut));
              buffer = buffer.slice(cut + 1); clockRecords.push(record);
              if (record.type === 'hello') { assert.equal(hello, undefined); hello = record; maybeGate(); }
              else { assert.equal(record.type, 'emission'); emissions.push(record); }
            }
          } catch (error) { fail(error); }
        });
        req.on('end', () => { assert.equal(buffer, ''); clockEnded = true; maybeFinishUpload(); });
      } else {
        assert.equal(req.method, 'GET');
        assert.equal(url.pathname, `/native-ingestion-gate/${key}`);
        gateGets++; pendingGate = res; maybeGate();
      }
    } catch (error) { res.writeHead(500).end(); fail(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gate = `http://127.0.0.1:${server.address().port}/native-ingestion-gate/${key}`;
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  child = spawn(wrapper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', value => { stderr += value; });
  const watchdog = setTimeout(() => fail(new Error(`${name}: qualification watchdog`)), 10_000);
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line); messages.push({ at: Date.now(), message });
      if (message.id === 'initialize') send({ id: 'thread', method: 'thread/start', params: { model: 'fixture' } });
      else if (message.id === 'thread') {
        // Match the normal nested brief plus Markdown punctuation escaping.
        const prompt = `INGESTION_PERF nonce=${nonce} events=${count} intervalMs=${intervalMs} prelude=${prelude} markerCode=${markerCode} gate=${gate}`;
        const escaped = prompt.replaceAll('_', '\\_').replaceAll('=', '\\=');
        send({ id: 'turn', method: 'turn/start', params: { input: [{ type: 'text', text: JSON.stringify({ message: JSON.stringify({ objective: escaped }) }) }] } });
      } else if (message.method === 'item/agentMessage/delta' && message.params.itemId.startsWith('ingestion-')) {
        deltas.push({ delta: message.params.delta, at: Date.now() });
        if (stopAfter && deltas.length === stopAfter) {
          interruptRequestedAt = Date.now();
          send({ id: 'stop', method: 'turn/interrupt' });
        }
      } else if (message.method === 'item/completed' && message.params.item.id.startsWith('ingestion-')) completedItem = message.params.item;
      else if (message.method === 'item/tool/call') {
        assert.ok(completedItem, 'Assistant completion must precede semantic tools');
        assert.equal(uploadResponseAt, undefined, 'Tools must run before clock upload completes');
        send({ id: message.id, result: {} });
      } else if (message.id === 'stop') {
        interruptAcknowledgedAt = Date.now();
        assert.equal(uploadResponseAt, undefined, 'Stop acknowledgement cannot wait for clock upload');
        maybeFinishUpload();
      } else if (message.method === 'turn/completed') {
        terminal = message.params.turn;
        assert.equal(uploadResponseAt, undefined, 'Protocol terminal cannot wait for clock upload');
        maybeFinishUpload();
      }
    } catch (error) { fail(error); }
  });
  send({ id: 'initialize', method: 'initialize' });
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(watchdog); finished = true;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (failure) throw failure;
  assert.equal(exit.code, clockStatus === 200 ? 0 : 1, stderr);
  assert.equal(clockPosts, 1); assert.equal(gateGets, 1);
  assert.deepEqual(hello, { type: 'hello', nonce, markerCode, events: count, intervalMs,
    launcher: 'host-local', providerPid: child.pid });
  assert.equal(emissions.length, deltas.length);
  assert.ok(deltas.length > 0);
  for (let index = 0; index < emissions.length; index++) {
    const event = emissions[index];
    assert.deepEqual({ ...event, emittedMs: 0 }, { type: 'emission', nonce, markerCode, index, intendedMs: epochMs + index * intervalMs, emittedMs: 0 });
    assert.ok(event.emittedMs <= deltas[index].at);
    assert.equal(deltas[index].delta, `[${markerCode}${index.toString(36)}] `);
  }
  if (stopAfter) {
    assert.equal(terminal.status, 'interrupted'); assert.ok(interruptAcknowledgedAt);
    assert.ok(deltas.length >= stopAfter && deltas.length < count);
    assert.ok(uploadResponseAt >= interruptAcknowledgedAt);
    assert.equal(completedItem, undefined);
  } else {
    assert.equal(terminal.status, 'completed'); assert.equal(deltas.length, count);
    assert.equal(completedItem.text, deltas.map(item => item.delta).join(''));
    if (count === 512) assert.equal(completedItem.text.length, 3548);
    const tools = messages.filter(row => row.message.method === 'item/tool/call').map(row => row.message.params.tool);
    assert.deepEqual(tools, ['report_progress', 'paperclip_finish']);
  }
  if (clockStatus !== 200) assert.match(stderr, /Ingestion fixture clock .*HTTP 503/);
  reports.push({ name, exit, count, emitted: deltas.length, clockPosts, clockRecords: clockRecords.length,
    launcher: hello.launcher, providerPid: hello.providerPid,
    completedTextCharacters: completedItem?.text.length, terminal: terminal.status,
    uploadHeldUntilAfterTerminal: true, stopAcknowledgedBeforeUploadResponse: stopAfter ? true : undefined,
    explicitClockError: clockStatus !== 200 ? stderr.trim() : undefined });
}
try {
  await run({ name: 'full-512-with-prelude', count: 512, prelude: 8 });
  await run({ name: 'interrupt-with-held-clock-response', count: 512, intervalMs: 10, stopAfter: 3 });
  await run({ name: 'explicit-upload-error', count: 16, clockStatus: 503 });
  const proof = { fixture, fixtureSha256: createHash('sha256').update(await readFile(fixture)).digest('hex'), reports, passed: true };
  await writeFile(output, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} catch (error) {
  await writeFile(output, JSON.stringify({ fixture, reports, passed: false, error: error.stack }, null, 2) + '\n');
  throw error;
}
