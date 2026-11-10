import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, success } from './controller-fixture.mjs';
import { canonical, sha256, units, validateManifest } from './manifest.mjs';
const runtime = process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME ? pathToFileURL(resolve(process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME) + '/') : import.meta.url;
const { hostedPaths, hostedPolicy, prepareHostedManifest, verifyHostedCell, hostedAdmissionDiagnostic } = await import(new URL('./hosted.mjs', runtime));
const { packControlledAttempt, summarizeControlledManifest } = await import(new URL('./archive.mjs', runtime));

async function campaign(t) {
  const f = await fixture(t, { count: 2, observability: true });
  const runId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), paths = hostedPaths(runId);
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await mkdir(join(paths.runner, 'portable/dist/cli'), { recursive: true });
  const artifacts = {};
  for (const [name, relative] of [['runnerCli', 'portable/dist/cli/eval-session.js'], ['runnerPackage', 'paperclip-runner.tgz'], ['runnerd', 'paperclip-runnerd']]) {
    artifacts[name] = { ...f.manifest[name], path: join(paths.runner, relative) };
    await cp(f.manifest[name].path, artifacts[name].path);
  }
  const cells = f.requests.map(({ request }, index) => ({ cellId: `execution-${index}`, provider: request.provider, driver: 'codex_app_server', model: request.model }));
  const catalog = { schema: 'paperclip.runner-protocol-eval.catalog/v1', campaignId: `gha-${runId}-1`,
    source: { paperclipSha: f.manifest.sourceRevision, evalsSha: f.manifest.definitionsRevision },
    cells, matrices: cells.map(cell => ({ include: [cell] })) };
  const catalogSha256 = sha256(canonical(catalog));
  for (const item of f.requests) { item.request.runnerd = { ...artifacts.runnerd, sha256: `sha256:${artifacts.runnerd.sha256}` }; item.request.acpxAgent = null; item.request.driver = 'codex_app_server'; await writeFile(item.requestPath, JSON.stringify(item.request)); }
  const prepared = { schema: 'paperclip.runner-eval.prepared-requests/v1', campaignId: catalog.campaignId, githubRunId: runId, githubRunAttempt: 1,
    sourceRevision: f.manifest.sourceRevision, definitionsRevision: f.manifest.definitionsRevision, catalogSha256, runnerd: f.requests[0].request.runnerd,
    cells: cells.map((cell, index) => ({ cellId: cell.cellId, runId: `${catalog.campaignId}-${cell.cellId}`, request: f.requests[index].request })) };
  const { projectId, capture, nativeLimits } = f.manifest.observability;
  const { executionId, attemptId, requestSha256, ...allocation } = f.manifest.attempts[0];
  const { verifiedAt, expiresAt, components, ...overhead } = f.manifest.overhead;
  // Committed defaults carry no cell count, review window, lock pin or self-hashed bounds.
  const defaults = { schema: 'paperclip.runner-eval.hosted-defaults/v1', maxUsd: f.manifest.maxUsd, durationMs: 60000, route: 'direct',
    models: f.manifest.models.map(({ provisionalBound, ...model }) => model), allocations: [allocation],
    overhead: { ...overhead, accountingReadiness: 'model_requests', components: components.map(({ provisionalBound, ...component }) => component) },
    observability: { capture, nativeLimits } };
  const environment = { ...f.environment, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: f.manifest.sourceRevision, PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA: prepared.sourceRevision, PAPERCLIP_PROTOCOL_EVALS_SHA: prepared.definitionsRevision };
  const input = { catalog, catalogSha256, prepared, defaults, projectId, controllerLockSha256: 'e'.repeat(64), artifacts, environment };
  const build = () => prepareHostedManifest(input);
  return { f, input, paths, environment, build };
}

