import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, costRuntime, requestBindingSha256, sha256, validateManifest } from './manifest.mjs';
import { attemptDirectory, runControlledEval } from './run.mjs';
import { summarizeControlledCampaign } from './report.mjs';

const childScript = options => `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const request=JSON.parse(await readFile(args.get('--request'),'utf8'));
if(${Boolean(options.resistantDescendant)}) {
 const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
 await once(descendant.stdout,'data');
 await writeFile(request.session.workingDirectory+'/descendant.pid',String(descendant.pid));
}

const descriptorRaw=await readFile(args.get('--gateway-config'),'utf8'),descriptor=JSON.parse(descriptorRaw);
for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','BRAINTRUST_API_KEY','GH_TOKEN','NODE_OPTIONS','PYTHONPATH'])assert.equal(process.env[key],undefined);
const statuses=[];
for(let i=0;i<${options.requests ?? 3};i++){
 const response=await fetch(descriptor.baseUrl+(descriptor.provider==='openai'?'/v1/responses':'/v1/messages'),{method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN,'content-type':'application/json'},body:JSON.stringify({model:request.model,input:'synthetic fixture'})});
 statuses.push(response.status);await response.text();
}
if(${Boolean(options.waitForever)})await new Promise(()=>setInterval(()=>{},1000));
if(!${Boolean(options.missingArtifact)})await writeFile(args.get('--output'),JSON.stringify({schema:'paperclip-runner/eval-session-artifact/v1',attemptId:request.attemptId,requestedModel:request.model,
 requestRouting:${options.missingRoute ? 'null' : "{mode:'controller_gateway',provider:descriptor.provider,declaredUpstreamRoute:descriptor.upstreamRoute,campaignId:descriptor.campaignId,executionId:descriptor.executionId,attemptId:descriptor.attemptId,descriptorSha256:createHash('sha256').update(descriptorRaw).digest('hex')}"},
 snapshot:{status:'closed',process:{runnerExited:true,runnerPid:process.pid,providerPid:process.pid}},statuses,
 leaked:${options.leakToken ? 'process.env.PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN' : 'null'}}));
`;

