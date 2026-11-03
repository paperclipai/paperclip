import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const runtime = process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME
  ? pathToFileURL(resolve(process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME) + '/') : import.meta.url;
const { canonical, costRuntime, observabilityBoundConfiguration, requestBindingSha256, sha256, validateManifest } = await import(new URL('./manifest.mjs', runtime));
const { attemptDirectory, runControlledEval } = await import(new URL('./run.mjs', runtime));
const { summarizeControlledCampaign } = await import(new URL('./report.mjs', runtime));
const { decodeControlledEvidence, packControlledAttempt, readControlledEvidence, readAttemptControlledEvidence, summarizeControlledEvidence } = await import(new URL('./archive.mjs', runtime));
const { readRegularFile, replaceEvidenceFile } = await import(new URL('./evidence-files.mjs', runtime));

import { aggregateProtocolEvalCampaign, sanitizeProtocolEvalRuns } from '../runner-protocol-eval-campaign.mjs';


import { childScript, fixture, success } from './controller-fixture.mjs';

test('expected ACPX profile reaches the child through function and command-line entrypoints', async t => {
  const profile = { agent: 'claude', agentRuntimeVersion: '0.3.286' };
  for (const mode of ['function', 'cli']) for (const stale of [false, true]) {
    const requests = mode === 'function' ? 1 : 0;
    const f = await fixture(t, { providerProfile: 'claude', builtAcpxProfile: profile, requests });
    const expectedAcpxProfile = { ...profile, ...(stale ? { agentRuntimeVersion: '0.3.263' } : {}) };
    let calls = 0;
    let result;
    if (mode === 'function') {
      result = await runControlledEval({ manifestPath: f.manifestPath, ...f.requests[0], environment: f.environment, expectedAcpxProfile,
        transport: async () => { calls++; return success('anthropic'); } });
    } else {
      let code = 0;
      try {
        await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./run.mjs', runtime)), '--request', f.requests[0].requestPath,
          '--output', f.requests[0].outputPath, '--expected-acpx-profile', JSON.stringify(expectedAcpxProfile)], {
          env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: f.environment.ANTHROPIC_API_KEY, PAPERCLIP_RUNNER_EVAL_CONTROL_MANIFEST: f.manifestPath }, timeout: 15000,
        });
      } catch (error) { if (typeof error.code !== 'number') throw error; code = error.code; }
      result = { code, report: JSON.parse(await readFile(f.requests[0].outputPath, 'utf8')).controllerAccounting };
    }
    assert.equal(calls, stale ? 0 : requests);
    assert.equal(result.code === 0, !stale);
    assert.equal(result.report.accounting.requests.length, stale ? 0 : requests);
  }
});

test('malformed profile arguments fail before opening controlled evidence', async t => {
  for (const [providerProfile, profiles] of [
    ['claude', [null, [], 'profile', { overflow: 'x'.repeat(4097) }]],
    ['codex', [{}]],
  ]) {
    const f = await fixture(t, { providerProfile });
    for (const expectedAcpxProfile of profiles) {
      await assert.rejects(runControlledEval({ manifestPath: f.manifestPath, ...f.requests[0], environment: {}, expectedAcpxProfile }), /Expected ACPX profile/);
    }
    await assert.rejects(stat(f.manifest.outputDirectory), { code: 'ENOENT' });
  }
});

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
  assert.equal(calls, 2); assert.equal(result.code, 0, JSON.stringify(result.report)); assert.equal(result.report.cleanupVerified, true);
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
    value => { value.attempts[0].attemptId = 'nested/attempt'; },
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

for (const missingArtifact of [false, true]) test(`CLI exit stops surviving owned processes, missing artifact=${missingArtifact}`, async t => {
  const f = await fixture(t, { requests: 0, resistantDescendant: true, orphanExit: true, missingArtifact });
  const pidFile = join(f.requests[0].request.session.workingDirectory, 'descendant.pid');
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const result = await f.run();
  pid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(result.report.child.stopped, 'provider_group_survived_cli_exit');
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(result.report.status, 'incomplete');
  assert.equal((await summarizeControlledCampaign(f.manifest)).committedUsd, '0.014000000');
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


test('portable archives replay after worker deletion, deduplicate attempts, and hold absent cells', async t => {
  const f = await fixture(t, { count: 2, requests: 1 });
  await f.run(0);
  const first = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: f.environment });
  const partial = await summarizeControlledEvidence([first, first]);
  assert.equal(partial.incompleteAttempts, 1);
  assert.equal(partial.knownUsd, '0.000068000');
  assert.equal(partial.committedUsd, '0.014068000');
  await f.run(1);
  const second = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-1' });
  const expected = await summarizeControlledCampaign(f.manifest);
  await rm(f.manifest.outputDirectory, { recursive: true });
  const restored = await summarizeControlledEvidence([first, second, first]);
  assert.deepEqual(restored.campaigns, [expected]);
  assert.equal(restored.operatingHeldUsd, '0.004000000');
  assert.equal(restored.knownUsd, '0.000136000');
  assert.equal(restored.costStatus, 'provisional');
});

