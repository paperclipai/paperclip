import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const require = createRequire(new URL('../../../../server/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
export const costRuntime = await tsImport('./shared-cost-runtime.ts', import.meta.url);
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
    'sourceRevision', 'definitionsRevision', 'runnerCli', 'runnerPackage', 'runnerd', 'outputDirectory', 'route', 'projectId', 'models', 'attempts']);
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
  const overhead = costRuntime.validateOperatingOverhead(value.overhead, value.maxUsd);
  if (admission && Date.parse(value.overhead.verifiedAt) > now || Date.parse(value.overhead.expiresAt) <= deadline
      || value.overhead.components.some(component => !component.provisionalBound)) throw new Error('Controller requires current full-lifecycle operating bounds');
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
    if (!provider || !id(attempt.executionId) || !id(attempt.attemptId) || !hash(attempt.requestSha256)
        || attempts.has(attempt.attemptId) || executions.has(attempt.executionId) || reservation === undefined
        || !Number.isSafeInteger(attempt.timeoutMs) || attempt.timeoutMs < 1 || attempt.timeoutMs > 4 * 3_600_000
        || !Number.isSafeInteger(attempt.maxRequests) || attempt.maxRequests < 1 || attempt.maxRequests > 1000
        || !Number.isSafeInteger(attempt.maxConcurrent) || attempt.maxConcurrent < 1 || attempt.maxConcurrent > 16
        || units(attempt.maxUsd) < reservation) throw new Error('Invalid controlled attempt allocation');
    attempts.add(attempt.attemptId); executions.add(attempt.executionId); allocated += units(attempt.maxUsd);
  }
  if (allocated > units(value.maxUsd)) throw new Error('Controlled allocations exceed the campaign budget');
  return { manifest: structuredClone(value), manifestSha256: sha256(canonical(value)), allocatedUsd: usd(allocated), overheadUsd: usd(overhead) };
}
export function bindRequest(manifest, request) {
  const attempt = manifest.attempts.find(item => item.attemptId === request.attemptId);
  if (!attempt || requestBindingSha256(request) !== attempt.requestSha256 || request.provider !== attempt.provider
      || request.acpxAgent !== (attempt.acpxAgent ?? null) && request.acpxAgent !== attempt.acpxAgent
      || request.model !== attempt.model || request.runnerd.sha256.replace(/^sha256:/, '') !== manifest.runnerd.sha256
      || request.runnerd.path !== manifest.runnerd.path) throw new Error('Controlled request does not match its allocated identity');
  return attempt;
}
