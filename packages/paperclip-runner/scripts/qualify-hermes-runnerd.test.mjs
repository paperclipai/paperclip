// Production TS -> Rust PRP -> sidecar -> ACPX -> pinned Hermes -> deterministic
// HTTP model fixture. This is not live provider or browser qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRunnerdNativeSessionBackend } from '../dist/backends/codex-native-backend.js';
import { createRunnerdCodexTransport } from '../dist/live/runnerd-codex-transport.js';
import { resolveQualifiedAcpxProfile } from '../dist/drivers/acpx/qualified-profiles.js';
import { parseNativeExecutionInput } from '../dist/contracts/native-execution.js';
import { PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from '../dist/contracts/runtime-context.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=';
const completion = {
  reportedWorkDisposition: 'done', summary: 'Native Rust path completed.',
  completionClaim: { contractRevision: '1', objectiveSatisfied: true,
    criteria: [{ criterionId: 'objective', status: 'satisfied', evidenceRefs: [] }], remainingWork: [] },
  evidence: [], verification: [{ commandOrCheck: 'native transport fixture', status: 'passed' }], attentionRequests: [], artifacts: [],
};

test('pinned Hermes streams images and semantic completion through Rust PRP and the production sidecar', {
  skip: process.env.PAPERCLIP_HERMES_QUALIFY !== '1', timeout: 180_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'paperclip-hermes-runnerd-'));
  const workspace = join(root, 'workspace');
  const instructions = join(root, 'instructions');
  const agentFiles = join(root, 'agent-files');
  for (const directory of [workspace, instructions, agentFiles, join(root, 'runtime')]) await mkdir(directory, { mode: 0o700 });
  const entry = 'You are a deterministic native transport test agent.';
  await writeFile(join(instructions, 'AGENTS.md'), entry);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push(body);
    assert.equal(req.headers.authorization, undefined);
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'title', object: 'chat.completion', model: 'hermes-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'native-prp', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!body.messages.some(message => message.role === 'tool')) {
      send({ role: 'assistant', reasoning_content: 'Checking the native runner path.' });
      await new Promise(resolve => setTimeout(resolve, 80));
      const finish = body.tools.find(tool => tool.function.name.endsWith('paperclip_finish'));
      assert.ok(finish, 'Paperclip completion authority was not exposed to the native model');
      send({ tool_calls: [{ index: 0, id: 'native-prp-finish', type: 'function', function: { name: finish.function.name, arguments: JSON.stringify(completion) } }] });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'Native Rust ' });
      await new Promise(resolve => setTimeout(resolve, 80));
      send({ content: 'path completed.' });
      send({}, 'stop');
    }
    res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n');
  });
  let session, bundle;
  t.after(async () => {
    await session?.close({ reason: 'fixture cleanup' });
    await bundle?.transport.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (process.env.PAPERCLIP_KEEP_HERMES_FIXTURE === '1') t.diagnostic(`Fixture evidence: ${root}`);
    else await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: 'AGENTS.md', bundle: { schema: 'paperclip.runtime-asset.v1', digest: sha256(entry), manifestDigest: sha256(entry), rootPath: instructions, fileCount: 1, totalBytes: Buffer.byteLength(entry) },
      workingCopy: { kind: 'agent_files', rootPath: agentFiles, entryPath: 'AGENTS.md' } },
    skills: [], mcp: { assignmentSetId: 'none', digest: sha256('none'), bindingId: null },
  };
  const runtimeContext = { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
  const identity = { runId: 'hermes-prp-run', sessionId: 'hermes-prp-session', companyId: 'hermes-prp-company', issueId: 'hermes-prp-issue', agentId: 'hermes-prp-agent' };
  const resolved = resolveQualifiedAcpxProfile('hermes', 'hermes-fixture');
  const profile = Object.fromEntries(['driverKind', 'protocolVersion', 'acpxVersion', 'agent', 'agentProfileVersion', 'agentServerPackage', 'agentServerVersion', 'agentRuntimePackage', 'agentRuntimeVersion', 'commandDigest'].map(key => [key, resolved[key]]));
  const input = parseNativeExecutionInput({
    schema: 'paperclip.native-execution-input.v7', executionMode: 'default', planningContext: null,
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: 'hermes-prp-workspace' },
    session: { normalizedSessionId: identity.sessionId, driverKind: 'acpx_runtime', protocolVersion: 1 },
    task: { identifier: 'HERMES-PRP', title: 'Native transport fixture', description: null, prompt: 'Complete the native transport fixture.', workMode: 'standard' },
    workspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: 'acpx', agent: 'hermes', model: 'hermes-fixture', permissionMode: 'approve-all', profile, connectionFingerprint: '1'.repeat(64) },
    completionContract: { id: 'hermes-prp-contract', sha256: sha256('fixture'), schemaVersion: 'paperclip.completion-contract.v1', contract: { revision: '1', objective: 'Native transport fixture', criteria: [{ id: 'objective', requirement: 'Complete the native transport fixture.' }] } },
    runtimeContext, interactionResponses: [], credentialBindings: [],
    attachments: [{ schema: 'paperclip.user_attachment.v1', kind: 'image', name: 'pixel.png', mediaType: 'image/png', data: imageData }],
  });
  bundle = createRunnerdCodexTransport({
    provider: 'acpx', acpxAgent: 'hermes', acpxCandidateProfile: 'hermes', acpxPermissionMode: 'approve-all',
    stateDirectory: join(root, 'runner'), acpxRuntimeDirectory: join(root, 'runtime'), runtimeContext,
    lifecyclePolicy: { mode: 'per_turn', idleTimeoutMs: null }, turnStartTimeoutMs: 90_000,
    onDiagnostic: message => t.diagnostic(message),
    environment: { PATH: process.env.PATH, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, 'provider-trace.jsonl'), PAPERCLIP_HERMES_CONNECTION_FINGERPRINT: input.provider.connectionFingerprint,
      PAPERCLIP_HERMES_CONFIG_JSON: JSON.stringify({ model: { provider: 'custom:paperclip', default: 'hermes-fixture' },
        providers: { paperclip: { base_url: `http://127.0.0.1:${server.address().port}/v1`, transport: 'chat_completions', default_model: 'hermes-fixture', api_key: 'no-key-required' } },
        paperclip_auth: { protocol: 'chat', style: 'none' } }),
    },
    prpIdentity: { runnerInstanceId: 'hermes-prp-runner', environmentLeaseId: 'hermes-prp-lease', runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: 'hermes-prp-turn', itemId: 'hermes-prp-item' },
  });
  const backend = createRunnerdNativeSessionBackend(input, { runnerInstanceId: 'hermes-prp-runner', transportFactory: () => bundle.transport });
  session = await backend.openSession({ identity, workingDirectory: workspace });
  await session.startTurn({ message: { role: 'user', text: input.task.prompt, attachments: input.attachments } });
  const events = [];
  for await (const event of session.events()) {
    events.push(event);
    if (['run.terminal', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.eventType)) break;
  }
  assert.ok(events.some(event => event.eventType === 'turn.completed'), JSON.stringify(events));
  assert.ok(events.some(event => JSON.stringify(event.payload).includes('Checking the native runner path.')), 'Reasoning did not cross PRP');
  assert.ok(events.some(event => JSON.stringify(event.payload).includes('Native Rust')), 'Text did not cross PRP');
  assert.ok(requests.some(body => body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${imageData}`))), 'Images did not cross TS/Rust/sidecar');
  const snapshot = await session.snapshot();
  assert.equal(snapshot.semanticResult?.reportedWorkDisposition, 'done');
  assert.equal(snapshot.terminal?.runTerminalState, 'succeeded');
  assert.equal(bundle.evidence().acpxAgent, 'hermes');
});
