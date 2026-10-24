import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bindRequest, canonical, costRuntime, readJson, sha256, validateManifest } from './manifest.mjs';

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
const absent = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
export const attemptDirectory = (manifest, attemptId) => join(manifest.outputDirectory, sha256(attemptId));

async function runChild(input) {
  const child = spawn(process.execPath, ['--import', input.loader, input.cli, '--request', input.requestPath, '--output', input.artifactPath, '--gateway-config', input.descriptorPath], {
    cwd: input.cwd, env: input.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopped = null, force, escalation;
  const output = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  const stop = reason => {
    if (stopped) return;
    stopped = reason;
    void input.closeGateway().catch(() => {});
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation = new Promise(resolve => {
      force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finally { resolve(); } }, 5000);
    });
  };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    const available = Math.max(0, 1_048_576 - sizes[stream]);
    output[stream].push(bytes.subarray(0, available)); sizes[stream] += bytes.length;
    if (sizes[stream] > 1_048_576) stop('output_limit');
  });
  const onAbort = () => stop('controller_cancelled');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => stop('attempt_deadline'), Math.max(1, input.deadlineAt - Date.now()));
  if (input.signal?.aborted) onAbort();
  try {
    const [code, signal] = await once(child, 'exit');
    if (stopped) {
      let groupPresent = true;
      try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') groupPresent = false; }
      if (groupPresent) await escalation;
    }
    return { code, signal, pid: child.pid, stopped, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() };
  } finally {
    clearTimeout(timeout); clearTimeout(force); input.signal?.removeEventListener('abort', onAbort);
  }
}

