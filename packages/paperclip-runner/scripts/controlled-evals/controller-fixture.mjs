import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const runtime = process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME
  ? pathToFileURL(resolve(process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME) + '/') : import.meta.url;
const { canonical, costRuntime, observabilityBoundConfiguration, requestBindingSha256, sha256 } = await import(new URL('./manifest.mjs', runtime));
const { runControlledEval } = await import(new URL('./run.mjs', runtime));
const { build } = createRequire(new URL('../../../../package.json', import.meta.url))('esbuild');

const childScript = options => `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,rm,readdir,symlink,truncate,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const request=JSON.parse(await readFile(args.get('--request'),'utf8'));
if(${Boolean(options.builtAcpxProfile)})assert.deepEqual(JSON.parse(args.get('--expected-acpx-profile')??'null'),${JSON.stringify(options.builtAcpxProfile ?? null)});
if(${Boolean(options.failChild)})process.exit(3);
if(${Boolean(options.resistantDescendant)}) {
 const orphan=${Boolean(options.orphanExit)};
 const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});"+(orphan?"process.send('ready');":"process.stdout.write('ready');")+"setInterval(()=>{},1000)"],{stdio:orphan?['ignore','inherit','inherit','ipc']:['ignore','pipe','ignore']});
 if(orphan)await once(descendant,'message');else await once(descendant.stdout,'data');
 await writeFile(request.session.workingDirectory+'/descendant.pid',String(descendant.pid));
}

const descriptorRaw=await readFile(args.get('--gateway-config'),'utf8'),descriptor=JSON.parse(descriptorRaw);
for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','BRAINTRUST_API_KEY','GH_TOKEN','NODE_OPTIONS','PYTHONPATH'])assert.equal(process.env[key],undefined);
const statuses=[];
for(let i=0;i<${options.requests ?? 3};i++){
 const response=await fetch(descriptor.baseUrl+(descriptor.provider==='openai'?'/v1/responses':'/v1/messages'),{method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN,'content-type':'application/json'},body:JSON.stringify({model:request.model,input:'synthetic fixture'})});
 statuses.push(response.status);await response.text();
}
let nativeObservability;
if(args.has('--observability-config')) {
 const raw=await readFile(args.get('--observability-config'),'utf8'),config=JSON.parse(raw);
 const parent=decodeURIComponent(config.launch.environment.OTEL_EXPORTER_OTLP_TRACES_HEADERS.slice('x-bt-parent='.length));
 for(const signal of ['logs','traces'])for(let i=0;i<${options.otelRequests ?? 1};i++) {
  const body=signal==='logs'?{resourceLogs:[{scopeLogs:[{logRecords:[{body:{stringValue:'synthetic-native-content'}}]}]}]}:{resourceSpans:[{scopeSpans:[{spans:[{traceId:'1'.repeat(32),spanId:'2'.repeat(16),name:'synthetic-native-span'}]}]}]};
  const response=await fetch(config.baseUrl+'/v1/'+signal,{method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN,'x-bt-parent':parent,'content-type':'application/json'},body:JSON.stringify(body)});
  await response.arrayBuffer();
 }
 nativeObservability={mode:'controller_otlp',configured:true,verification:'unverified',projectId:config.projectId,traceId:config.traceId,spanId:config.spanId,descriptorSha256:createHash('sha256').update(raw).digest('hex')};
 if(${Boolean(options.realObservabilityValidator)}) {
  const {prepareEvalObservabilityRuntime}=await import(${JSON.stringify(options.observabilityValidatorModule ?? '')});
  await mkdir(process.env.HOME+'/codex',{recursive:true});
  const prepared=await prepareEvalObservabilityRuntime(args.get('--observability-config'),request,
   {evidence:{campaignId:descriptor.campaignId,executionId:descriptor.executionId},transportOptions:{environment:{CODEX_HOME:process.env.HOME+'/codex'}}},process.env);
  assert.deepEqual(prepared.evidence,nativeObservability);
  for(const signal of ['LOGS','TRACES'])assert(prepared.transportOptions.environment['OTEL_EXPORTER_OTLP_'+signal+'_HEADERS'].includes(encodeURIComponent('Bearer '+process.env.PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN)));
  nativeObservability=prepared.evidence;
 }

}
if(${Boolean(options.waitForever)})await new Promise(()=>setInterval(()=>{},1000));
if(!${Boolean(options.missingArtifact)})await writeFile(args.get('--output'),JSON.stringify({schema:'paperclip-runner/eval-session-artifact/v1',attemptId:request.attemptId,requestedModel:request.model,
 requestRouting:${options.missingRoute ? 'null' : "{mode:'controller_gateway',provider:descriptor.provider,declaredUpstreamRoute:descriptor.upstreamRoute,campaignId:descriptor.campaignId,executionId:descriptor.executionId,attemptId:descriptor.attemptId,descriptorSha256:createHash('sha256').update(descriptorRaw).digest('hex')}"},
 nativeObservability, snapshot:{status:'closed',process:{runnerExited:true,runnerPid:process.pid,providerPid:process.pid}},statuses,
 leaked:${options.leakToken ? 'process.env.PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN' : options.leakOtlpToken ? 'process.env.PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN' : 'null'}}));
if(${Boolean(options.invalidEvidence)}) {
 const root=dirname(args.get('--output'));
 const name=${JSON.stringify(options.invalidEvidence ?? '')};
 const file=name==='receipt'?join(root,'receipts',(await readdir(join(root,'receipts')))[0]):join(root,name);
 await rm(file);
 const kind=${JSON.stringify(options.invalidFileType ?? '')};
 if(kind==='fifo')execFileSync('mkfifo',[file]);
 else if(kind==='symlink')await symlink('/dev/zero',file);
 else {await writeFile(file,'');await truncate(file,16*1024*1024+1);}
}

if(${Boolean(options.orphanExit)})process.exit(0);
`;

