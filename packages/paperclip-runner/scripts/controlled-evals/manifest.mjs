import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { costRuntime } from './runtime.mjs';
export { costRuntime };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const usd = value => `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, '0')}`;
export function units(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) throw new Error('Invalid controller USD amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}
export function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new Error('Invalid controller fields');
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => costRuntime.validEvalLedgerId(value);
export function requestBindingSha256(request) {
  const copy = structuredClone(request);
  if (!copy.session || !copy.runnerd) throw new Error('Invalid controlled request');
  delete copy.session.workingDirectory;
  delete copy.runnerd.path;
  return sha256(canonical(copy));
}
export async function readJson(file, maximum = 1_048_576) {
  const bytes = await readFile(file);
  if (bytes.length > maximum) throw new Error('Controller document exceeds its byte limit');
  return JSON.parse(bytes.toString('utf8'));
}
export function validateManifest(value, now = Date.now(), { admission = true } = {}) {
  fields(value, ['schema', 'campaignId', 'maxUsd', 'deadlineAt', 'pricingVerifiedAt', 'pricingExpiresAt', 'overhead',
    'sourceRevision', 'definitionsRevision', 'runnerCli', 'runnerPackage', 'runnerd', 'outputDirectory', 'route', 'projectId', 'models', 'attempts', 'observability', 'hosted']);
  const deadline = Date.parse(value.deadlineAt);
  const verified = Date.parse(value.pricingVerifiedAt), expires = Date.parse(value.pricingExpiresAt);
  if (value.schema !== 'paperclip.runner-eval.controller/v1' || !id(value.campaignId)
      || !Number.isFinite(now) || !Number.isFinite(deadline) || admission && (deadline <= now || deadline - now > 4 * 3_600_000)
      || !Number.isFinite(verified) || !Number.isFinite(expires) || verified >= deadline || expires <= verified || admission && verified > now || expires <= deadline || expires - verified > 31 * 86_400_000
      || !/^[a-f0-9]{40}$/.test(value.sourceRevision ?? '') || !/^[a-f0-9]{40}$/.test(value.definitionsRevision ?? '')
      || !isAbsolute(value.outputDirectory ?? '') || !['direct', 'braintrust'].includes(value.route)
      || value.route === 'braintrust' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.projectId ?? '')
      || value.route === 'direct' && value.projectId !== undefined) throw new Error('Invalid controller campaign identity or validity window');
  for (const artifact of [value.runnerCli, value.runnerPackage, value.runnerd]) {
    fields(artifact, ['path', 'sha256']);
    if (!isAbsolute(artifact.path ?? '') || !hash(artifact.sha256)) throw new Error('Invalid controller executable provenance');
  }
  validateHostedIdentity(value);
  const overhead = costRuntime.validateOperatingOverhead(value.overhead, value.maxUsd);
  if (admission && Date.parse(value.overhead.verifiedAt) > now || Date.parse(value.overhead.expiresAt) <= deadline
      || value.overhead.accountingReadiness !== 'model_requests' && value.overhead.components.some(component => !component.provisionalBound)) throw new Error('Controller requires current full-lifecycle operating bounds');
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 16
      || !Array.isArray(value.attempts) || !value.attempts.length || value.attempts.length > 1000) throw new Error('Invalid controlled campaign selection');
  const prices = new Map();
  const rateFields = ['inputUsdPerMillion', 'cachedReadUsdPerMillion', 'outputUsdPerMillion', 'cacheWrite5mUsdPerMillion', 'cacheWrite1hUsdPerMillion', 'cacheWrite30mUsdPerMillion', 'cacheWrite12hUsdPerMillion'];
  for (const model of value.models) {
    fields(model, ['provider', 'price', 'maximumInputTokens', 'maximumOutputTokens', 'timeoutMs', 'provisionalBound']);
    fields(model.price, ['provider', 'model', 'version', 'sourceUrl', 'longContext', ...rateFields]);
    if (model.price.longContext) { fields(model.price.longContext, ['aboveInputTokens', 'rates']); fields(model.price.longContext.rates, rateFields); }
    const url = new URL(model.price.sourceUrl);
    const key = `${model.provider}:${model.price.model}`;
    if (!['openai', 'anthropic'].includes(model.provider) || !model.provisionalBound || url.protocol !== 'https:'
        || url.username || url.password || url.search || url.hash || prices.has(key)) throw new Error('Invalid controller model pricing');
    prices.set(key, units(costRuntime.evalRequestReservation({ ...model, mode: value.route, apiKey: 'validation' })));
  }
  const attempts = new Set(), executions = new Set();
  let allocated = overhead;
  for (const attempt of value.attempts) {
    fields(attempt, ['executionId', 'attemptId', 'requestSha256', 'provider', 'acpxAgent', 'model', 'maxUsd', 'maxRequests', 'maxConcurrent', 'timeoutMs']);
    const provider = attempt.provider === 'codex' && attempt.acpxAgent === undefined ? 'openai'
      : attempt.provider === 'acpx' && attempt.acpxAgent === 'claude' ? 'anthropic' : null;
    const reservation = prices.get(`${provider}:${attempt.model}`);
    if (!provider || !id(attempt.executionId) || !id(attempt.attemptId) || !/^[A-Za-z0-9_.-]+$/.test(attempt.attemptId) || !hash(attempt.requestSha256)
        || attempts.has(attempt.attemptId) || executions.has(attempt.executionId) || reservation === undefined
        || !Number.isSafeInteger(attempt.timeoutMs) || attempt.timeoutMs < 1 || attempt.timeoutMs > 4 * 3_600_000
        || !Number.isSafeInteger(attempt.maxRequests) || attempt.maxRequests < 1 || attempt.maxRequests > 1000
        || !Number.isSafeInteger(attempt.maxConcurrent) || attempt.maxConcurrent < 1 || attempt.maxConcurrent > 16
        || units(attempt.maxUsd) < reservation) throw new Error('Invalid controlled attempt allocation');
    attempts.add(attempt.attemptId); executions.add(attempt.executionId); allocated += units(attempt.maxUsd);
  }
  if (allocated > units(value.maxUsd)) throw new Error('Controlled allocations exceed the campaign budget');
  validateObservability(value);
  return { manifest: structuredClone(value), manifestSha256: sha256(canonical(value)), allocatedUsd: usd(allocated), overheadUsd: usd(overhead) };
}
function validateHostedIdentity(manifest) {
  const hosted = manifest.hosted;
  if (hosted === undefined) return;
  fields(hosted, ['repository', 'runId', 'runAttempt', 'workflowRevision', 'policySha256', 'controllerLockSha256']);
  if (typeof hosted.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(hosted.repository)
      || typeof hosted.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(hosted.runId)
      || hosted.policySha256 !== undefined && !hash(hosted.policySha256)
      || hosted.controllerLockSha256 !== undefined && !hash(hosted.controllerLockSha256)
      || hosted.runAttempt !== 1 || typeof hosted.workflowRevision !== 'string' || !/^[a-f0-9]{40}$/.test(hosted.workflowRevision)
      || manifest.campaignId !== `gha-${hosted.runId}-1`) throw new Error('Invalid hosted controller identity');
}