export async function runControlledEval({ manifestPath, requestPath, outputPath, environment = process.env, signal, transport }) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Controlled eval process ownership requires Linux or macOS');
  signal?.throwIfAborted();
  const { manifest, manifestSha256 } = validateManifest(await readJson(manifestPath));
  const request = await readJson(requestPath, 8_388_608), attempt = bindRequest(manifest, request);
  try { await lstat(outputPath); throw new Error('Controlled output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (request.session.workingDirectory) {
    const suffix = relative(resolve(request.session.workingDirectory), resolve(manifest.outputDirectory));
    if (!suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) throw new Error('Controller evidence must be outside the disposable workspace');
  }
  const originalCliUrl = pathToFileURL(await realpath(manifest.runnerCli.path)).href;
  const verified = {};
  for (const name of ['runnerCli', 'runnerPackage', 'runnerd']) {
    const artifact = manifest[name], bytes = await readFile(artifact.path);
    if (sha256(bytes) !== artifact.sha256) throw new Error('Controlled eval executable provenance changed');
    if (name !== 'runnerPackage') verified[name] = bytes;
  }
  const provider = attempt.provider === 'codex' ? 'openai' : 'anthropic';
  const keyName = manifest.route === 'braintrust' ? 'BRAINTRUST_API_KEY' : provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const key = environment[keyName];
  if (!key || /[\r\n]/.test(key)) throw new Error('Missing controlled eval upstream credential');
  const model = manifest.models.find(item => item.provider === provider && item.price.model === attempt.model);
  const root = attemptDirectory(manifest, attempt.attemptId);
  await mkdir(manifest.outputDirectory, { recursive: true, mode: 0o700 });
  if (request.session.workingDirectory) {
    const suffix = relative(await realpath(request.session.workingDirectory), await realpath(manifest.outputDirectory));
    if (!suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) throw new Error('Controller evidence resolves inside the disposable workspace');
  }
  await mkdir(root, { mode: 0o700 });
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const deadlineAt = Math.min(Date.parse(manifest.deadlineAt), started + attempt.timeoutMs);
  const limits = { campaignId: manifest.campaignId, maxUsd: attempt.maxUsd, deadlineAt: new Date(deadlineAt).toISOString(),
    maxRequests: attempt.maxRequests, maxConcurrent: attempt.maxConcurrent, maxAttemptsPerExecution: 1 };
  await atomicJson(join(root, 'admission.json'), { schema: 'paperclip.runner-eval.admission/v1', campaignId: manifest.campaignId,
    manifestSha256, attempt, limits, startedAt });
  const executables = join(root, 'executables');
  await mkdir(executables, { mode: 0o700 });
  const stagedCli = join(executables, 'entry.mjs'), stagedRunnerd = join(executables, 'runnerd'), loader = join(executables, 'imports.mjs');
  await writeFile(stagedCli, verified.runnerCli, { flag: 'wx', mode: 0o400 });
  await writeFile(stagedRunnerd, verified.runnerd, { flag: 'wx', mode: 0o500 });
  const stagedUrl = JSON.stringify(pathToFileURL(await realpath(stagedCli)).href), originalUrl = JSON.stringify(originalCliUrl);
  await writeFile(loader, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context.parentURL === ${stagedUrl} ? { ...context, parentURL: ${originalUrl} } : context);
} });\n`, { flag: 'wx', mode: 0o400 });
  const retainedRequestPath = join(root, 'request.json');
  const childRequest = structuredClone(request); childRequest.runnerd.path = stagedRunnerd;
  await writeFile(retainedRequestPath, JSON.stringify(childRequest) + '\n', { flag: 'wx', mode: 0o600 });
  await mkdir(join(root, 'receipts'), { mode: 0o700 });
  await mkdir(join(root, 'home'), { mode: 0o700 });
  await mkdir(join(root, 'tmp'), { mode: 0o700 });
  const ledgerPath = join(root, 'ledger.jsonl');
  const ledger = await costRuntime.openEvalCostLedger(ledgerPath, limits);
  let gateway, child, artifact, failure = null, cleanupVerified = false, secretExcluded = true;
  let providerArtifactSha256;
  const secrets = [key];
  const redact = raw => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), raw);
  try {
    await ledger.admitAttempt(attempt.executionId, attempt.attemptId);
    gateway = await costRuntime.startEvalGateway({ ledger, identity: { executionId: attempt.executionId, attemptId: attempt.attemptId, phase: 'agent' },
      route: { ...model, mode: manifest.route, projectId: manifest.projectId, endpointName: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY', apiKey: key },
      deadlineAt, transport, persist: receipt => atomicJson(join(root, 'receipts', `${receipt.requestId}.json`), receipt),
    });
    secrets.push(gateway.token);
    const descriptor = { schema: 'paperclip.runner-eval.gateway/v1', provider, model: attempt.model, baseUrl: gateway.baseUrl,
      campaignId: manifest.campaignId, executionId: attempt.executionId, attemptId: attempt.attemptId, upstreamRoute: manifest.route };
    const descriptorPath = join(root, 'gateway.json'), descriptorRaw = JSON.stringify(descriptor) + '\n';
    await writeFile(descriptorPath, descriptorRaw, { flag: 'wx', mode: 0o600 });
    const childEnvironment = Object.fromEntries(['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ'].flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]));
    Object.assign(childEnvironment, { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: gateway.token });
    const artifactPath = join(root, 'provider-artifact.json');
    signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error('Controlled attempt deadline reached before spawn');
    child = await runChild({ cli: stagedCli, loader, requestPath: retainedRequestPath, artifactPath, descriptorPath,
      cwd: request.session.workingDirectory ?? root, environment: childEnvironment, deadlineAt, signal, closeGateway: () => gateway.close() });
    for (const stream of ['stdout', 'stderr']) await writeFile(join(root, `${stream}.log`), redact(child[stream]), { flag: 'wx', mode: 0o600 });
    const raw = await readFile(artifactPath, 'utf8');
    if (Buffer.byteLength(raw) > 16_777_216) throw new Error('Provider artifact exceeds its byte limit');
    secretExcluded = secrets.every(secret => !raw.includes(secret));
    if (!secretExcluded) await writeFile(artifactPath, redact(raw), { mode: 0o600 });
    providerArtifactSha256 = sha256(redact(raw));
    artifact = JSON.parse(redact(raw));
    const expected = { mode: 'controller_gateway', provider, declaredUpstreamRoute: manifest.route, campaignId: manifest.campaignId,
      executionId: attempt.executionId, attemptId: attempt.attemptId, descriptorSha256: sha256(descriptorRaw) };
    if (canonical(artifact.requestRouting) !== canonical(expected) || artifact.attemptId !== attempt.attemptId || artifact.requestedModel !== attempt.model) throw new Error('Provider did not retain the assigned route');
    const processInfo = artifact.snapshot?.process;
    const pids = [...new Set([child.pid, processInfo?.runnerPid, processInfo?.providerPid, processInfo?.sidecarPid, processInfo?.agentPid].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    cleanupVerified = !child.stopped && artifact.snapshot?.status === 'closed' && processInfo?.runnerExited === true
      && Number.isSafeInteger(processInfo.runnerPid) && processInfo.runnerPid > 0
      && Number.isSafeInteger(processInfo.providerPid) && processInfo.providerPid > 0 && pids.every(absent);
    if (!cleanupVerified || !secretExcluded) throw new Error('Controlled provider cleanup or credential exclusion is unverified');
  } catch {
    failure = 'controlled_attempt_incomplete';
  } finally {
    try { await gateway?.close(); } catch { failure = 'gateway_cleanup_unverified'; }
    try { await ledger.close(); } catch { failure = 'ledger_close_failed'; }
  }
  if (cleanupVerified) {
    try { await rm(executables, { recursive: true }); }
    catch { cleanupVerified = false; failure ??= 'executable_cleanup_unverified'; }
  }
  const snapshot = ledger.snapshot();
  if (snapshot.overBudget || snapshot.conflictingRequests || snapshot.inflight || snapshot.unknownRequests !== snapshot.boundedUnresolvedRequests) failure ??= 'request_accounting_unbounded';
  const receiptHashes = {};
  try {
    for (const request of snapshot.requests) receiptHashes[request.requestId] = sha256(await readFile(join(root, 'receipts', `${request.requestId}.json`)));
  } catch { failure ??= 'request_receipt_missing'; }
  const ledgerSha256 = sha256(await readFile(ledgerPath));
  const report = { schema: 'paperclip.runner-eval.control-result/v1', campaignId: manifest.campaignId, manifestSha256,
    executionId: attempt.executionId, attemptId: attempt.attemptId, requestSha256: attempt.requestSha256,
    allocationUsd: attempt.maxUsd, limits, startedAt, finishedAt: new Date().toISOString(), status: failure ? 'incomplete' : 'closed', failure,
    child: child ? { code: child.code, signal: child.signal, stopped: child.stopped } : null,
    cleanupVerified, secretExcluded, providerArtifactSha256, ledgerSha256, receiptHashes, accounting: snapshot };
  await atomicJson(join(root, 'result.json'), report);
  const resultArtifact = artifact ?? { schema: 'paperclip-runner/eval-session-artifact/v1', attemptId: attempt.attemptId,
    requestedModel: attempt.model, infrastructureError: 'Controlled provider did not retain an artifact' };
  if (failure) Object.assign(resultArtifact, { accountingError: 'Controlled request accounting or cleanup is incomplete',
    accountingFailure: { class: 'provider_budget_coverage_unknown', category: 'provider_budget', retryable: false } });
  resultArtifact.controllerAccounting = report;
  await mkdir(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, JSON.stringify(resultArtifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { code: failure ? 2 : child?.code ?? 2, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const { values } = parseArgs({ options: { request: { type: 'string' }, output: { type: 'string' } } });
    if (!values.request || !values.output || !process.env.PAPERCLIP_RUNNER_EVAL_CONTROL_MANIFEST) throw new Error('A controlled manifest, request and output are required');
    const result = await runControlledEval({ manifestPath: process.env.PAPERCLIP_RUNNER_EVAL_CONTROL_MANIFEST,
      requestPath: values.request, outputPath: values.output, signal: controller.signal });
    process.exitCode = result.code;
  } catch { process.stderr.write('Controlled Runner eval admission or retention failed; inspect retained controller evidence.\n'); process.exitCode = 2; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
