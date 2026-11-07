import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { limitFor, readRegularFile } from './evidence-files.mjs';
import { canonical, costRuntime, ROOT_OTLP_LIMITS, sha256 } from './manifest.mjs';

function launchFor(manifest, request, identity, baseUrl) {
  const state = new costRuntime.CapabilityMockControlPlaneAdapter(request.session.seed).snapshot();
  return costRuntime.buildProviderObservabilityLaunch({ kind: request.provider === 'codex' ? 'codex' : 'claude',
    companyId: request.session.companyId ?? state.company.id, agentId: request.session.actorId ?? state.actors[0].id,
    compatibilityKey: identity.traceId, revision: identity.traceId, enabled: true, capture: manifest.observability.capture,
    logsEndpoint: `${baseUrl}/v1/logs`, tracesEndpoint: `${baseUrl}/v1/traces`,
    headers: { 'x-bt-parent': costRuntime.exportBraintrustAttemptParent(identity) } });
}
const policyFor = (manifest, attempt, identity, deadlineAt, native) => ({ projectId: manifest.observability.projectId,
  campaignId: manifest.campaignId, attemptId: attempt.attemptId, deadlineAt: new Date(deadlineAt).toISOString(),
  limits: native ? manifest.observability.nativeLimits : ROOT_OTLP_LIMITS,
  expectedParent: native ? costRuntime.exportBraintrustAttemptParent(identity) : `project_id:${identity.projectId}` });
function rootTrace(manifest, attempt, identity, startedAt, finishedAt, cleanupVerified, failure) {
  const attributes = {
    'paperclip.eval.family': 'runner_protocol', 'paperclip.eval.campaign_id': manifest.campaignId,
    'paperclip.eval.execution_id': attempt.executionId, 'paperclip.eval.attempt_id': attempt.attemptId,
    'paperclip.eval.source_revision': manifest.sourceRevision, 'paperclip.eval.definitions_revision': manifest.definitionsRevision,
    'paperclip.eval.request_sha256': attempt.requestSha256, 'paperclip.eval.provider': attempt.provider,
    'paperclip.eval.profile': attempt.acpxAgent ?? attempt.provider, 'paperclip.eval.model': attempt.model,
    'paperclip.eval.controller_status_before_root_export': failure ? 'incomplete' : 'closed',
    'paperclip.eval.cleanup_verified': String(cleanupVerified), 'paperclip.eval.feedback_persistence': 'unavailable_mock_control_plane',
    'paperclip.eval.grading': 'retained_artifact_separate',
  };
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'paperclip-runner-evals' } }] },
    scopeSpans: [{ scope: { name: 'paperclip.runner-eval-controller', version: '1' }, spans: [{ traceId: identity.traceId, spanId: identity.spanId,
      name: 'paperclip.runner.eval.attempt', kind: 1, startTimeUnixNano: String(BigInt(Date.parse(startedAt)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Date.parse(finishedAt)) * 1_000_000n),
      attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })) }] }] }] };
}
const nativeEvidence = (identity, descriptorSha256) => ({ mode: 'controller_otlp', configured: true, verification: 'unverified', ...identity, descriptorSha256 });

