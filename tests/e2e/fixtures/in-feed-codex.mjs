#!/usr/bin/env node
// Deterministic provider only. The production Rust runner, tool authority, and
// authenticated MCP gateway still execute every tool and enforce access.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.115.0 (in-feed fixture)'); process.exit(0); }
let threadId = `fixture-${randomUUID()}`;
let turnId, toolSequence = 0, declined = false;
let completionContract = { revision: "1", criterionIds: ["objective"] };
const pending = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const call = (tool, args) => new Promise((resolve, reject) => {
  const id = `connection-tool-${++toolSequence}`;
  pending.set(id, { resolve, reject });
  send({ id, method: 'item/tool/call', params: { threadId, turnId, callId: id, tool, arguments: args } });
});
function unwrap(result) {
  const texts = result?.contentItems ?? result?.content ?? [];
  for (const item of texts) {
    try { const parsed = JSON.parse(item.text); return parsed.value ?? parsed; } catch {}
  }
  return result;
}
async function mcp(method, params = {}) {
  // Native execution creates a dedicated provider home and issues a short-lived
  // gateway token for this fixture run. Never load the user's normal Codex home.
  if (!process.env.CODEX_HOME || !process.env.HOME
    || resolve(process.env.CODEX_HOME) !== resolve(process.env.HOME)) {
    throw new Error('The fixture requires an isolated native provider home');
  }
  const config = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  const url = JSON.parse(config.match(/^url = (.+)$/m)?.[1] ?? 'null');
  const authorization = JSON.parse(config.match(/Authorization = (".*?")/m)?.[1] ?? 'null');
  if (!url || !authorization) throw new Error('Native continuation did not install the MCP gateway');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The fixture only accepts a local native gateway');
  }
  const response = await fetch(endpoint, { redirect: 'error', method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++toolSequence, method, params }) });
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
  const text = await response.text();
  const envelope = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((line) => line.startsWith('data:')).slice(5) : text);
  if (envelope.error) throw new Error(envelope.error.message);
  return envelope.result;
}
async function finish(text, evidenceRef) {
  return call('paperclip_finish', { schema: 'paperclip.run_result.v1', reportedWorkDisposition: 'done', summary: text,
    completionClaim: { contractRevision: completionContract.revision, objectiveSatisfied: true, criteria: completionContract.criterionIds.map((criterionId) => ({ criterionId, status: 'satisfied', evidenceRefs: [evidenceRef] })), remainingWork: [] },
    evidence: [{ ref: evidenceRef }], verification: [{ commandOrCheck: 'Fixture outcome', status: 'passed' }], attentionRequests: [], artifacts: [] });
}
async function execute() {
  if (declined) {
    const text = 'Connection declined. I will use the information already in this task and pursue alternatives.';
    await call('report_progress', { idempotencyKey: `declined-${turnId}`, body: text });
    await finish(text, 'task:declined-alternative');
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: `answer-${turnId}`, type: 'agentMessage', text } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  const discovery = unwrap(await call('connections_search', { query: 'heliotrope' }));
  const service = discovery.results?.find((item) => item.source === 'configured');
  if (!service) throw new Error('Authorized Research Archive fixture was not discoverable');
  const request = unwrap(await call('connection_request', { service: service.service }));
  const refreshingTools = request.state === 'ready' && request.instruction?.includes('fresh continuation with updated tools is queued');
  let text;
  if (request.state === 'needs_user_action') {
    text = 'I need access to the research archive. I can organize the launch checklist while you connect it.';
  } else if (refreshingTools) {
    // Follow the authority's yield instruction when authorization arrives after
    // this provider session pinned its tools. The next session must do the read.
    text = 'Access is ready. I will continue the archive read with the updated tools.';
  } else {
    await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'in-feed-fixture', version: '1' } });
    const list = await mcp('tools/list');
    const tool = list.tools.find((item) => /heliotrope/.test(item.description ?? '') || /archive_read/.test(item.name));
    if (!tool) throw new Error('Updated native tool snapshot does not contain archive_read');
    const result = await mcp('tools/call', { name: tool.name, arguments: {} });
    if (result.isError) throw new Error(JSON.stringify(result));
    text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (!text.includes('HELIOTROPE-42')) throw new Error('Provider fixture value missing');
  }
  await call('report_progress', { idempotencyKey: `fixture-answer-${turnId}`, body: text });
  if (request.state === 'ready' && !refreshingTools) await finish(text, 'mcp:archive_read');
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: `answer-${turnId}`, type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method && pending.has(message.id)) {
    const promise = pending.get(message.id); pending.delete(message.id);
    message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result); return;
  }
  const { id, method } = message;
  if (method === 'initialize') send({ id, result: { user: { sessionId: threadId } } });
  else if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume' && message.params?.threadId) threadId = message.params.threadId;
    if (message.params?.completionContract) completionContract = message.params.completionContract;
    send({ id, result: { model: 'in-feed-fixture', modelProvider: 'fixture', thread: { id: threadId, sessionId: threadId } } });
  }
  else if (method === 'thread/read') send({ id, result: { thread: { id: threadId, turns: [] } } });
  else if (method === 'turn/start') {
    declined = /connection_intent/.test(JSON.stringify(message.params)) && /rejected/.test(JSON.stringify(message.params));
    for (const part of message.params?.input ?? []) {
      try {
        const envelope = JSON.parse(part.text);
        const contract = envelope.task?.completionContract ?? envelope.completionContract;
        if (contract?.revision && contract.criteria) completionContract = { revision: contract.revision, criterionIds: contract.criteria.map((criterion) => criterion.id) };
      } catch { /* Non-envelope text is ordinary task context. */ }
    }
    turnId = randomUUID();
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    // Deliver model output on a later tick, after the runner accepts turn/start.
    setTimeout(() => void execute().catch((error) => {
      process.stderr.write(`In-feed fixture: ${error.message}\n`);
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: error.message } } } });
    }), 50);
  } else if (id != null) send({ id, result: {} });
});