test('archived partial proof preserves known costs without consulting intact worker files', async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  for (const name of ['admission.json', 'request.json', 'result.json', Object.keys(bundle.files).find(name => name.startsWith('receipts/'))]) {
    const partial = structuredClone(bundle); delete partial.files[name];
    const summary = await summarizeControlledEvidence([partial]);
    assert.equal(summary.incompleteAttempts, 1, name);
    assert.equal(summary.knownUsd, '0.000068000', name);
    assert.equal(summary.committedUsd, '0.014000000', name);
  }
  const absent = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  absent.files = {};
  assert.equal((await summarizeControlledEvidence([absent])).committedUsd, '0.014000000');
});

test('archive creation retains never-started selections and refuses nonregular or oversized proof', async t => {
  const f = await fixture(t);
  const empty = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  assert.deepEqual(empty.files, {});
  assert.equal((await summarizeControlledEvidence([empty])).heldUsd, '0.014000000');
  await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  await rm(join(root, 'stderr.log'));
  await symlink(f.manifest.runnerCli.path, join(root, 'stderr.log'));
  await assert.rejects(packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' }));
  await rm(join(root, 'stderr.log'));
  await writeFile(join(root, 'stderr.log'), Buffer.alloc(1_048_577));
  await assert.rejects(packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' }), /bounded regular file/);
});

test('archive validation rejects corruption, traversal, and conflicting campaign or attempt evidence', async t => {
  const f = await fixture(t, { requests: 1 }); await f.run();
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  for (const mutate of [
    b => { b.manifest.campaignId = 'other'; },
    b => { b.files['ledger.jsonl'].base64 = 'x' + b.files['ledger.jsonl'].base64.slice(1); },
    b => { b.files['../outside'] = b.files['ledger.jsonl']; },
    b => { b.files['stderr.log'].sizeBytes = -1; },
  ]) { const b = structuredClone(bundle); mutate(b); assert.throws(() => decodeControlledEvidence(b)); }
  const conflict = structuredClone(bundle); delete conflict.files['stderr.log'];
  await assert.rejects(summarizeControlledEvidence([bundle, conflict]), /Conflicting controller attempt/);
  const other = structuredClone(bundle); other.manifest.maxUsd = '2'; other.manifestSha256 = sha256(canonical(other.manifest));
  await assert.rejects(summarizeControlledEvidence([bundle, other]), /Conflicting controller campaign/);
});

test('configured credentials are excluded before encoding and after archive decoding', async t => {
  const f = await fixture(t); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const secret = 'synthetic-braintrust-archive-secret';
  const environment = { BRAINTRUST_API_KEY: secret };
  await writeFile(join(root, 'stderr.log'), secret);
  await assert.rejects(packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment }), /configured credential/);
  const unchecked = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: {} });
  assert(!JSON.stringify(unchecked).includes(secret));
  assert.throws(() => decodeControlledEvidence(unchecked, { environment }), /configured credential/);
  const file = join(f.root, 'archive.json'); await writeFile(file, JSON.stringify(unchecked));
  await assert.rejects(readControlledEvidence(file, { environment }), /configured credential/);
});

for (const name of ['provider-artifact.json', 'receipt', 'ledger.jsonl']) for (const kind of ['fifo', 'symlink', 'oversized']) {
  test(`post-child ${name} rejects ${kind} without blocking or releasing its allocation`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, { requests: 1, invalidEvidence: name, invalidFileType: kind });
    const result = await f.run();
    assert.equal(result.report.status, 'incomplete');
    assert.equal(result.report.accounting.knownUsd, '0.000068000');
    const summary = await summarizeControlledCampaign(f.manifest);
    assert.equal(summary.incompleteAttempts, 1);
    assert.equal(summary.committedUsd, '0.014000000');
  });
}

test('durable reports bound every evidence file and retain full holds for invalid proof', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { requests: 1, observability: true }); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const receipt = `receipts/${(await readdir(join(root, 'receipts')))[0]}`;
  for (const name of ['admission.json', 'request.json', 'result.json', 'provider-artifact.json', 'gateway.json', 'ledger.jsonl', receipt, 'observability.json', 'otlp-native.jsonl', 'otlp-controller.jsonl', 'otlp-root.json']) {
    const path = join(root, name), original = await readFile(path);
    for (const kind of ['fifo', 'symlink', 'oversized']) {
      await rm(path);
      if (kind === 'fifo') execFileSync('mkfifo', [path]);
      else if (kind === 'symlink') await symlink('/dev/zero', path);
      else { await writeFile(path, ''); await truncate(path, 16 * 1024 * 1024 + 1); }
      const summary = await summarizeControlledCampaign(f.manifest);
      assert.equal(summary.incompleteAttempts, 1, `${name}:${kind}`);
      assert.equal(summary.committedUsd, '0.014000000', `${name}:${kind}`);
    }
    await rm(path); await writeFile(path, original);
  }
  assert.equal((await summarizeControlledCampaign(f.manifest)).incompleteAttempts, 0);
});