export function assertHostedAdmission(manifest, attempt, environment) {
  validateHostedIdentity(manifest);
  const hosted = manifest.hosted;
  if (!hosted) {
    if (['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA'].some(key => environment[key] !== undefined)) {
      throw new Error('GitHub execution requires a hosted controller identity');
    }
    return;
  }
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== hosted.repository
      || environment.GITHUB_RUN_ID !== hosted.runId || environment.GITHUB_RUN_ATTEMPT !== '1'
      || environment.GITHUB_SHA !== hosted.workflowRevision
      || environment.PAPERCLIP_RUNNER_EVAL_EXECUTION_ID !== attempt.executionId) {
    throw new Error('Hosted controller admission does not match the current first-attempt worker');
  }
}

export function bindRequest(manifest, request) {
  const attempt = manifest.attempts.find(item => item.attemptId === request.attemptId);
  if (!attempt || requestBindingSha256(request) !== attempt.requestSha256 || request.provider !== attempt.provider
      || request.acpxAgent !== (attempt.acpxAgent ?? null) && request.acpxAgent !== attempt.acpxAgent
      || request.model !== attempt.model || request.runnerd.sha256.replace(/^sha256:/, '') !== manifest.runnerd.sha256
      || request.runnerd.path !== manifest.runnerd.path) throw new Error('Controlled request does not match its allocated identity');
  return attempt;
}

export const ROOT_OTLP_LIMITS = Object.freeze({ maxRequests: 1, maxRequestBytes: 16_384, maxTotalBytes: 16_384,
  maxConcurrent: 1, maxExpandedBytes: 65_536, maxRecords: 1 });
export function observabilityBoundConfiguration(manifest) {
  const policy = manifest.observability;
  return { schema: 'paperclip.runner-eval.observability-bound/v1', campaignId: manifest.campaignId, deadlineAt: manifest.deadlineAt,
    sourceRevision: manifest.sourceRevision, definitionsRevision: manifest.definitionsRevision,
    projectId: policy.projectId, capture: policy.capture, nativeLimits: policy.nativeLimits, rootLimits: ROOT_OTLP_LIMITS,
    attempts: manifest.attempts.map(({ executionId, attemptId, requestSha256 }) => ({ executionId, attemptId, requestSha256 })),
    overhead: manifest.overhead };
}
function validateObservability(manifest) {
  const policy = manifest.observability;
  if (policy === undefined) return;
  fields(policy, ['projectId', 'capture', 'nativeLimits', 'provisionalBound']);
  fields(policy.capture, ['userPrompts', 'assistantResponses', 'toolDetails', 'toolContent']);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(policy.projectId ?? '')
      || manifest.route === 'braintrust' && policy.projectId !== manifest.projectId
      || Object.keys(policy.capture).length !== 4 || Object.values(policy.capture).some(value => typeof value !== 'boolean')
      || canonical(Object.keys(policy.nativeLimits ?? {}).sort()) !== canonical(Object.keys(costRuntime.EVAL_OTLP_LIMITS).sort())
      || Object.entries(costRuntime.EVAL_OTLP_LIMITS).some(([key, max]) => !Number.isSafeInteger(policy.nativeLimits[key]) || policy.nativeLimits[key] < 1 || policy.nativeLimits[key] > max)) throw new Error('Invalid controller observability allocation');
  if (manifest.overhead.accountingReadiness === 'model_requests' && policy.provisionalBound === undefined) return;
  const operating = manifest.overhead.components.find(item => item.component === 'observability');
  if (!operating || policy.provisionalBound?.evidenceSha256 !== operating.provisionalBound?.evidenceSha256) throw new Error('Observability capacity requires its operating bound evidence');
  costRuntime.reservationBound('operating_allowance', policy.provisionalBound, observabilityBoundConfiguration(manifest));
}


export function modelReadinessDefect(manifest, snapshot) {
  return manifest.overhead.accountingReadiness === 'model_requests' && (!snapshot.requests.length || snapshot.unknownRequests > 0);
}