test('one prepared manifest binds disjoint workers and retains partial or entirely missing campaigns', async t => {
  const c = await campaign(t), result = c.build();
  Object.assign(c.f.manifest, result.manifest); await c.f.save();
  const empty = await summarizeControlledManifest(result.manifest, []);
  assert.equal(empty.incompleteAttempts, 2); assert.equal(empty.heldUsd, '0.024000000');
  assert.equal(empty.costStatus, 'incomplete');
  Object.assign(c.f.environment, c.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' });
  assert.equal((await c.f.run(0, () => success())).code, 0);
  const bundle = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-0', environment: c.f.environment });
  const partial = await summarizeControlledManifest(result.manifest, [bundle, bundle]);
  assert.equal(partial.incompleteAttempts, 1); assert.equal(partial.knownUsd, '0.000136000');
  assert.equal(partial.heldUsd, '0.014000000'); assert.equal(partial.operatingHeldUsd, '0.004000000');
  Object.assign(c.f.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-1' });
  assert.equal((await c.f.run(1, () => success())).code, 0);
  const second = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-1', environment: c.f.environment });
  const complete = await summarizeControlledManifest(result.manifest, [bundle, second]);
  assert.equal(complete.incompleteAttempts, 0); assert.equal(complete.knownUsd, '0.000272000');
  assert.equal(complete.heldUsd, '0.004000000'); assert.equal(complete.costStatus, 'provisional');
  await assert.rejects(summarizeControlledManifest({ ...result.manifest, maxUsd: '2' }, [bundle]), /retained campaign manifest/);
});

test('hosted preparation rejects selection drift, unsupported cells and unreviewed or insufficient budgets', async t => {
  const c = await campaign(t);
  const changes = [
    input => { input.prepared.definitionsRevision = 'd'.repeat(40); },
    input => { input.prepared.catalogSha256 = '0'.repeat(64); },
    input => { input.catalog.matrices[1].include = input.catalog.matrices[0].include; },
    input => { input.prepared.cells[1] = input.prepared.cells[0]; },
    input => { input.prepared.cells[0].request.provider = 'opencode'; },
    input => { input.prepared.cells[0].request.driver = 'unsupported'; },
    input => { input.catalog.cells[0].driver = 'unsupported'; input.catalog.matrices[0].include[0].driver = 'unsupported'; },
    input => { input.prepared.cells[0].request.runnerd.sha256 = 'sha256:' + '0'.repeat(64); },
    input => { input.maxUsd = '0.01'; },
    input => { input.maxUsd = 'unbounded'; },
    input => { input.prepared.cells = []; },
    input => { input.environment.GITHUB_RUN_ATTEMPT = '2'; },
    input => { input.environment.GITHUB_SHA = 'wrong'; },
    input => { input.environment.GITHUB_SHA = 'c'.repeat(40); },
    input => { delete input.defaults.observability; },
    input => { delete input.controllerLockSha256; },
    input => { input.controllerLockSha256 = 'not-a-digest'; },
    input => { input.defaults.durationMs = 5 * 3_600_000; },
    input => { input.defaults.schema = 'paperclip.runner-eval.hosted-policy/v1'; },
  ];
  for (const change of changes) {
    const input = structuredClone(c.input); change(input);
    assert.throws(() => prepareHostedManifest(input));
  }
  const input = structuredClone(c.input); input.maxUsd = '0.01';
  assert.throws(() => prepareHostedManifest(input), /budget/);
});

test('hosted admission rejects local and fleet origins while preserving retained manifests', async t => {
  const c = await campaign(t);
  const original = c.build().manifest;
  for (const runner of ['local', 'aws-fleet']) {
    const input = structuredClone(c.input); input.defaults.overhead.runner = runner;
    assert.throws(() => prepareHostedManifest(input), /GitHub-hosted operating origin/);
    const retained = structuredClone(original); retained.overhead.runner = runner;
    assert.equal(validateManifest(retained, Date.now(), { admission: false }).manifest.overhead.runner, runner);
    await writeFile(c.paths.manifest, canonical(retained));
    await assert.rejects(verifyHostedCell({ manifestPath: c.paths.manifest, manifestSha256: sha256(canonical(retained)),
      cellId: 'execution-0', environment: { ...c.environment, PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' } }), /GitHub-hosted operating origin/);
  }
  const local = structuredClone(original); delete local.hosted; local.overhead.runner = 'local';
  assert.equal(validateManifest(local).manifest.overhead.runner, 'local');
});

test('worker preflight verifies identical manifest bytes and current cell/run before credentials', async t => {
  const c = await campaign(t), { manifest, manifestSha256 } = c.build();
  await writeFile(c.paths.manifest, canonical(manifest));
  const input = { manifestPath: c.paths.manifest, manifestSha256, cellId: 'execution-0',
    environment: { ...c.environment, PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' } };
  assert.equal((await verifyHostedCell(input)).attempt.attemptId, 'attempt-0');
  await assert.rejects(verifyHostedCell({ ...input, cellId: 'another-cell' }), /outside/);
  await assert.rejects(verifyHostedCell({ ...input, environment: { ...input.environment, GITHUB_RUN_ATTEMPT: '2' } }), /first-attempt/);
  await writeFile(c.paths.manifest, canonical(manifest) + '\n');
  await assert.rejects(verifyHostedCell(input), /bytes changed/);
});

test('hosted CLI reports safe admission reasons without echoing private paths or malformed input', async () => {
  assert.equal(hostedAdmissionDiagnostic(new Error('Reviewed cost bound configuration changed')), 'Reviewed cost bound configuration changed');
  assert.equal(hostedAdmissionDiagnostic(new SyntaxError('SENSITIVE_SENTINEL')), 'A hosted input is not valid JSON');
  assert.doesNotMatch(hostedAdmissionDiagnostic(new Error('private SENSITIVE_SENTINEL')), /SENSITIVE_SENTINEL/);
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./hosted.mjs', runtime)), 'verify', '/nonexistent/SENSITIVE_SENTINEL', 'a'.repeat(64), 'cell'], {
    env: { PATH: process.env.PATH, OPENAI_API_KEY: 'SENSITIVE_SENTINEL' }, timeout: 10000,
  }).then(value => value, error => error);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /A required hosted input file is missing/);
  assert.doesNotMatch(result.stderr + result.stdout, /SENSITIVE_SENTINEL/);
});


test('model-readiness policy retains operating holds without requiring vendor cost proofs', async t => {
  const c = await campaign(t);
  const result = c.build();
  assert.equal(result.manifest.overhead.accountingReadiness, 'model_requests');
  assert.equal(result.manifest.observability.provisionalBound, undefined);
  Object.assign(c.f.manifest, result.manifest); await c.f.save();
  const missing = await summarizeControlledManifest(result.manifest, []);
  assert.equal(missing.incompleteAttempts, 2);
  assert.equal(missing.operatingHeldUsd, '0.004000000');
  Object.assign(c.f.environment, c.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' });
  assert.equal((await c.f.run(0, () => success())).code, 0);
  const first = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-0', environment: c.f.environment });
  Object.assign(c.f.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-1' });
  assert.equal((await c.f.run(1, () => success())).code, 0);
  const second = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-1', environment: c.f.environment });
  const complete = await summarizeControlledManifest(result.manifest, [first, second]);
  assert.equal(complete.incompleteAttempts, 0);
  assert.equal(complete.operatingHeldUsd, '0.004000000');
  assert.equal(complete.accountingReadiness, 'model_requests');
  assert.equal(complete.operatingReconciliation, 'pending');
  delete c.input.defaults.overhead.accountingReadiness;
  assert.throws(() => c.build(), /operating bound/);
});


test('the campaign policy is derived from the selection and committed defaults', async t => {
  const c = await campaign(t), now = Date.now(), result = c.build();
  assert.equal(result.policy.maxCells, 2);
  assert.equal(result.policy.schema, 'paperclip.runner-eval.hosted-policy/v2');
  assert.equal(result.manifest.hosted.controllerLockSha256, 'e'.repeat(64));
  assert.equal(result.manifest.models[0].provisionalBound, undefined);
  // The validity window covers this campaign only; the committed table itself never expires.
  assert.ok(Date.parse(result.manifest.pricingVerifiedAt) <= Date.now() && Date.parse(result.manifest.pricingVerifiedAt) >= now - 1000);
  assert.ok(Date.parse(result.manifest.pricingExpiresAt) > Date.parse(result.manifest.deadlineAt));
  assert.equal(result.manifest.overhead.expiresAt, result.manifest.pricingExpiresAt);
  const later = structuredClone(c.input); later.now = now + 400 * 86_400_000;
  later.environment = { ...later.environment };
  assert.equal(hostedPolicy(later.defaults, { cellCount: 2, now: later.now, controllerLockSha256: 'e'.repeat(64) }).pricingVerifiedAt,
    new Date(later.now).toISOString());
  const capped = structuredClone(c.input); capped.maxUsd = '5';
  assert.equal(prepareHostedManifest(capped).manifest.maxUsd, '5');
});

test('the committed defaults admit the full 41-case Claude plan within their spend cap', async () => {
  // Under the portable runtime this reads the packaged copy that hosted.mjs prepare uses.
  const defaults = JSON.parse(await readFile(new URL('./hosted-defaults.json', runtime), 'utf8'));
  const now = Date.now(), projectId = '4dcaad06-b1ce-4416-ac28-482f1443d5ea';
  const manifestFor = cells => {
    const policy = hostedPolicy(defaults, { cellCount: cells, now, projectId, controllerLockSha256: 'e'.repeat(64) });
    const attempts = Array.from({ length: cells }, (_, index) => ({ ...policy.allocations[0],
      executionId: `protocol-live-testops-claude--case-${index}`, attemptId: `attempt-${index}`, requestSha256: 'a'.repeat(64) }));
    return { schema: 'paperclip.runner-eval.controller/v1', campaignId: 'gha-1-1', maxUsd: policy.maxUsd,
      deadlineAt: new Date(now + policy.durationMs).toISOString(), pricingVerifiedAt: policy.pricingVerifiedAt, pricingExpiresAt: policy.pricingExpiresAt,
      route: policy.route, projectId: policy.projectId, models: policy.models, overhead: policy.overhead, observability: policy.observability,
      sourceRevision: 'b'.repeat(40), definitionsRevision: 'c'.repeat(40),
      runnerCli: { path: '/tmp/r/cli.js', sha256: '1'.repeat(64) }, runnerPackage: { path: '/tmp/r/p.tgz', sha256: '2'.repeat(64) },
      runnerd: { path: '/tmp/r/runnerd', sha256: '3'.repeat(64) }, outputDirectory: '/tmp/r/evidence', attempts };
  };
  const full = validateManifest(manifestFor(41), now);
  assert.equal(full.manifest.attempts.length, 41);
  assert.equal(full.allocatedUsd, "339.000000000"); assert.ok(units(full.allocatedUsd) <= units(defaults.maxUsd));
  assert.throws(() => validateManifest(manifestFor(49), now), /exceed the campaign budget/);
});
