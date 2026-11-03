import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, fork } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudStreamMarker } from './cloud-ui.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { repository, evidenceDir, origin } = config;
const priorIds = new Set();
async function retainedResourceIds(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await retainedResourceIds(path); else if (entry.name === 'resource-ledger.json') for (const resource of JSON.parse(await readFile(path, 'utf8')).resources) priorIds.add(resource.providerLeaseId); } }
await retainedResourceIds(evidenceDir);
const priorResourceCount = priorIds.size;
const RESOURCE_CAP = 1; // One fresh sandbox per reproduction; no automatic retry.
assert.ok(priorResourceCount < RESOURCE_CAP, 'whole_qualification_cloud_resource_bound');
const IMAGE = 'ghcr.io/paperclipai/paperclip-daytona-runner@sha256:bff4c3f291087a0eeae37e4c20dd51857b92833eaf73ba3aca4157f37de1e109';
const NODE = '/opt/paperclip-runner/provider-pack/node_modules/node/bin/node';
const require = createRequire(join(repository, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const pluginRequire = createRequire(join(repository, 'packages/plugins/sandbox-providers/daytona/package.json'));
const sdkEntry = pluginRequire.resolve('@daytonaio/sdk');
const sdkPackage = JSON.parse(await readFile(join(dirname(dirname(sdkEntry)), 'package.json'), 'utf8'));
assert.equal(sdkPackage.version, '0.203.0');
const key = process.env.DAYTONA_API_KEY?.trim();
assert.ok(key && key.length > 12, 'credential_binding_empty');
for (const name of Object.keys(process.env)) if (/^(OP_|DAYTONA|BOXD)|API_KEY|TOKEN|SECRET/i.test(name)) delete process.env[name];
const { Daytona } = await import(pathToFileURL(sdkEntry).href);
const daytona = new Daytona({ apiKey: key, apiUrl: 'https://app.daytona.io/api' });
const safeError = error => ({ name: String(error?.name ?? 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60), status: Number(error?.statusCode ?? error?.status ?? error?.response?.status) || null, code: /^[-a-zA-Z0-9_]+$/.test(error?.code ?? '') ? error.code : null });
const redact = text => String(text).replaceAll(key, '[REDACTED]');
const sensitiveValues = new Set([key]);
function sanitized(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (/api.?key|authorization|password|secret|token$|^headers$/i.test(name)) {
      if (typeof entry === 'string' && entry.length > 12) sensitiveValues.add(entry);
      return [name, '[REDACTED]'];
    }
    return [name, sanitized(entry)];
  }));
  return value;
}
const summary = { schema: 'paperclip.real-cloud-stop-qualification.v1', status: 'running', startedAt: new Date().toISOString(), revision: config.revision, build: config.build, hashes: config.hashes, platform: config.platform, dependencies: { provider: 'deterministic Codex app-server fixture with real sleep60; no model call', sandbox: 'real Daytona', sdk: sdkPackage.version, image: IMAGE, controller: 'normal production-built local Paperclip', actualLlmJourney: 'separate real OpenCode/DeepSeek acceptance' }, checks: {}, cleanup: {} };
let phase = 'bootstrap';
summary.priorResourceCount = priorResourceCount;
const ledgerPath = join(evidenceDir, 'resource-ledger.json');
const ledger = { startedAt: summary.startedAt, hardDeadlineAt: Date.now() + 30 * 60_000, resources: [] };
await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
const watchdog = fork(join(import.meta.dirname, 'watchdog.mjs'), [repository, ledgerPath, join(evidenceDir, 'watchdog-receipt.json')], { env: cleanEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
const armed = new Promise((resolve, reject) => { watchdog.once('message', resolve); watchdog.once('exit', () => reject(new Error('watchdog_failed_before_arm'))); });
watchdog.send({ key, deadlineAt: ledger.hardDeadlineAt });
await armed;
summary.watchdog = { armed: true, deadlineAt: ledger.hardDeadlineAt, pid: watchdog.pid };
const save = () => writeFile(join(evidenceDir, 'qualification-summary.json'), JSON.stringify(sanitized(summary), null, 2));
const evidence = async (name, data) => writeFile(join(evidenceDir, name), JSON.stringify(sanitized(data), null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, body) {
  const response = await fetch(new URL(route, origin), { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) { const error = new Error(`api_${method}_${response.status}_${route}`); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}
async function poll(label, load, accept, timeout = 120_000, interval = 250) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await load(); if (accept(result)) return result; await pause(interval); }
  throw new Error(`timeout_${label}`);
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function remote(sandbox, code, cwd) {
  const command = `/usr/bin/env -i PATH=/usr/bin:/bin ${quote(NODE)} -e ${quote(code)}`;
  const result = await sandbox.process.executeCommand(command, cwd, {}, 10);
  assert.equal(result.exitCode, 0, 'remote_observer_nonzero');
  assert.ok(typeof result.result === 'string' && result.result.length < 65536, 'remote_observer_bound');
  return JSON.parse(result.result);
}
const expectedLabels = runId => ({ 'paperclip-provider': 'daytona', 'paperclip-company-id': config.company.id, 'paperclip-environment-id': environment.id, 'paperclip-run-id': runId, 'paperclip-reuse-lease': 'false' });
const assertOwned = (sandbox, row) => { assert.equal(sandbox.id, row.providerLeaseId); for (const [key, value] of Object.entries(row.expectedLabels)) assert.equal(sandbox.labels?.[key], value, `provider_label_${key}`); };
async function providerState(row) {
  try { const sandbox = await daytona.get(row.providerLeaseId); assertOwned(sandbox, row); return { id: sandbox.id, state: String(sandbox.state), labels: Object.fromEntries(Object.keys(row.expectedLabels).map(key => [key, sandbox.labels[key]])), observedAt: Date.now() }; }
  catch (error) { if (Number(error?.status ?? error?.response?.status) === 404 || error?.name === 'DaytonaNotFoundError') return { id: row.providerLeaseId, state: 'absent', observedAt: Date.now() }; throw error; }
}
async function eventsFor(runId) {
  const rows = [];
  while (true) { const page = await api('GET', `/api/heartbeat-runs/${runId}/events?afterSeq=${rows.at(-1)?.seq ?? 0}&limit=1000`); rows.push(...page); if (page.length < 1000) return rows; }
}
async function runsFor(issueId) {
  const rows = await api('GET', `/api/companies/${config.company.id}/heartbeat-runs?agentId=${config.agent.id}&limit=100`);
  const runs = await Promise.all(rows.map(row => api('GET', `/api/heartbeat-runs/${row.id}`)));
  return runs.filter(run => run.nativeIssueId === issueId || run.contextSnapshot?.issueId === issueId);
}
let environment, browser, context, page, issueId;
try {
  await api('PATCH', '/api/instance/settings/experimental', { enableRunnerPreviewIngress: true });
  const installed = await api('GET', '/api/plugins');
  const plugin = installed.find(value => value.pluginKey === 'paperclip.daytona-sandbox-provider') ?? await api('POST', '/api/plugins/install', { packageName: join(repository, 'packages/plugins/sandbox-providers/daytona'), isLocalPath: true });
  summary.plugin = { id: plugin.id, pluginKey: plugin.pluginKey, version: plugin.manifest?.version };
  await poll('plugin_ready', async () => {
    const dashboard = await api('GET', '/api/plugins/paperclip.daytona-sandbox-provider/dashboard');
    const caps = await api('GET', `/api/companies/${config.company.id}/environments/capabilities`);
    return { dashboard, provider: caps.sandboxProviders?.daytona };
  }, value => value.dashboard.worker?.status === 'running' && value.provider?.status === 'supported' && value.provider.pluginKey === 'paperclip.daytona-sandbox-provider');
  const secret = await api('POST', `/api/companies/${config.company.id}/secrets`, { name: `Bounded real cloud Stop Daytona key ${Date.now()}`, key: `daytona_cloud_stop_${Date.now()}`, value: key });
  environment = await api('POST', `/api/companies/${config.company.id}/environments`, { name: 'Bounded real cloud Stop', description: 'Owned qualification; hardTTL30m; one sandbox', driver: 'sandbox', config: { provider: 'daytona', apiKey: { type: 'secret_ref', secretId: secret.id, version: 'latest' }, image: IMAGE, cpu: 4, memory: 4, disk: 10, reuseLease: false, runnerLifecycleMode: 'per_turn', autoStopInterval: 5, autoArchiveInterval: 15, autoDeleteInterval: 30, ttlMinutes: 30, timeoutMs: 300000, livenessTimeoutMs: 30000 }, envVars: {} });
  summary.environment = { id: environment.id, config: { image: IMAGE, cpu: 4, memory: 4, disk: 10, reuseLease: false, runnerLifecycleMode: 'per_turn', autoStopInterval: 5, autoArchiveInterval: 15, autoDeleteInterval: 30, ttlMinutes: 30 } };
  const agent = await api('PATCH', `/api/agents/${config.agent.id}`, { defaultEnvironmentId: environment.id });
  assert.equal(agent.defaultEnvironmentId, environment.id);
  summary.checks.normalApiBindings = true;
  await save();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: join(evidenceDir, 'video'), size: { width: 1440, height: 1000 } } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  const { createTaskThroughUi } = await import(pathToFileURL(join(repository, 'tests/runner-e2e/user-actions.ts')).href);
  const created = await createTaskThroughUi({ page, origin, issuePrefix: config.company.issuePrefix, agentName: config.agent.name, title: `Real cloud Stop ${Date.now()}`, prompt: 'CLOUD-STOP qualification: stream progress, then run sleep 60. The operator will Stop this task before it completes. Do not finish early.', workMode: 'standard', requireExplicitTitle: true });
  issueId = created.issueId; summary.issueId = issueId;
  await page.goto(new URL(`/${config.company.issuePrefix}/issues/${issueId}`, origin).href);
  const admitted = await poll('one_native_run_lease', async () => {
    const runs = await runsFor(issueId);
    const leases = await api('GET', `/api/environments/${environment.id}/leases`);
    // Ledger every admitted host-owned ID before further observer work.
    for (const lease of leases) if (lease.heartbeatRunId && lease.providerLeaseId && !ledger.resources.some(row => row.providerLeaseId === lease.providerLeaseId)) {
      const row = { providerLeaseId: lease.providerLeaseId, leaseId: lease.id, runId: lease.heartbeatRunId, expectedLabels: expectedLabels(lease.heartbeatRunId), admittedAt: Date.now() };
      const sandbox = await daytona.get(row.providerLeaseId); assertOwned(sandbox, row);
      ledger.resources.push(row); await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
      console.log(JSON.stringify({ resourceAdmitted: row.providerLeaseId, leaseId: row.leaseId, runId: row.runId, ttlMinutes: 30 }));
    }
    // These resources already exist. Record every observed owned ID before a
    // bound failure so finally/watchdog cleanup can retire all of them.
    assert.ok(priorResourceCount + ledger.resources.length <= RESOURCE_CAP, 'cloud_resource_bound');
    if (runs.length !== 1) return null;
    if (!['running', 'queued'].includes(runs[0].status)) throw new Error('native_run_terminal_before_admission');
    const lease = leases.find(row => row.heartbeatRunId === runs[0].id && row.status === 'active' && row.providerLeaseId && row.metadata?.remoteCwd);
    return lease ? { run: runs[0], lease } : null;
  }, Boolean, 360000);
  const { run, lease } = admitted; summary.runId = run.id; summary.leaseId = lease.id; summary.providerLeaseId = lease.providerLeaseId;
  assert.equal(lease.metadata.image, IMAGE); assert.equal(lease.metadata.reuseLease, false);
  const row = ledger.resources.find(row => row.providerLeaseId === lease.providerLeaseId);
  assert.equal(ledger.resources.length, 1, 'unexpected_second_sandbox');
  const sandbox = await daytona.get(row.providerLeaseId); assertOwned(sandbox, row);
  const cwd = lease.metadata.remoteCwd;
  assert.ok(typeof cwd === 'string' && cwd.startsWith('/') && cwd !== '/' && cwd.length < 512);
  phase = 'runtime_verification';
  const runtime = await poll('staged_runtime_before_test', () => remote(sandbox, `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const root=${JSON.stringify(cwd)},runner=root+'/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd',fixture=root+'/.paperclip-runtime/paperclip-runner/bin/codex';if(!fs.existsSync(runner)||!fs.existsSync(fixture)||!fs.existsSync(root+'/.cloud-stop-fixture.json')){console.log('null');process.exit(0)}const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log(JSON.stringify({node:process.execPath,nodeVersion:process.version,nodeSha256:sha(process.execPath),runnerSha256:sha(runner),fixtureSha256:sha(fixture),runnerMetadata:JSON.parse(cp.execFileSync(runner,['--build-metadata'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}})),fixtureState:JSON.parse(fs.readFileSync(root+'/.cloud-stop-fixture.json','utf8')).phase}));`, cwd), value => value?.fixtureState === 'awaiting-observer', 60000, 200);
  assert.equal(runtime.runnerSha256, config.hashes.linuxRunner); assert.equal(runtime.fixtureSha256, config.hashes.provider);
  const version = runtime.nodeVersion.match(/^v(\d+)\.(\d+)\./); assert.ok(version && (Number(version[1]) > 24 || Number(version[1]) === 24 && Number(version[2]) >= 11), 'image_node_minimum');
  summary.runtime = runtime; summary.checks.currentDaemonAndFixture = true;
  const nativeRun = await poll('native_running_before_test', () => api('GET', `/api/heartbeat-runs/${run.id}`), value => value.runtimeMode === 'native' && value.status === 'running', 30000);
  summary.nativeAdmission = { runtimeMode: nativeRun.runtimeMode, status: nativeRun.status, runtimeModeReason: nativeRun.runtimeModeReason };
  await remote(sandbox, `require('node:fs').writeFileSync(${JSON.stringify(cwd + '/.cloud-stop-start')},'verified',{mode:0o600});console.log('{"started":true}');`, cwd);
  const snapshotCode = `const fs=require('node:fs');const root=${JSON.stringify(cwd)},p=root+'/.cloud-stop-fixture.json';if(!fs.existsSync(p)){console.log('null');process.exit(0)}const s=JSON.parse(fs.readFileSync(p,'utf8'));let live=false,children=[];if(s.child){try{const t=fs.readFileSync('/proc/'+s.child.pid+'/stat','utf8'),f=t.slice(t.lastIndexOf(') ')+2).trim().split(/\\s+/);live=f[19]===s.child.startTicks&&f[0]!=='Z'}catch{}for(const n of fs.readdirSync('/proc')){if(!/^\\d+$/.test(n))continue;try{const t=fs.readFileSync('/proc/'+n+'/stat','utf8'),f=t.slice(t.lastIndexOf(') ')+2).trim().split(/\\s+/);if(Number(f[2])===s.child.pgid&&f[0]!=='Z')children.push({pid:Number(n),ppid:Number(f[1]),pgid:Number(f[2]),startTicks:f[19],command:fs.readFileSync('/proc/'+n+'/cmdline','utf8').replaceAll('\\0',' ')})}catch{}}}console.log(JSON.stringify({observedAtMs:Date.now(),state:s,childLive:live,groupProcesses:children,effectPresent:fs.existsSync(root+'/.cloud-stop-forbidden-effect')}));`;
  const active = await poll('actual_sleep', () => remote(sandbox, snapshotCode, cwd), value => value?.state.phase === 'sleeping' && value.childLive && value.groupProcesses.some(child => /sleep 60/.test(child.command)), 60000, 150);
  assert.equal(active.effectPresent, false); summary.actualProcessBeforeStop = active;
  phase = 'visible_streaming'; await save();
  const marker = cloudStreamMarker(page, run.id);
  const visible = async () => [await marker.innerText()];
  await expect(marker).toBeVisible({ timeout: 10000 });
  assert.equal((await api('GET', `/api/heartbeat-runs/${run.id}`)).status, 'running');
  summary.checks.visibleStreamingBeforeTerminal = true; summary.checks.realSleepObserved = true;
  const freshRuns = await runsFor(issueId);
  assert.equal(freshRuns.length, 1, 'fresh_owned_task_has_only_one_run');
  assert.equal(freshRuns[0].id, run.id); assert.equal(freshRuns[0].runtimeMode, 'native'); assert.equal(freshRuns[0].status, 'running');
  const sourceMarker = (await eventsFor(run.id)).map(row => row.payload?.prpEvent).find(event => event?.runId === run.id && event.eventType === 'item.delta' && event.payload.kind === 'agentMessage' && event.payload.text?.trim() === 'CLOUD-STOP-STREAM: real sandbox process is starting.');
  assert.ok(sourceMarker?.sourceEventId && sourceMarker.sourceSeq > 0, 'actual_current_run_normalized_agent_message_marker');
  summary.visibleSourceMarker = { eventType: sourceMarker.eventType, kind: sourceMarker.payload.kind, text: sourceMarker.payload.text, sourceEventId: sourceMarker.sourceEventId, sourceSeq: sourceMarker.sourceSeq };
  await page.screenshot({ path: join(evidenceDir, 'before-stop.png'), fullPage: true });
  await evidence('before-stop.json', { lease: { ...lease, metadata: { ...lease.metadata, workspaceSentinel: undefined } }, active, runtime, events: await eventsFor(run.id) });
  // Independent observer captures retirement before the deterministic provider
  // fixture in REAL Daytona emits its interrupted terminal. No server hook or
  // provider receipt is fabricated.
  const retirement = poll('independent_child_retirement', () => remote(sandbox, snapshotCode, cwd), value => value?.state.phase === 'interrupted-child-retired' && !value.childLive && value.groupProcesses.length === 0 && !value.effectPresent, 20000, 100).then(async value => {
    summary.retirement = value;
    await remote(sandbox, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(cwd + '/.cloud-stop-observer-release')},'observed',{mode:0o600});console.log('{"released":true}');`, cwd);
    return value;
  });
  void retirement.catch(() => {});
  const stopButton = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stopButton).toHaveCount(1); await expect(stopButton).toBeVisible(); await expect(stopButton).toBeEnabled();
  const immediate = await remote(sandbox, snapshotCode, cwd);
  assert.equal(immediate.state.child.pid, active.state.child.pid);
  assert.equal(immediate.state.child.startTicks, active.state.child.startTicks);
  assert.equal(immediate.state.child.bootId, active.state.child.bootId);
  assert.ok(immediate.childLive && immediate.groupProcesses.some(child => child.command.trim() === 'sleep 60'), 'independent_sleep_active_immediately_before_stop');
  assert.equal(immediate.effectPresent, false);
  const observedProcessAgeMs = immediate.observedAtMs - immediate.state.startedAtMs;
  assert.ok(observedProcessAgeMs >= 0 && observedProcessAgeMs < 20000, 'sleep_birth_age_immediately_before_stop_under_20s');
  summary.immediateBeforeStop = immediate;
  summary.stopRequestedAt = Date.now();
  phase = 'visible_stop_dispatch'; await save();
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/heartbeat-runs/${run.id}/cancel`), { timeout: 30000 });
  await stopButton.click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, 'visible_stop_response');
  summary.originalStopAcknowledgement = await response.json();
  await retirement;
  const stopped = await poll('native_and_shared_ack', () => api('GET', `/api/heartbeat-runs/${run.id}`), value => value.status === 'cancelled' && value.resultJson?.nativeCancellation?.dispatchState === 'acknowledged' && value.resultJson?.executionCancellation?.state === 'acknowledged', 120000);
  summary.stopSettledAt = Date.now();
  assert.equal(stopped.resultJson.executionCancellation.proof, 'provider_termination_receipt');
  assert.ok(stopped.resultJson.executionCancellation.acknowledgedAt);
  summary.nativeCancellation = stopped.resultJson.nativeCancellation; summary.executionCancellation = stopped.resultJson.executionCancellation;
  summary.checks.nativeAcknowledgement = true; summary.checks.sharedProviderReceiptAcknowledgement = true; summary.checks.independentChildRetirementNoEffect = true;
  const terminalLeases = (await api('GET', `/api/environments/${environment.id}/leases`)).filter(row => row.heartbeatRunId === run.id);
  assert.equal(terminalLeases.length, 1);
  for (const lease of terminalLeases) {
    assert.ok(lease.releasedAt); assert.equal(lease.cleanupStatus, 'success'); assert.ok(['released', 'expired', 'failed'].includes(lease.status));
    const receipt = lease.metadata?.remoteExecutionTermination;
    assert.equal(receipt?.schema, 'paperclip.remote-termination.v1');
    for (const [key, expected] of Object.entries({ companyId: config.company.id, runId: run.id, leaseId: lease.id, provider: 'daytona', providerLeaseId: row.providerLeaseId })) assert.equal(receipt[key], expected);
    assert.ok(['stopped', 'destroyed'].includes(receipt.state)); summary.providerReceipt = receipt;
  }
  summary.independentProviderState = await poll('provider_stopped', () => providerState(row), value => ['stopped', 'archived', 'destroyed', 'absent'].includes(value.state), 120000);
  summary.checks.exactLeaseProviderReceipt = true; summary.checks.independentProviderStopped = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('issue-detail-header')).toBeVisible();
  await expect(page.getByTestId('task-chat-history-loading')).toHaveCount(0);
  await expect.poll(async () => (await visible()).join('\n'), { timeout: 15000 }).toContain('CLOUD-STOP-STREAM');
  await page.screenshot({ path: join(evidenceDir, 'after-stop-reload.png'), fullPage: true });
  await pause(3000);
  const finalRuns = await runsFor(issueId); assert.equal(finalRuns.length, 1); assert.equal(finalRuns[0].id, run.id); assert.equal(finalRuns[0].status, 'cancelled');
  const events = await eventsFor(run.id);
  assert.ok(!events.some(row => row.payload?.prpEvent?.eventType === 'run.result.accepted'), 'no_result_after_stop');
  await evidence('persisted-api-state.json', { run: finalRuns[0], events, leases: terminalLeases, issue: await api('GET', `/api/issues/${issueId}`) });
  summary.eventCount = events.length; summary.checks.reloadAndNoSuccessorOrResult = true;
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed'; summary.failedPhase = phase; summary.error = safeError(error);
  summary.error.message = redact(String(error?.message ?? 'controlled_unknown_failure')).replace(/(X-Daytona-Preview-Token|Authorization|apiKey|previewToken)["']?\s*[:=]\s*["']?[^,\s}"']+/gi, '$1=[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 800);
  // Our authored assertion messages contain only fixed keys/codes. SDK errors
  // remain primitives only; never retain Axios config, headers or raw objects.
  if (error instanceof assert.AssertionError || /^timeout_|^native_|^api_/.test(error?.message ?? '')) summary.error.message = redact(error.message).slice(0, 600);
  await page?.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (issueId && summary.status !== 'passed') {
    try { const runs = await runsFor(issueId); for (const run of runs) if (['running', 'queued'].includes(run.status)) await api('POST', `/api/heartbeat-runs/${run.id}/cancel`); } catch (error) { summary.cleanup.cancelError = safeError(error); }
  }
  if (environment) {
    try { await api('DELETE', `/api/environments/${environment.id}?destroyReusableSandboxLeases=true`); summary.cleanup.normalEnvironmentDelete = true; } catch (error) { summary.cleanup.normalEnvironmentDelete = false; summary.cleanup.normalDeleteError = safeError(error); }
  }
  for (const row of ledger.resources) {
    try {
      let state = await providerState(row);
      if (state.state !== 'absent') { const sandbox = await daytona.get(row.providerLeaseId); assertOwned(sandbox, row); await daytona.delete(sandbox, 90); state = await poll('provider_absent_cleanup', () => providerState(row), value => value.state === 'absent', 90000); summary.cleanup.exactOwnedFallbackDelete = true; }
      (summary.cleanup.providerAbsence ??= []).push(state);
    } catch (error) { summary.cleanup.providerCleanupFailed = safeError(error); summary.status = 'failed'; }
  }
  if (!summary.cleanup.providerCleanupFailed) { watchdog.send('disarm'); summary.cleanup.watchdogDisarmed = true; }
  await context?.tracing.stop({ path: join(evidenceDir, 'trace.zip') }).catch(() => {});
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  summary.finishedAt = new Date().toISOString();
  await save();
  // Exact credential scan before any evidence leaves this owned directory.
  const scan = { files: 0, matches: [] };
  const sensitive = [...sensitiveValues];
  function inspect(bytes, path) { scan.files++; if (sensitive.some(value => bytes.includes(Buffer.from(value)))) scan.matches.push(path); }
  async function scanDirectory(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await scanDirectory(path); else if (entry.isFile()) {
    inspect(await readFile(path), path);
    if (path.endsWith('.zip')) {
      const entries = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n').filter(value => value && !value.endsWith('/'));
      for (const entry of entries) inspect(execFileSync('/usr/bin/unzip', ['-p', path, entry], { maxBuffer: 64 * 1024 * 1024 }), path + '!' + entry);
    }
  } } }
  await scanDirectory(evidenceDir);
  summary.credentialScan = scan; if (scan.matches.length) summary.status = 'failed'; await save();
  console.log(JSON.stringify({ status: summary.status, summary: join(evidenceDir, 'qualification-summary.json'), runId: summary.runId, providerLeaseId: summary.providerLeaseId, checks: summary.checks, cleanup: summary.cleanup, error: summary.error }));
}
if (summary.status !== 'passed') process.exitCode = 1;