async function fixture(t, { count = 1, allocation = '0.01', providerProfile = 'codex', route = 'direct', ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-controller-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'fake-cli.mjs'), binary = join(root, 'runnerd'), archive = join(root, 'runner.tgz');
  if (options.realObservabilityValidator) {
    options.observabilityValidatorModule = join(root, 'eval-observability-runtime.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../src/cli/eval-observability-runtime.ts', import.meta.url))],
      outfile: options.observabilityValidatorModule, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
  }
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
  if (options.observability) {
    manifest.observability = { projectId: '11111111-1111-4111-8111-111111111111',
      capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false },
      nativeLimits: { maxRequests: 4, maxRequestBytes: 16384, maxTotalBytes: 32768, maxConcurrent: 1, maxExpandedBytes: 65536, maxRecords: 16 } };
    manifest.observability.provisionalBound = bound(observabilityBoundConfiguration(manifest));
  }
  const manifestPath = join(root, 'manifest.json');
  const save = () => writeFile(manifestPath, JSON.stringify(manifest)); await save();
  const environment = { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-upstream-private', ANTHROPIC_API_KEY: 'other-private', BRAINTRUST_API_KEY: 'other-braintrust', GH_TOKEN: 'other-github', NODE_OPTIONS: '--require must-not-inherit', PYTHONPATH: '/must-not-inherit' };
  return { root, manifest, manifestPath, requests, environment, save,
    run: (index = 0, transport = () => success(biller), signal) => runControlledEval({ manifestPath, ...requests[index], environment, transport, signal, otlpTransport: options.otlpTransport ?? (async () => Response.json({})) }) };
}
let sequence = 0;
function success(provider = 'openai') {
  if (provider === 'anthropic') return Response.json({ type: 'message', id: `synthetic-${++sequence}`, model: 'fixture', usage: { input_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }, { headers: { 'x-bt-used-endpoint': 'ANTHROPIC_API_KEY', 'x-bt-cached': 'MISS' } });
  return Response.json({ object: 'response', id: `synthetic-${++sequence}`, status: 'completed', model: 'fixture', usage: {
    input_tokens: 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } });
}


export { childScript, fixture, success };