for (const name of ['PAPERCLIP_AGENT_PRIVATE_KEY', 'PAPERCLIP_AI_PROVIDER_KEY', 'AWS_SECRET_ACCESS_KEY', 'OPENCODE_CONFIG_CONTENT']) {
  test(`archive excludes configured ${name} before and after encoding`, async t => {
    const f = await fixture(t); await f.run();
    const secret = name === 'PAPERCLIP_AGENT_PRIVATE_KEY' ? '-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----' : 'synthetic-extra-credential';
    const environment = { [name]: name === 'OPENCODE_CONFIG_CONTENT' ? JSON.stringify({ provider: { apiKey: secret } }) : secret };
    const root = attemptDirectory(f.manifest, 'attempt-0');
    await writeFile(join(root, 'stderr.log'), JSON.stringify({ retained: secret }));
    await assert.rejects(packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment }), /configured credential/);
    const unchecked = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: {} });
    assert.throws(() => decodeControlledEvidence(unchecked, { environment }), /configured credential/);
  });
}

test('retention annotations preserve an already-failed controller result and its known costs', async t => {
  const f = await fixture(t, { requests: 1, missingRoute: true }); await f.run();
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  const artifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  assert.equal(artifact.controllerAccounting.status, 'incomplete');
  artifact.controllerEvidenceError = 'A later retention check failed';
  artifact.accountingError = artifact.controllerEvidenceError;
  const directory = join(f.root, 'runs', 'attempt-0'); await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries({ 'request.json': f.requests[0].request, 'artifact.json': artifact, 'controller-evidence.json': bundle })) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  const retained = await readAttemptControlledEvidence(directory);
  const report = await summarizeControlledEvidence([retained]);
  assert.equal(report.costStatus, 'incomplete');
  assert.equal(report.knownUsd, '0.000068000');
  assert.equal(report.committedUsd, '0.014000000');
  assert.equal(JSON.parse(await readFile(join(directory, 'artifact.json'), 'utf8')).accountingError, artifact.controllerEvidenceError);
});