async function fixture(t, { count = 1, allocation = '0.01', providerProfile = 'codex', route = 'direct', ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-controller-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'fake-cli.mjs'), binary = join(root, 'runnerd'), archive = join(root, 'runner.tgz');
  await writeFile(cli, childScript(options)); await writeFile(binary, 'synthetic daemon'); await writeFile(archive, 'synthetic package');
  const provenance = async path => ({ path, sha256: sha256(await readFile(path)) });
  const now = Date.now(), verifiedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 86_400_000).toISOString();
  const overhead = { version: 1, reference: 'synthetic-allowance', runner: 'github-hosted', verifiedAt, expiresAt,
    components: costRuntime.EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: '0.001', reference: 'synthetic-proof' })) };
  const bound = configuration => ({ version: 1, scope: 'full_lifecycle', evidenceSha256: 'a'.repeat(64), configurationSha256: sha256(canonical(configuration)) });
  for (const component of overhead.components) component.provisionalBound = bound({ reference: overhead.reference, runner: overhead.runner, verifiedAt, expiresAt, component: { ...component } });
  const biller = providerProfile === 'claude' ? 'anthropic' : 'openai';
  const price = { provider: biller, model: 'fixture', version: 'synthetic-pricing', sourceUrl: 'https://provider.invalid/pricing', inputUsdPerMillion: '2', cachedReadUsdPerMillion: '1', outputUsdPerMillion: '10', ...(biller === 'openai' ? { cacheWrite30mUsdPerMillion: '2', cacheWrite12hUsdPerMillion: '2' } : { cacheWrite5mUsdPerMillion: '2', cacheWrite1hUsdPerMillion: '2' }) };
  const model = { provider: biller, price, maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 1000 };
  model.provisionalBound = bound({ provider: model.provider, mode: route, price, maximumInputTokens: 1000, maximumOutputTokens: 100, reservation: '0.003000000' });
  const manifest = { schema: 'paperclip.runner-eval.controller/v1', campaignId: 'synthetic-controller', maxUsd: '1',
    deadlineAt: new Date(now + 60_000).toISOString(), pricingVerifiedAt: verifiedAt, pricingExpiresAt: expiresAt, overhead,
    sourceRevision: 'a'.repeat(40), definitionsRevision: 'b'.repeat(40), runnerCli: await provenance(cli), runnerPackage: await provenance(archive), runnerd: await provenance(binary),
    outputDirectory: join(root, 'controller'), route, ...(route === 'braintrust' ? { projectId: '11111111-1111-4111-8111-111111111111' } : {}), models: [model], attempts: [] };
  const requests = [];
  for (let index = 0; index < count; index++) {
    const workspace = join(root, `workspace-${index}`); await mkdir(workspace);
    const request = { schema: 'paperclip-runner/eval-session-request/v1', attemptId: `attempt-${index}`, prompt: 'synthetic', provider: providerProfile === 'claude' ? 'acpx' : 'codex', ...(providerProfile === 'claude' ? { acpxAgent: 'claude' } : {}), model: 'fixture',
      runnerd: { path: binary, sha256: manifest.runnerd.sha256 }, limits: { turnTimeoutMs: 5000, maxAgentTurns: 1, maxEstimatedCostNanodollars: 1_000_000_000 }, session: { workingDirectory: workspace } };
    const requestPath = join(root, `request-${index}.json`), outputPath = join(root, `output-${index}.json`);
    await writeFile(requestPath, JSON.stringify(request)); requests.push({ request, requestPath, outputPath });
    manifest.attempts.push({ executionId: `execution-${index}`, attemptId: request.attemptId, requestSha256: requestBindingSha256(request), provider: request.provider, ...(request.acpxAgent ? { acpxAgent: request.acpxAgent } : {}), model: 'fixture', maxUsd: allocation, maxRequests: 2, maxConcurrent: 1, timeoutMs: 5000 });
  }
  const manifestPath = join(root, 'manifest.json');
  const save = () => writeFile(manifestPath, JSON.stringify(manifest)); await save();
  const environment = { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-upstream-private', ANTHROPIC_API_KEY: 'other-private', BRAINTRUST_API_KEY: 'other-braintrust', GH_TOKEN: 'other-github', NODE_OPTIONS: '--require must-not-inherit', PYTHONPATH: '/must-not-inherit' };
  return { root, manifest, manifestPath, requests, environment, save,
    run: (index = 0, transport = () => success(biller), signal) => runControlledEval({ manifestPath, ...requests[index], environment, transport, signal }) };
}
let sequence = 0;
function success(provider = 'openai') {
  if (provider === 'anthropic') return Response.json({ type: 'message', id: `synthetic-${++sequence}`, model: 'fixture', usage: { input_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }, { headers: { 'x-bt-used-endpoint': 'ANTHROPIC_API_KEY', 'x-bt-cached': 'MISS' } });
  return Response.json({ object: 'response', id: `synthetic-${++sequence}`, status: 'completed', model: 'fixture', usage: {
    input_tokens: 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } });
}

test('real child requests reserve before dispatch, stop at the cap and retain only controller credentials', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await f.run(0, async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-upstream-private');
    const ledger = await costRuntime.readEvalCostLedger(join(attemptDirectory(f.manifest, 'attempt-0'), 'ledger.jsonl'));
    assert.equal(ledger.state.snapshot().inflight, 1);
    return success();
  });
  assert.equal(calls, 2); assert.equal(result.code, 0); assert.equal(result.report.cleanupVerified, true);
  const artifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  assert.deepEqual(artifact.statuses, [200, 200, 429]);
  assert.equal(artifact.controllerAccounting.accounting.knownUsd, '0.000136000');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 0); assert.equal(summary.heldUsd, '0.004000000'); assert.equal(summary.committedUsd, '0.004136000');
  for (const name of ['admission.json', 'result.json', 'ledger.jsonl', 'provider-artifact.json', 'stdout.log', 'stderr.log']) {
    assert(!(await readFile(join(attemptDirectory(f.manifest, 'attempt-0'), name), 'utf8')).includes(f.environment.OPENAI_API_KEY));
  }
  await assert.rejects(f.run(), /output already exists/);
  await rm(f.requests[0].outputPath);
  await assert.rejects(f.run(), { code: 'EEXIST' });
  assert.equal(calls, 2);
});

test('disjoint concurrent cells cannot borrow an allowance and unknown requests retain their reservations', async t => {
  const f = await fixture(t, { count: 2, allocation: '0.003' }); f.manifest.maxUsd = '0.01'; await f.save();
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ error: 'synthetic refusal' }, { status: 429 }); };
  const results = await Promise.all([f.run(0, transport), f.run(1, transport)]);
  assert.equal(calls, 2); assert(results.every(result => result.report.status === 'closed'));
  assert(results.every(result => result.report.accounting.heldUsd === '0.003000000'));
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.committedUsd, '0.010000000'); assert.equal(summary.knownUsd, '0.000000000'); assert.equal(summary.overBudget, false);
  assert(summary.attempts.every(attempt => attempt.boundedUnresolvedRequests === 1));
});

