// Production TS -> Rust PRP -> sidecar -> ACPX -> pinned Hermes -> deterministic
// HTTP model fixture. This is not live provider or browser qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const nativeQuestions = [
  { id: 'color', question: 'Choose the fixture color', choices: ['Cobalt', 'Amber'] },
  { id: 'targets', question: 'Choose the fixture targets', choices: ['Linux', 'Mac'], multi_select: true },
  { id: 'notes', question: 'Describe the fixture constraint' },
];
const nativeResponse = {
  schema: 'paperclip.question_response.v1',
  answers: {
    q0: { selectedOptionIds: ['o0'] },
    q1: { selectedOptionIds: ['o1', 'o0'], customText: 'FreeBSD' },
    q2: { text: 'Keep memory private.' },
  },
};

const cases = [
  ...[null, 'ask_user_questions', 'request_confirmation', 'request_checkbox_confirmation'].map(interactionKind => ({ interactionKind, nativeQuestionAction: null })),
  ...['submit', 'cancel', 'stop'].map(nativeQuestionAction => ({ interactionKind: null, nativeQuestionAction })),
  { interactionKind: null, nativeQuestionAction: null, nativeSteering: true },
];
for (const { interactionKind, nativeQuestionAction, nativeSteering } of cases) test(nativeSteering
  ? 'pinned Hermes accepts active provider-turn steering across the production Rust PRP transport'
  : nativeQuestionAction
  ? `pinned Hermes native question batch crosses Rust PRP with ${nativeQuestionAction} and rejects a second answer`
  : interactionKind
  ? `pinned Hermes retains prompt usage before committed ${interactionKind} triggers immediate Rust-sidecar shutdown`
  : 'pinned Hermes streams images and semantic completion through Rust PRP and the production sidecar', {
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
    assert.equal(req.headers.authorization, undefined);
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'title', object: 'chat.completion', model: 'hermes-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'native-prp', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (nativeSteering && requests.length === 1) {
      send({ role: 'assistant', reasoning_content: 'Checking the native runner path.' });
      send({ content: 'NATIVE_RUNNER_STEER_READY' });
      const deadline = Date.now() + 30_000;
      while (!res.destroyed && Date.now() < deadline) {
        res.write(': active native stream\n\n');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(res.destroyed, 'Native steering did not interrupt the current model request');
      return;
    }
    if (nativeSteering) {
      const latestUser = body.messages.findLast(message => message.role === 'user');
      assert.ok(JSON.stringify(latestUser?.content).includes('NATIVE_RUNNER_STEER_ACCEPTED'),
        'Steering must reach the original native loop as a user correction');
    }
    const toolResults = body.messages.filter(message => message.role === 'tool');
    const askNative = nativeQuestionAction && toolResults.length === 0;
    if (askNative || toolResults.length === (nativeQuestionAction ? 1 : 0)) {
      send({ role: 'assistant', reasoning_content: 'Checking the native runner path.' });
      await new Promise(resolve => setTimeout(resolve, 80));
      const tool = body.tools.find(tool => askNative ? tool.function.name === 'clarify'
        : tool.function.name.endsWith(interactionKind ? 'request_human_input' : 'paperclip_finish'));
      assert.ok(tool, 'The expected native or assigned tool was not exposed to the model');
      send({ tool_calls: [{ index: 0, id: askNative ? 'native-prp-clarify' : 'native-prp-finish', type: 'function', function: { name: tool.function.name,
        arguments: JSON.stringify(askNative ? { questions: nativeQuestions } : interactionKind ? { marker: 'governed-question' } : completion) } }] });
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
    runnerBinary: process.env.PAPERCLIP_RUNNER_BINARY,
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
  const backend = createRunnerdNativeSessionBackend(input, { runnerInstanceId: 'hermes-prp-runner', transportFactory: () => bundle.transport,
    ...(interactionKind ? {
      dynamicTools: [{ name: 'request_human_input', description: 'Simulated authenticated human input operation',
        inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }],
      dynamicToolHandler: async () => ({ disposition: 'applied', interaction: {
        id: 'fixture-question', companyId: identity.companyId, issueId: identity.issueId, sourceRunId: identity.runId,
        kind: interactionKind, status: 'pending', continuationPolicy: 'wake_assignee',
      } }),
    } : {}),
  });
  session = await backend.openSession({ identity, workingDirectory: workspace });
  await session.startTurn({ message: { role: 'user', text: input.task.prompt, attachments: input.attachments } });
  const events = [];
  let cancellationOutcome;
  let stoppedQuestionRequest;
  let questionResolutions = 0;
  let steeringTurnId;
  let steeringCount = 0;
  for await (const event of session.events()) {
    events.push(event);
    if (nativeSteering && event.eventType === 'item.delta'
      && event.payload.kind === 'agentMessage' && event.payload.text.includes('NATIVE_RUNNER_STEER_READY')) {
      assert.equal(steeringCount++, 0, 'The active stream must not receive duplicate steering');
      steeringTurnId = event.turnId;
      assert.notEqual(steeringTurnId, 'hermes-prp-turn', 'Fixture must distinguish provider and durable PRP turn identities');
      assert.equal((await session.capabilities()).steering, true);
      await session.steer({ turnId: steeringTurnId, message: { role: 'user', text: 'NATIVE_RUNNER_STEER_ACCEPTED' },
        correlationId: 'native-steer-fixture' });
    }
    if (nativeQuestionAction && event.eventType === 'runtime_request.created') {
      const request = event.payload.request;
      assert.equal(request.origin.method, '_hermes/ask_questions');
      assert.equal(request.origin.adapter, 'acpx-runtime-sidecar');
      assert.equal(request.input.schema, 'paperclip.question_set.v1');
      assert.deepEqual(request.input.questions.map(question => ({ id: question.id, prompt: question.prompt, answerMode: question.answerMode })), [
        { id: 'q0', prompt: nativeQuestions[0].question, answerMode: 'single_select' },
        { id: 'q1', prompt: nativeQuestions[1].question, answerMode: 'multi_select' },
        { id: 'q2', prompt: nativeQuestions[2].question, answerMode: 'text' },
      ]);
      for (const [index, labels] of [[0, ['Cobalt', 'Amber']], [1, ['Linux', 'Mac']]]) {
        assert.deepEqual(request.input.questions[index].options.map(option => option.id), ['o0', 'o1']);
        request.input.questions[index].options.forEach((option, i) => assert.ok(option.label.startsWith(labels[i])));
      }
      assert.equal(questionResolutions++, 0, 'Native callback produced a duplicate form');
      const resolution = { requestId: request.requestId, turnId: request.turnId,
        resolution: nativeQuestionAction === 'submit' ? { action: 'submit', response: nativeResponse } : { action: 'cancel' } };
      if (nativeQuestionAction === 'stop') {
        stoppedQuestionRequest = structuredClone(request);
        await session.cancel({ reason: 'stop during native clarification', signal: new AbortController().signal }).cleanup;
        continue;
      }
      await session.resolveRuntimeRequest(resolution);
      await assert.rejects(session.resolveRuntimeRequest(resolution), /no longer pending/);
    }
    if (interactionKind && event.eventType === 'item.completed' && event.payload.kind === 'dynamicToolCall') {
      cancellationOutcome = session.cancel({ reason: 'committed human input wait', signal: new AbortController().signal }).cleanup
        .then(() => ({ stopped: true }), error => ({ error }));
      break;
    }
    if (['run.terminal', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.eventType)) break;
  }
  if (nativeQuestionAction) {
    assert.equal(questionResolutions, 1, 'Native clarification never crossed PRP');
    assert.equal(events.filter(event => event.eventType === 'runtime_request.created').length, 1);
    if (nativeQuestionAction === 'stop') {
      assert.equal(requests.length, 1, 'Stopped clarification started another model request');
      const outcomes = events.filter(event => ['runtime_request.resolved', 'runtime_request.cancelled', 'runtime_request.expired'].includes(event.eventType));
      assert.equal(outcomes.length, 1, 'Stopped clarification must close exactly once');
      const outcome = outcomes[0];
      assert.equal(outcome.eventType, 'runtime_request.cancelled', 'Stop revived the native input as a durable fallback');
      assert.equal(outcome.runId, identity.runId);
      assert.equal(outcome.normalizedSessionId, identity.sessionId);
      assert.equal(outcome.turnId, stoppedQuestionRequest.turnId);
      assert.equal(outcome.itemId, stoppedQuestionRequest.itemId);
      assert.equal(outcome.payload.requestId, stoppedQuestionRequest.requestId);
      assert.equal(outcome.payload.requestKind, 'runtime');
      assert.equal(outcome.payload.requestType, 'input');
      assert.equal(outcome.payload.action, 'cancel');
      assert.ok(outcome.payload.reason);
      assert.equal(outcome.payload.response, undefined);
      assert.equal(outcome.payload.request, undefined);
      assert.equal(outcome.payload.replayAllowed, undefined);
      const terminals = events.filter(event => ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.eventType));
      assert.equal(terminals.length, 1, 'Stopped clarification must retain one native terminal');
      assert.equal(terminals[0].eventType, 'turn.cancelled');
      assert.equal(terminals[0].turnId, outcome.turnId);
      assert.equal(terminals[0].payload.status, 'cancelled');
      assert.equal(terminals[0].payload.error, null);
      assert.ok(terminals[0].sourceSeq > outcome.sourceSeq);
      await assert.rejects(session.resolveRuntimeRequest({ requestId: stoppedQuestionRequest.requestId,
        turnId: stoppedQuestionRequest.turnId, resolution: { action: 'cancel' } }), /no longer pending/);
      const usage = await session.accountingUsageEvent?.();
      assert.deepEqual(usage?.payload.usage.runDelta && {
        input: usage.payload.usage.runDelta.inputTokens, output: usage.payload.usage.runDelta.outputTokens,
        complete: usage.payload.usage.runDeltaComplete,
      }, { input: 10, output: 5, complete: true }, 'Stopped clarification lost final native prompt usage');
      // Informational notices enter durable PRP evidence rather than the
      // normalized NativeSession lifecycle stream. Assert the actual carrier.
      const controlPlane = JSON.parse(await readFile(join(root, 'runner/control-plane/control-plane-state.json'), 'utf8'));
      const committed = controlPlane.committedEvents.map(event => event.envelope.payload);
      const receipts = committed.filter(event => event.eventType === 'provider.notice.recorded'
        && event.payload.category === 'hermes_usage_provenance');
      assert.equal(receipts.length, 1, 'Stopped clarification lost its owned Hermes usage extension');
      assert.equal(receipts[0].schema, 'paperclip.prp.event.v1');
      assert.equal(receipts[0].sourceKind, 'runner');
      assert.equal(receipts[0].sourceInstanceId, 'hermes-prp-runner');
      assert.equal(receipts[0].normalizedSessionId, identity.sessionId);
      assert.equal(receipts[0].runId, identity.runId);
      assert.equal(receipts[0].turnId, 'hermes-prp-turn');
      assert.equal(receipts[0].payload.details.find(detail => detail.name === 'Token usage')?.value, 'reported');
      const committedTerminals = committed.filter(event => event.eventType === 'turn.cancelled');
      assert.equal(committedTerminals.length, 1);
      assert.equal(committedTerminals[0].turnId, receipts[0].turnId);
      assert.ok(receipts[0].sourceSeq < committedTerminals[0].sourceSeq, 'Usage provenance arrived after cancelled settlement');
      await session.close({ reason: 'native clarification stopped' });
      assert.equal((await session.snapshot()).semanticResult, null, 'Stop invented task completion');
      return;
    }
    assert.equal(events.filter(event => event.eventType === 'runtime_request.resolved').length, 1);
    const responses = requests.at(-1).messages.filter(message => message.role === 'tool' && message.tool_call_id === 'native-prp-clarify');
    assert.equal(responses.length, 1, 'Native callback result was missing or duplicated');
    const result = JSON.parse(responses[0].content);
    assert.deepEqual(result.responses.map(response => ({ id: response.id, user_response: response.user_response })), nativeQuestionAction === 'submit' ? [
      { id: 'color', user_response: 'Cobalt' },
      { id: 'targets', user_response: ['Mac', 'Linux', 'FreeBSD'] },
      { id: 'notes', user_response: 'Keep memory private.' },
    ] : nativeQuestions.map(question => ({ id: question.id, user_response: '' })));
    if (nativeQuestionAction === 'cancel') {
      assert.equal(result.timed_out, true);
      assert.equal(result.notice, 'Question cancelled');
    } else assert.equal(result.timed_out, undefined);
    assert.equal(requests.length, 3, 'Native clarification resumed more than once');
  }
  if (interactionKind) {
    assert.ok(cancellationOutcome, 'The committed human input completion did not reach the native boundary');
    await session.close({ reason: 'immediate human input shutdown' });
    const stop = await cancellationOutcome;
    if (stop.error) assert.equal(stop.error.code, 'already_terminal', 'Provider cancellation failed before terminal settlement');
    const usage = await session.accountingUsageEvent?.();
    assert.deepEqual(usage?.payload.usage.runDelta && {
      input: usage.payload.usage.runDelta.inputTokens, output: usage.payload.usage.runDelta.outputTokens,
      complete: usage.payload.usage.runDeltaComplete,
    }, { input: 10, output: 5, complete: true }, 'Immediate shutdown lost the native prompt receipt');
    assert.ok(events.some(event => event.payload.kind === 'usage'), 'The human input completion reached PRP before its usage receipt');
    assert.equal(requests.length, 1, 'Hermes started another model request after the committed human input');
    return;
  }
  assert.ok(events.some(event => event.eventType === 'turn.completed'), JSON.stringify(events));
  assert.ok(events.some(event => JSON.stringify(event.payload).includes('Checking the native runner path.')), 'Reasoning did not cross PRP');
  assert.ok(events.some(event => JSON.stringify(event.payload).includes('Native Rust')), 'Text did not cross PRP');
  assert.ok(requests.some(body => body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${imageData}`))), 'Images did not cross TS/Rust/sidecar');
  assert.ok(requests.every(body => body.stream), 'Managed Hermes started auxiliary title inference');
  const snapshot = await session.snapshot();
  assert.equal(snapshot.semanticResult?.reportedWorkDisposition, 'done');
  assert.equal(snapshot.terminal?.runTerminalState, 'succeeded');
  assert.equal(bundle.evidence().acpxAgent, 'hermes');
  if (nativeSteering) {
    assert.equal(steeringCount, 1);
    assert.equal(requests.length, 3, 'A redirected request and normal completion must remain in one native turn');
    assert.equal(events.filter(event => event.eventType === 'turn.started').length, 1);
    const acknowledgements = events.filter(event => event.eventType === 'item.completed'
      && event.payload.kind === 'steering_acknowledgement');
    assert.equal(acknowledgements.length, 1, 'Steering must produce one canonical acknowledgement');
    assert.equal(acknowledgements[0].turnId, steeringTurnId);
    assert.equal(acknowledgements[0].payload.status, 'acknowledged');
    const initial = events.find(event => event.eventType === 'item.delta'
      && event.payload.kind === 'agentMessage' && event.payload.text.includes('NATIVE_RUNNER_STEER_READY'));
    const final = events.find(event => event.eventType === 'item.completed'
      && event.payload.kind === 'agentMessage' && event.payload.text.includes('Native Rust path completed.'));
    assert.ok(initial && final, 'Both assistant messages must survive native steering');
    assert.equal(typeof initial.itemId, 'string', 'The initial message must have a canonical envelope identity');
    assert.equal(typeof final.itemId, 'string', 'The final message must have a canonical envelope identity');
    assert.notEqual(initial.itemId, final.itemId,
      'The final snapshot must not replace text from the preceding assistant message');
    const finalDeltas = events.filter(event => event.eventType === 'item.delta'
      && event.payload.kind === 'agentMessage' && event.itemId === final.itemId);
    assert.equal(finalDeltas.map(event => event.payload.text).join(''), final.payload.text,
      'The final snapshot must share the identity of its own streamed text');
    await assert.rejects(session.steer({ turnId: steeringTurnId,
      message: { role: 'user', text: 'STALE_NATIVE_STEER' }, correlationId: 'stale-native-steer' }), /terminal|active turn/i);
  }

});