test('campaign collection retains and audits private archives, while public projection omits them', async t => {
  const f = await fixture(t, { count: 2, requests: 1 }); await f.run();
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  const download = join(f.root, 'downloads', 'cell'), attempt = join(download, 'runs', 'attempt-0');
  await mkdir(attempt, { recursive: true });
  const evalCase = { id: 'case-0', checks: [] }, config = { model: 'fixture', provider: 'codex', driver: 'codex_app_server' };
  for (const [name, value] of Object.entries({
    'request.json': f.requests[0].request,
    'artifact.json': JSON.parse(await readFile(f.requests[0].outputPath, 'utf8')),
    'score.json': { attemptId: 'attempt-0', caseId: evalCase.id, passed: true, disposition: 'passed', checks: [] },
    'case.json': evalCase, 'config.json': config, 'controller-evidence.json': bundle,
  })) await writeFile(join(attempt, name), JSON.stringify(value));
  const cell = { cellId: 'execution-0', caseId: evalCase.id, rosterFile: 'roster.json', rosterId: 'roster-0', ...config };
  const missingCell = { ...cell, cellId: 'execution-1', caseId: 'case-1' };
  const program = join(f.root, 'evals/paperclip-runner');
  for (const folder of ['rosters', 'cases', 'configs']) await mkdir(join(program, folder), { recursive: true });
  await writeFile(join(program, 'rosters/roster.json'), JSON.stringify({ config: '../configs/config.json' }));
  await writeFile(join(program, 'cases/case-1.json'), JSON.stringify({ ...evalCase, id: 'case-1' }));
  await writeFile(join(program, 'configs/config.json'), JSON.stringify(config));
  const catalogPath = join(f.root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ schema: 'paperclip.runner-protocol-eval.catalog/v1', campaignId: f.manifest.campaignId,
    selection: { kind: 'subset' }, cells: [cell, missingCell], rosters: [{ ...cell, cases: [evalCase.id, missingCell.caseId] }] }));
  await writeFile(join(download, 'cell.json'), JSON.stringify({ ...cell, exitCode: 0 }));
  await rm(f.manifest.outputDirectory, { recursive: true });
  const input = { catalogPath, downloadsRoot: join(f.root, 'downloads'), evalsRoot: f.root,
    runsOut: join(f.root, 'collected'), campaignOut: join(f.root, 'campaign.json'),
    source: { paperclip: { sha: f.manifest.sourceRevision }, evals: { sha: f.manifest.definitionsRevision } },
    controllerArchiveCli: process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME ? join(process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME, 'archive.mjs') : undefined };
  const result = await aggregateProtocolEvalCampaign(input);
  assert.equal(result.controlledCosts.knownUsd, '0.000068000');
  assert.equal(result.controlledCosts.costStatus, 'incomplete');
  assert.equal(result.controlledCosts.committedUsd, '0.014068000');
  assert.equal(result.controlledCosts.incompleteAttempts, 1);
  assert.deepEqual(JSON.parse(await readFile(join(input.runsOut, 'attempt-0', 'controller-evidence.json'), 'utf8')), bundle);
  const isolated = join(f.root, 'isolated-reporter'); await mkdir(join(isolated, 'controlled-evals'), { recursive: true });
  for (const file of ['runner-protocol-eval-campaign.mjs', 'runner-protocol-eval-metrics.mjs', 'public-eval-chat.mjs']) {
    await cp(new URL('../' + file, import.meta.url), join(isolated, file));
  }
  await writeFile(join(isolated, 'controlled-evals/archive.mjs'), "throw new Error('Source dependencies must not be loaded by the reporter');");
  const isolatedInput = join(f.root, 'isolated-input.json');
  await writeFile(isolatedInput, JSON.stringify({ ...input, controllerArchiveCli: undefined, runsOut: join(f.root, 'isolated-collected'), campaignOut: join(f.root, 'isolated-campaign.json') }));
  const isolatedResult = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {readFile} from 'node:fs/promises';
    const {aggregateProtocolEvalCampaign}=await import(${JSON.stringify(pathToFileURL(join(isolated, 'runner-protocol-eval-campaign.mjs')).href)});
    const result=await aggregateProtocolEvalCampaign(JSON.parse(await readFile(${JSON.stringify(isolatedInput)},'utf8')));
    console.log(JSON.stringify(result.controlledCosts));
  `], { cwd: isolated, env: { PATH: process.env.PATH,
    PAPERCLIP_RUNNER_EVAL_ARCHIVE_CLI: input.controllerArchiveCli ?? fileURLToPath(new URL('./archive.mjs', import.meta.url)) }, timeout: 20000 });
  assert.equal(JSON.parse(isolatedResult.stdout).knownUsd, result.controlledCosts.knownUsd);
  assert.equal(JSON.parse(isolatedResult.stdout).heldUsd, result.controlledCosts.heldUsd);
  const publicRoot = join(f.root, 'public');
  await sanitizeProtocolEvalRuns({ runsRoot: input.runsOut, publicRunsRoot: publicRoot });
  assert.deepEqual((await readdir(join(publicRoot, 'attempt-0'))).sort(), ['artifact.json', 'case.json', 'config.json', 'score.json']);
  assert(!(await readFile(join(publicRoot, 'attempt-0', 'artifact.json'), 'utf8')).includes('controllerAccounting'));
  const changedRequest = { ...f.requests[0].request, prompt: 'copied from another execution' };
  await writeFile(join(attempt, 'request.json'), JSON.stringify(changedRequest));
  await assert.rejects(aggregateProtocolEvalCampaign(input), /Immutable attempt does not match/);
  await writeFile(join(attempt, 'request.json'), JSON.stringify(f.requests[0].request));
  const originalArtifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  for (const mutate of [
    value => { value.usage = { estimatedCostNanodollars: 0 }; },
    value => { value.turn = { status: 'completed', assistantText: 'changed outcome' }; },
    value => { value.controllerAccounting.cleanupVerified = false; },
    value => { delete value.controllerAccounting; },
  ]) {
    const changed = structuredClone(originalArtifact); mutate(changed);
    await writeFile(join(attempt, 'artifact.json'), JSON.stringify(changed));
    await assert.rejects(aggregateProtocolEvalCampaign(input), /Immutable result disagrees/);
  }
  await writeFile(join(attempt, 'artifact.json'), JSON.stringify({ ...originalArtifact, provenance: { runnerPackage: 'private-program-provenance' } }));
  await aggregateProtocolEvalCampaign(input);
  const retainedFailure = { ...originalArtifact, controllerEvidenceError: 'Retained verification was interrupted', accountingError: 'Retained verification was interrupted',
    accountingFailure: { class: 'provider_budget_coverage_unknown', category: 'provider_budget', retryable: false } };
  await writeFile(join(attempt, 'artifact.json'), JSON.stringify(retainedFailure));
  await aggregateProtocolEvalCampaign(input);
  await writeFile(join(attempt, 'artifact.json'), JSON.stringify(originalArtifact));
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  for (const change of [{ model: 'wrong-model' }, { provider: 'acpx', acpxAgent: 'claude' }, { driver: 'other-driver' }]) {
    const driftedCatalog = structuredClone(catalog); Object.assign(driftedCatalog.cells[0], change);
    await writeFile(catalogPath, JSON.stringify(driftedCatalog));
    await writeFile(join(attempt, 'config.json'), JSON.stringify({ ...config, ...change }));
    await assert.rejects(aggregateProtocolEvalCampaign(input), /Controller archive identity drifted/);
  }
  await writeFile(join(attempt, 'config.json'), JSON.stringify(config));
  for (const change of [{ model: 'wrong-unexecuted-model' }, { provider: 'acpx', acpxAgent: 'claude', driver: 'acpx_runtime' }]) {
    const driftedCatalog = structuredClone(catalog); Object.assign(driftedCatalog.cells[1], change);
    await writeFile(catalogPath, JSON.stringify(driftedCatalog));
    await assert.rejects(aggregateProtocolEvalCampaign(input), /Controller archive identity drifted/);
  }
  await writeFile(catalogPath, JSON.stringify(catalog));
  await rm(join(attempt, 'controller-evidence.json'));
  await assert.rejects(aggregateProtocolEvalCampaign(input), /Missing private controller evidence/);
});

for (const providerProfile of ['codex', 'claude']) test(`controller owns native ${providerProfile} trace routing and offline receipts after workspace deletion`, async t => {
  const received = [];
  const f = await fixture(t, { providerProfile, observability: true, requests: 1, otlpTransport: async (url, init) => {
    received.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(Buffer.from(init.body).toString()) });
    return Response.json({});
  } });
  const result = await f.run();
  assert.equal(result.code, 0); assert.equal(received.length, 3);
  const evidence = result.report.observability;
  assert.equal(evidence.status, 'accepted'); assert.equal(evidence.verification, 'unverified');
  assert.equal(evidence.native.admittedRecords, 2); assert.equal(evidence.controller.admittedRecords, 1);
  assert(received.every(item => item.headers.get('authorization') === 'Bearer other-braintrust'));
  assert.equal(received[0].headers.get('x-bt-parent'), costRuntime.exportBraintrustAttemptParent(evidence));
  assert.equal(received[2].headers.get('x-bt-parent'), `project_id:${f.manifest.observability.projectId}`);
  const root = received[2].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(root.traceId, evidence.traceId); assert.equal(root.spanId, evidence.spanId);
  assert(root.attributes.some(item => item.key === 'paperclip.eval.request_sha256' && item.value.stringValue === f.manifest.attempts[0].requestSha256));
  assert(!JSON.stringify(root).includes('synthetic-native-content'));
  const archive = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: f.environment });
  assert(!JSON.stringify(archive).includes('other-braintrust'));
  await rm(f.manifest.outputDirectory, { recursive: true });
  await rm(f.requests[0].request.session.workingDirectory, { recursive: true });
  const summary = await summarizeControlledEvidence([archive]);
  assert.equal(summary.incompleteAttempts, 0); assert.equal(summary.campaigns[0].attempts[0].observability.status, 'accepted');
  assert.equal(summary.campaigns[0].operatingHeldUsd, '0.004000000');
});

test('native capacity, capture, selection and operating bound changes require new qualification', async t => {
  const f = await fixture(t, { observability: true });
  for (const mutate of [
    value => { value.observability.nativeLimits.maxTotalBytes++; },
    value => { value.observability.capture.userPrompts = true; },
    value => { value.observability.projectId = '22222222-2222-4222-8222-222222222222'; },
    value => { value.attempts[0].requestSha256 = 'c'.repeat(64); },
    value => { value.overhead.components.find(item => item.component === 'observability').provisionalBound.evidenceSha256 = 'c'.repeat(64); },
    value => { delete value.observability.provisionalBound; },
  ]) { const manifest = structuredClone(f.manifest); mutate(manifest); assert.throws(() => validateManifest(manifest)); }
  const noKey = { ...f.environment }; delete noKey.BRAINTRUST_API_KEY;
  await assert.rejects(runControlledEval({ manifestPath: f.manifestPath, ...f.requests[0], environment: noKey }), /observability credential/);
  await assert.rejects(readFile(join(f.manifest.outputDirectory, 'admission.json')), { code: 'ENOENT' });
});

for (const fault of ['partial', 'quota', 'leak']) test(`native ${fault} preserves model cost and holds the unresolved attempt`, async t => {
  const f = await fixture(t, { observability: true, requests: 1, otelRequests: fault === 'quota' ? 3 : 1,
    leakOtlpToken: fault === 'leak', otlpTransport: async url => fault === 'partial'
      ? Response.json({ partialSuccess: String(url).endsWith('/logs') ? { rejectedLogRecords: 1 } : { rejectedSpans: 1 } }) : Response.json({}) });
  const result = await f.run();
  assert.equal(result.code, 2); assert.equal(result.report.status, 'incomplete');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000'); assert.equal(summary.committedUsd, '0.014000000');
  const artifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  assert.equal(artifact.accountingFailure.retryable, false);
  if (fault === 'leak') { assert.equal(artifact.leaked, '[redacted]'); assert.equal(result.report.secretExcluded, false); }
});

test('offline replay refuses lost receipts and forged acceptance even when file hashes are updated', async t => {
  const f = await fixture(t, { observability: true, requests: 1 }); await f.run();
  const root = attemptDirectory(f.manifest, 'attempt-0'), path = join(root, 'otlp-native.jsonl');
  const original = await readFile(path);
  await rm(path);
  assert.equal((await summarizeControlledCampaign(f.manifest)).incompleteAttempts, 1);
  const rows = original.toString().trim().split('\n').map(line => JSON.parse(line));
  rows.find(row => row.type === 'outcome').outcome = 'partial';
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path, bytes);
  const reportPath = join(root, 'result.json'), report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.observability.receiptHashes.native = sha256(bytes); await writeFile(reportPath, JSON.stringify(report));
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 1); assert.equal(summary.committedUsd, '0.014000000');
});

test('cancellation aborts a pending native export and retains its uncertain receipt and model allocation', async t => {
  const cancellation = new AbortController(); let aborted = false;
  const f = await fixture(t, { observability: true, requests: 1, otlpTransport: async (_url, init) => {
    queueMicrotask(() => cancellation.abort());
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')); }, { once: true }));
  } });
  const result = await f.run(0, () => success(), cancellation.signal);
  assert.equal(result.code, 2); assert.equal(aborted, true); assert.equal(result.report.child.stopped, 'controller_cancelled');
  const rows = (await readFile(join(attemptDirectory(f.manifest, 'attempt-0'), 'otlp-native.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.type === 'outcome').outcome, 'uncertain'); assert.equal(rows.at(-1).type, 'closed');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000'); assert.equal(summary.committedUsd, '0.014000000');
});

test('lost ledger finalization still closes both OTLP relays', async t => {
  const f = await fixture(t, { observability: true, requests: 1 });
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const result = await f.run(0, async () => { await rm(join(root, 'ledger.jsonl')); return success(); });
  assert.equal(result.code, 2); assert.equal(result.report.failure, 'ledger_evidence_invalid');
  assert.equal((await summarizeControlledCampaign(f.manifest)).committedUsd, '0.014000000');
  for (const file of ['otlp-native.jsonl', 'otlp-controller.jsonl']) {
    const rows = (await readFile(join(root, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.at(-1).type, 'closed');
  }
  const descriptor = JSON.parse(await readFile(join(root, 'observability.json'), 'utf8'));
  await assert.rejects(fetch(descriptor.baseUrl + '/v1/logs'));
});

for (const nativeFault of ['partial', 'quota']) test(`root includes ${nativeFault} native export failure before finalization`, async t => {
  let rootPayload;
  const f = await fixture(t, { observability: true, requests: 1, otelRequests: nativeFault === 'quota' ? 3 : 1,
    otlpTransport: async (url, init) => {
      if (new Headers(init.headers).get('x-bt-parent').startsWith('project_id:')) {
        rootPayload = JSON.parse(Buffer.from(init.body).toString()); return Response.json({});
      }
      return nativeFault === 'partial' ? Response.json({ partialSuccess: String(url).endsWith('/logs') ? { rejectedLogRecords: 1 } : { rejectedSpans: 1 } }) : Response.json({});
    } });
  const result = await f.run();
  assert.equal(result.code, 2); assert.equal(result.report.observability.traceFailure, 'native_export_incomplete');
  const attributes = rootPayload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert(attributes.some(item => item.key === 'paperclip.eval.controller_status_before_root_export' && item.value.stringValue === 'incomplete'));
});

test('cancellation during root export stops forwarding and cannot close the attempt successfully', async t => {
  const cancellation = new AbortController(); let rootAborted = false;
  const f = await fixture(t, { observability: true, requests: 1, otlpTransport: async (_url, init) => {
    if (!new Headers(init.headers).get('x-bt-parent').startsWith('project_id:')) return Response.json({});
    queueMicrotask(() => cancellation.abort());
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { rootAborted = true; reject(new Error('synthetic root abort')); }, { once: true }));
  } });
  const result = await f.run(0, () => success(), cancellation.signal);
  assert.equal(rootAborted, true); assert.equal(result.code, 2); assert.equal(result.report.failure, 'controller_cancelled');
  assert.equal(result.report.status, 'incomplete'); assert.equal(result.report.cleanupVerified, true);
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const rows = (await readFile(join(root, 'otlp-controller.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.type === 'outcome').outcome, 'uncertain'); assert.equal(rows.at(-1).type, 'closed');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.committedUsd, '0.014000000'); assert.equal(summary.knownUsd, '0.000068000');
});


test('hosted workers reject reruns and identity drift before requests, while retained evidence replays offline', async t => {
  const f = await fixture(t);
  f.manifest.campaignId = 'gha-12345-1';
  f.manifest.hosted = { repository: 'paperclipai/paperclip', runId: '12345', runAttempt: 1, workflowRevision: 'c'.repeat(40) };
  await f.save();
  const context = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' };
  let calls = 0;
  const transport = async () => { calls++; return success(); };
  for (const [key, value] of Object.entries(context)) {
    for (const wrong of [undefined, key === 'GITHUB_RUN_ATTEMPT' ? '2' : 'wrong']) {
      Object.assign(f.environment, context, { [key]: wrong });
      await assert.rejects(f.run(0, transport), /current first-attempt worker/);
      assert.equal(calls, 0);
      await assert.rejects(readdir(f.manifest.outputDirectory), { code: 'ENOENT' });
    }
    f.environment[key] = value;
  }
  Object.assign(f.environment, context);
  const command = [fileURLToPath(new URL('./archive.mjs', runtime)), 'verify', f.manifestPath, f.requests[0].requestPath];
  const verify = promisify(execFile);
  await verify(process.execPath, command, { env: { PATH: process.env.PATH, ...context }, timeout: 15000 });
  await assert.rejects(verify(process.execPath, command, {
    env: { PATH: process.env.PATH, ...context, GITHUB_RUN_ATTEMPT: '2' }, timeout: 15000,
  }), /current first-attempt worker/);
  assert.equal(calls, 0);
  assert.equal((await f.run(0, transport)).code, 0);
  assert.equal(calls, 2);
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: f.environment });
  const replay = await summarizeControlledEvidence([bundle], { environment: {} });
  assert.equal(replay.incompleteAttempts, 0);
  assert.equal(replay.campaigns[0].campaignId, 'gha-12345-1');
});

test('hosted context requires a manifest identity and rejects invalid or later-attempt manifests', async t => {
  const f = await fixture(t);
  let calls = 0;
  const transport = async () => { calls++; return success(); };
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']) {
    f.environment[key] = key === 'GITHUB_SHA' ? 'c'.repeat(40) : 'true';
    await assert.rejects(f.run(0, transport), /requires a hosted controller identity/);
    delete f.environment[key];
  }
  const hosted = { repository: 'paperclipai/paperclip', runId: '12345', runAttempt: 1, workflowRevision: 'c'.repeat(40) };
  f.manifest.campaignId = 'gha-12345-1';
  for (const change of [{ repository: '' }, { repository: 'paperclip' }, { runId: 12345 }, { runId: '012345' },
    { runAttempt: 2 }, { workflowRevision: 'master' }, { workflowRevision: ['c'.repeat(40)] }, { unexpected: true }]) {
    f.manifest.hosted = { ...hosted, ...change };
    assert.throws(() => validateManifest(f.manifest), /hosted controller identity|controller fields/);
  }
  f.manifest.hosted = hosted;
  await f.save();
  await assert.rejects(f.run(0, transport), /current first-attempt worker/);
  assert.equal(calls, 0);
  await assert.rejects(readdir(f.manifest.outputDirectory), { code: 'ENOENT' });
  f.manifest.campaignId = 'gha-12345-2';
  assert.throws(() => validateManifest(f.manifest), /hosted controller identity/);
});

for (const name of ['observability.json', 'otlp-native.jsonl', 'otlp-controller.jsonl']) for (const kind of ['fifo', 'symlink', 'oversized']) {
  test(`native post-child ${name} rejects ${kind} and retains model cost plus the full hold`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, { requests: 1, observability: true, invalidEvidence: name, invalidFileType: kind });
    const result = await f.run();
    assert.equal(result.code, 2);
    const summary = await summarizeControlledCampaign(f.manifest);
    assert.equal(summary.incompleteAttempts, 1);
    assert.equal(summary.knownUsd, '0.000068000');
    assert.equal(summary.committedUsd, '0.014000000');
  });
}

test('credential redaction replaces a swapped symlink without changing its target', async t => {
  const f = await fixture(t, { leakToken: true, requests: 0 });
  const result = await f.run();
  assert.equal(result.report.secretExcluded, false);
  const path = join(attemptDirectory(f.manifest, 'attempt-0'), 'provider-artifact.json');
  const bytes = await readRegularFile(path, 16_777_216);
  const target = join(f.root, 'untouched-target'); await writeFile(target, 'target must remain unchanged');
  await rm(path); await symlink(target, path);
  await replaceEvidenceFile(path, bytes);
  assert.equal(await readFile(target, 'utf8'), 'target must remain unchanged');
  assert.deepEqual(await readRegularFile(path, 16_777_216), bytes);
  await symlink(target, `${path}.tmp`);
  await assert.rejects(replaceEvidenceFile(path, bytes), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'target must remain unchanged');
});

test('missing provider artifacts cannot bypass immutable result binding', async t => {
  const f = await fixture(t, { missingArtifact: true, requests: 0 }); await f.run();
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  assert.equal(bundle.files['provider-artifact.json'], undefined);
  assert.equal(JSON.parse(Buffer.from(bundle.files['result.json'].base64, 'base64')).providerArtifactSha256, undefined);
  const directory = join(f.root, 'runs', 'attempt-0'); await mkdir(directory, { recursive: true });
  const artifact = JSON.parse(await readFile(f.requests[0].outputPath, 'utf8'));
  for (const [name, value] of Object.entries({ 'request.json': f.requests[0].request, 'artifact.json': artifact, 'controller-evidence.json': bundle })) await writeFile(join(directory, name), JSON.stringify(value));
  await readAttemptControlledEvidence(directory);
  for (const mutate of [
    value => { value.usage = { estimatedCostNanodollars: 0 }; },
    value => { value.turn = { status: 'completed', assistantText: 'forged success' }; },
    value => { value.controllerAccounting.cleanupVerified = true; },
  ]) {
    const changed = structuredClone(artifact); mutate(changed);
    await writeFile(join(directory, 'artifact.json'), JSON.stringify(changed));
    await assert.rejects(readAttemptControlledEvidence(directory), /Immutable result disagrees/);
  }
  const malformed = structuredClone(bundle), bytes = Buffer.from('{');
  malformed.files['result.json'] = { sizeBytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
  await writeFile(join(directory, 'controller-evidence.json'), JSON.stringify(malformed));
  await assert.rejects(readAttemptControlledEvidence(directory), /Malformed immutable controller result proof/);

});


test('failed final OTLP receipt write returns its saved incomplete report', async t => {
  const f = await fixture(t, { observability: true, requests: 1 });
  const root = attemptDirectory(f.manifest, 'attempt-0');
  const probe = await open(join(f.root, 'prototype-probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile;
  await probe.close();
  let failed = false;
  prototype.writeFile = async function (data, ...options) {
    if (String(data).includes('"type":"closed"')) {
      const native = await stat(join(root, 'otlp-native.jsonl')).catch(() => null);
      if (native && (await this.stat()).ino === native.ino) {
        failed = true;
        throw Object.assign(new Error('synthetic final receipt write failure'), { code: 'ENOSPC' });
      }
    }
    return original.call(this, data, ...options);
  };
  t.after(() => { prototype.writeFile = original; });
  const result = await f.run();
  assert.equal(failed, true); assert.equal(result.code, 2);
  assert.equal(result.report.status, 'incomplete');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'result.json'), 'utf8')), result.report);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.knownUsd, '0.000068000'); assert.equal(summary.committedUsd, '0.014000000');
  const controller = (await readFile(join(root, 'otlp-controller.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(controller.at(-1).type, 'closed');
  const descriptor = JSON.parse(await readFile(join(root, 'observability.json'), 'utf8'));
  await assert.rejects(fetch(descriptor.baseUrl + '/v1/logs'));
});


for (const providerProfile of ['codex', 'claude']) test(`controller descriptor round trips through the real ${providerProfile} CLI validator`, async t => {
  const f = await fixture(t, { providerProfile, observability: true, realObservabilityValidator: true, requests: 0 });
  const result = await f.run();
  assert.equal(result.code, 0, JSON.stringify(result.report) + '\n' + await readFile(join(attemptDirectory(f.manifest, 'attempt-0'), 'stderr.log'), 'utf8'));
  assert.equal(result.report.observability.status, 'accepted');
  const bundle = await packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0' });
  assert.equal((await summarizeControlledEvidence([bundle])).incompleteAttempts, 0);
});

test('retained failure codes distinguish native startup, child exit and invalid artifacts', async t => {
  const startup = await fixture(t, { observability: true, requests: 0 });
  const root = attemptDirectory(startup.manifest, 'attempt-0');
  const probe = await open(join(startup.root, 'startup-probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), original = prototype.sync; await probe.close();
  let failed = false;
  prototype.sync = async function (...args) {
    const native = await stat(join(root, 'otlp-native.jsonl')).catch(() => null);
    if (native && (await this.stat()).ino === native.ino) {
      failed = true; throw Object.assign(new Error('synthetic native startup persistence failure'), { code: 'ENOSPC' });
    }
    return original.call(this, ...args);
  };
  t.after(() => { prototype.sync = original; });
  const result = await startup.run();
  prototype.sync = original;
  assert.equal(failed, true); assert.equal(result.code, 2);
  assert.equal(result.report.failure, 'observability_start_failed');
  assert.equal((await summarizeControlledCampaign(startup.manifest)).committedUsd, '0.014000000');
  const child = await fixture(t, { failChild: true, requests: 0 });
  assert.equal((await child.run()).report.failure, 'child_failed');
  const artifact = await fixture(t, { missingRoute: true, requests: 0 });
  assert.equal((await artifact.run()).report.failure, 'artifact_invalid');
});


test('model readiness rejects a missing terminal model receipt even when its reservation has a reviewed bound', async t => {
  const f = await fixture(t, { requests: 1 });
  f.manifest.overhead.accountingReadiness = 'model_requests';
  for (const component of f.manifest.overhead.components) delete component.provisionalBound;
  await f.save();
  const result = await f.run(0, async () => Response.json({ error: 'synthetic refusal' }, { status: 429 }));
  assert.equal(result.report.failure, 'request_accounting_unbounded');
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 1);
  assert.equal(summary.heldUsd, '0.014000000');
  assert.equal(summary.operatingReconciliation, 'pending');
});


test('model readiness rejects zero model requests and keeps the full allocation', async t => {
  const f = await fixture(t, { requests: 0 });
  f.manifest.overhead.accountingReadiness = 'model_requests';
  for (const component of f.manifest.overhead.components) delete component.provisionalBound;
  await f.save();
  const result = await f.run();
  assert.equal(result.report.failure, 'request_accounting_unbounded');
  assert.equal(result.report.accounting.requests.length, 0);
  const summary = await summarizeControlledCampaign(f.manifest);
  assert.equal(summary.incompleteAttempts, 1); assert.equal(summary.heldUsd, '0.014000000');
});

test('mixed-policy private histories keep the pending operating reconciliation warning', async t => {
  const model = await fixture(t, { requests: 1 }), strict = await fixture(t, { requests: 1 });
  model.manifest.campaignId = 'model-readiness-history';
  model.manifest.overhead.accountingReadiness = 'model_requests';
  for (const component of model.manifest.overhead.components) delete component.provisionalBound;
  await model.save(); await model.run(); await strict.run();
  const bundles = await Promise.all([model, strict].map(f => packControlledAttempt({ manifest: f.manifest, attemptId: 'attempt-0', environment: f.environment })));
  const history = await summarizeControlledEvidence(bundles);
  assert.equal(history.incompleteAttempts, 0); assert.equal(history.operatingHeldUsd, '0.008000000');
  assert.equal(history.accountingReadiness, undefined); assert.equal(history.operatingReconciliation, 'pending');
});