test('rejects oversized or unqualified allocations, changed requests and changed executables before dispatch', async t => {
  const f = await fixture(t, { count: 2 });
  for (const mutate of [
    value => { value.maxUsd = '0.01'; }, value => { value.attempts[1].executionId = value.attempts[0].executionId; },
    value => { value.attempts[0].provider = 'acpx'; value.attempts[0].acpxAgent = 'codex'; },
    value => { delete value.overhead.components[0].provisionalBound; }, value => { value.models[0].secret = 'unexpected'; },
  ]) { const value = structuredClone(f.manifest); mutate(value); assert.throws(() => validateManifest(value)); }
  f.requests[0].request.prompt = 'drift'; await writeFile(f.requests[0].requestPath, JSON.stringify(f.requests[0].request));
  await assert.rejects(f.run(), /allocated identity/);
  await writeFile(f.manifest.runnerCli.path, 'changed CLI');
  await assert.rejects(f.run(1), /provenance changed/);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 2); assert.equal(summary.heldUsd, '0.024000000');
});

for (const fault of ['missingArtifact', 'missingRoute', 'leakToken']) test(`${fault} keeps the allocation held and preserves the attempt failure`, async t => {
  const f = await fixture(t, { [fault]: true, requests: 1 });
  const result = await f.run();
  assert.equal(result.code, 2); assert.equal(result.report.status, 'incomplete');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 1); assert.equal(summary.committedUsd, '0.014000000'); assert.equal(summary.costStatus, 'incomplete');
  assert.equal(summary.knownUsd, '0.000068000');
  const artifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  assert.equal(artifact.accountingFailure.retryable, false);
  if (fault === 'leakToken') { assert.equal(result.report.secretExcluded, false); assert.equal(artifact.leaked, '[redacted]'); }
});

test('cancellation closes the proxy, bounds the owned child, and preserves unknown request holds', async t => {
  const f = await fixture(t, { requests: 1, waitForever: true });
  const abort = new AbortController(); let calls = 0;
  const result = await f.run(0, async (_url, init) => {
    calls++; abort.abort();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic interrupted request')), { once: true }));
  }, abort.signal);
  assert.equal(calls, 1); assert.equal(result.code, 2); assert.equal(result.report.cleanupVerified, false);
  assert.equal(result.report.accounting.unknownRequests, 1);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.committedUsd, '0.014000000'); assert.equal(summary.incompleteAttempts, 1);
});

test('changed receipts cannot release allocations and expired campaigns remain inspectable', async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const resultPath = join(root, 'result.json'), result = JSON.parse(await readFile(resultPath, 'utf8'));
  result.accounting.knownUsd = '0.000000000'; await writeFile(resultPath, JSON.stringify(result));
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 1); assert.equal(summary.committedUsd, '0.014000000'); assert.equal(summary.knownUsd, '0.000068000');
  assert.throws(() => validateManifest(f.manifest, Date.now() + 2 * 86_400_000));
  assert.doesNotThrow(() => validateManifest(f.manifest, Date.now() + 2 * 86_400_000, { admission: false }));
});


test('a lost final report preserves known ledger charges while holding the remaining cell allowance', async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  await rm(join(attemptDirectory(f.manifest, 'attempt-0'), 'result.json'));
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000'); assert.equal(summary.committedUsd, '0.014000000');
  assert.equal(summary.incompleteAttempts, 1);
});


test('Claude cells use the assigned Braintrust provider and keep its credential on the controller', async t => {
  const f = await fixture(t, { providerProfile: 'claude', route: 'braintrust', requests: 1 });
  let calls = 0;
  const result = await f.run(0, async (url, init) => {
    calls++; assert.equal(url, 'https://gateway.braintrust.dev/messages');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer other-braintrust');
    assert.equal(headers.get('x-bt-endpoint-name'), 'ANTHROPIC_API_KEY');
    assert.equal(headers.get('x-bt-project-id'), f.manifest.projectId);
    return success('anthropic');
  });
  assert.equal(calls, 1); assert.equal(result.code, 0);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 0); assert.equal(summary.knownUsd, '0.000068000');
});