export async function startControlledObservability({ manifest, attempt, request, root, apiKey, deadlineAt, startedAt, transport, signal }) {
  const identity = { projectId: manifest.observability.projectId, traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex') };
  let native, controller;
  const onAbort = () => { void close().catch(() => {}); };
  const close = async () => {
    signal?.removeEventListener('abort', onAbort);
    const results = await Promise.allSettled([native?.close(), controller?.close()]);
    if (results.some(result => result.status === 'rejected')) throw new Error('OTLP closure unverified');
  };
  try {
    signal?.throwIfAborted();
    native = await costRuntime.startEvalOtlpRelay({ ...policyFor(manifest, attempt, identity, deadlineAt, true), deadlineAt, apiKey,
      receiptPath: join(root, 'otlp-native.jsonl'), transport });
    controller = await costRuntime.startEvalOtlpRelay({ ...policyFor(manifest, attempt, identity, deadlineAt, false), deadlineAt, apiKey,
      receiptPath: join(root, 'otlp-controller.jsonl'), transport });
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.throwIfAborted();
    const descriptor = { schema: 'paperclip.runner-eval.observability/v1', campaignId: manifest.campaignId, executionId: attempt.executionId,
      attemptId: attempt.attemptId, ...identity, baseUrl: native.baseUrl, launch: launchFor(manifest, request, identity, native.baseUrl) };
    const raw = JSON.stringify(descriptor) + '\n';
    const descriptorPath = join(root, 'observability.json');
    await writeFile(descriptorPath, raw, { flag: 'wx', mode: 0o600 });
    let finished;
    return { descriptorPath, token: native.token, secrets: [native.token, controller.token],
      expectedEvidence: nativeEvidence(identity, sha256(raw)), close, closeNative: native.close,
      finish: input => finished ??= (async () => {
        const finishedAt = new Date().toISOString();
        let traceFailure = input.failure;
        try {
          await native.close();
          signal?.throwIfAborted();
          try {
            const receipts = costRuntime.inspectEvalOtlpReceipts(await readRegularFile(join(root, 'otlp-native.jsonl'), limitFor('otlp-native.jsonl')),
              policyFor(manifest, attempt, identity, deadlineAt, true));
            if (receipts.status !== 'accepted' || !receipts.signals.logs.records || !receipts.signals.traces.records) traceFailure ??= 'native_export_incomplete';
          } catch { traceFailure ??= 'native_evidence_incomplete'; }
          const body = JSON.stringify(rootTrace(manifest, attempt, identity, startedAt, finishedAt, input.cleanupVerified, traceFailure));
          await writeFile(join(root, 'otlp-root.json'), body, { flag: 'wx', mode: 0o600 });
          const response = await fetch(`${controller.baseUrl}/v1/traces`, { method: 'POST', redirect: 'error',
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(10_000, deadlineAt - Date.now())))]),
            headers: { authorization: `Bearer ${controller.token}`, 'content-type': 'application/json', 'x-bt-parent': `project_id:${identity.projectId}` }, body });
          await response.arrayBuffer();
        } finally { await close(); }
        return inspectControlledObservability({ manifest, attempt, request, artifact: input.artifact,
          report: { startedAt, traceFinishedAt: finishedAt, cleanupVerified: input.cleanupVerified, traceFailure },
          deadlineAt, readEvidence: name => readRegularFile(join(root, name), limitFor(name)) });
      })() };
  } catch (error) { await close(); throw error; }
}

export async function inspectControlledObservability({ manifest, attempt, request, artifact, report, deadlineAt, readEvidence }) {
  const descriptorBytes = await readEvidence('observability.json');
  if (descriptorBytes.length > 131_072) throw new Error('Oversized observability descriptor');
  const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
  const identity = { projectId: descriptor.projectId, traceId: descriptor.traceId, spanId: descriptor.spanId };
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/otel$/.test(descriptor.baseUrl) || Number(new URL(descriptor.baseUrl).port) > 65535
      || descriptor.projectId !== manifest.observability.projectId || canonical(descriptor) !== canonical({
        schema: 'paperclip.runner-eval.observability/v1', campaignId: manifest.campaignId, executionId: attempt.executionId, attemptId: attempt.attemptId,
        ...identity, baseUrl: descriptor.baseUrl, launch: launchFor(manifest, request, identity, descriptor.baseUrl) })
      || canonical(artifact?.nativeObservability) !== canonical(nativeEvidence(identity, sha256(descriptorBytes)))) throw new Error('Native observability identity or configuration mismatch');
  const bytes = { native: await readEvidence('otlp-native.jsonl'), controller: await readEvidence('otlp-controller.jsonl'), root: await readEvidence('otlp-root.json') };
  const native = costRuntime.inspectEvalOtlpReceipts(bytes.native, policyFor(manifest, attempt, identity, deadlineAt, true));
  const controller = costRuntime.inspectEvalOtlpReceipts(bytes.controller, policyFor(manifest, attempt, identity, deadlineAt, false));
  if (!Number.isFinite(Date.parse(report.traceFinishedAt)) || Date.parse(report.traceFinishedAt) < Date.parse(report.startedAt)
      || bytes.root.length > ROOT_OTLP_LIMITS.maxRequestBytes || bytes.root.toString('utf8') !== JSON.stringify(rootTrace(manifest, attempt, identity,
        report.startedAt, report.traceFinishedAt, report.cleanupVerified, report.traceFailure))) throw new Error('Controller root trace mismatch');
  const rootRows = bytes.controller.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  if (rootRows.filter(row => row.type === 'admitted').length !== 1 || !rootRows.some(row => row.type === 'admitted' && row.payloadSha256 === sha256(bytes.root))) throw new Error('Controller root trace receipt missing');
  return { ...identity, verification: 'unverified', status: native.status === 'accepted' && controller.status === 'accepted'
      && native.signals.logs.records > 0 && native.signals.traces.records > 0 && controller.signals.traces.records === 1 ? 'accepted' : 'incomplete',
    descriptorSha256: sha256(descriptorBytes), native, controller, receiptHashes: { native: sha256(bytes.native), controller: sha256(bytes.controller), root: sha256(bytes.root) },
    traceFinishedAt: report.traceFinishedAt, traceFailure: report.traceFailure };
}