test('existing outputs and physical workspace aliases are rejected before provider work', async t => {
  const f = await fixture(t);
  let calls = 0;
  const transport = async () => { calls++; return success(); };
  await writeFile(f.requests[0].outputPath, 'existing evidence');
  await assert.rejects(f.run(0, transport), /already exists/);
  assert.equal(await readFile(f.requests[0].outputPath, 'utf8'), 'existing evidence');
  await rm(f.requests[0].outputPath);
  f.manifest.outputDirectory = join(f.requests[0].request.session.workingDirectory, '..evidence'); await f.save();
  await assert.rejects(f.run(0, transport), /outside the disposable/);
  f.manifest.outputDirectory = join(f.root, 'aliased-evidence');
  await symlink(f.requests[0].request.session.workingDirectory, f.manifest.outputDirectory); await f.save();
  await assert.rejects(f.run(0, transport), /resolves inside/);
  assert.equal(calls, 0);
});

for (const missing of ['request.json', 'admission.json', 'receipt']) test(`lost ${missing} keeps known charges and the full allocation`, async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const file = missing === 'receipt' ? join(root, 'receipts', (await readdir(join(root, 'receipts')))[0]) : join(root, missing);
  await rm(file);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000');
  assert.equal(summary.committedUsd, '0.014000000');
  assert.equal(summary.incompleteAttempts, 1);
});

for (const changed of ['request', 'receipt']) test(`changed ${changed} evidence cannot release the allocation`, async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const file = changed === 'receipt' ? join(root, 'receipts', (await readdir(join(root, 'receipts')))[0]) : join(root, 'request.json');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (changed === 'request') value.prompt = 'different request'; else value.costUsd = '0.000000000';
  await writeFile(file, JSON.stringify(value));
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000');
  assert.equal(summary.committedUsd, '0.014000000');
  assert.equal(summary.incompleteAttempts, 1);
});

for (const replaced of ['runnerCli', 'runnerd']) test(`launches verified bytes after the original ${replaced} path is replaced`, async t => {
  const f = await fixture(t, { requests: 1 });
  await writeFile(f.manifest.runnerCli.path, childScript({ requests: 1 }) + "\nassert.equal(await readFile(request.runnerd.path, 'utf8'), 'synthetic daemon');\n");
  f.manifest.runnerCli.sha256 = sha256(await readFile(f.manifest.runnerCli.path)); await f.save();
  Object.defineProperty(f.environment, 'OPENAI_API_KEY', { get() {
    writeFileSync(f.manifest[replaced].path, replaced === 'runnerCli' ? "throw new Error('replacement must not execute');" : 'replaced daemon');
    return 'synthetic-upstream-private';
  }});
  const result = await f.run();
  assert.equal(result.code, 0); assert.equal(result.report.cleanupVerified, true);
  assert.equal((await summarizeControlledCampaign(f.manifest)).incompleteAttempts, 0);
  await assert.rejects(readdir(join(attemptDirectory(f.manifest, 'attempt-0'), 'executables')), { code: 'ENOENT' });
});

test('staged CLI relative imports survive a symlinked evidence directory', async t => {
  const f = await fixture(t, { requests: 1 });
  await writeFile(join(f.root, 'helper.mjs'), "export const marker = 'trusted sibling';\n");
  await writeFile(f.manifest.runnerCli.path, "import { marker } from './helper.mjs';\n" + childScript({ requests: 1 }) + "\nassert.equal(marker, 'trusted sibling');\n");
  f.manifest.runnerCli.sha256 = sha256(await readFile(f.manifest.runnerCli.path));
  const alias = join(f.root, 'evidence-alias');
  await mkdir(join(f.root, 'evidence-real')); await symlink(join(f.root, 'evidence-real'), alias);
  f.manifest.outputDirectory = join(alias, 'controller'); await f.save();
  const result = await f.run();
  assert.equal(result.code, 0);
  assert.equal((await summarizeControlledCampaign(f.manifest)).incompleteAttempts, 0);
});

test('cancellation still kills an owned resistant descendant after the CLI exits', async t => {
  const f = await fixture(t, { requests: 1, waitForever: true, resistantDescendant: true });
  f.manifest.attempts[0].timeoutMs = 15000; await f.save();
  const abort = new AbortController(); let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = f.run(0, async () => { ready(); return success(); }, abort.signal);
  await started;
  const pid = Number(await readFile(join(f.requests[0].request.session.workingDirectory, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  abort.abort();
  const result = await running;
  assert.equal(result.report.child.stopped, 'controller_cancelled');
  const absent = () => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  for (let retry = 0; retry < 100 && !absent(); retry++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(absent(), true);
  assert.equal(result.report.cleanupVerified, false);
  assert.equal((await summarizeControlledCampaign(f.manifest)).committedUsd, '0.014000000');
});
