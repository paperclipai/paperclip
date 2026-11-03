import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isEntrypoint } from './entrypoint.mjs';
import { assertHostedAdmission, canonical, costRuntime, fields, observabilityBoundConfiguration, requestBindingSha256, sha256, validateManifest } from './manifest.mjs';
import { readRegularFile } from './evidence-files.mjs';

export function hostedPaths(runId) {
  if (typeof runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(runId)) throw new Error('Invalid hosted run ID');
  const root = `/tmp/paperclip-runner-controlled-${runId}`;
  return { root, runner: join(root, 'runner'), controller: join(root, 'runtime'),
    manifest: join(root, 'controller-manifest.json'), evidence: join(root, 'evidence') };
}

export function hostedPolicyConfiguration(policy) {
  const { capacityBound, ...configuration } = policy;
  return configuration;
}

export function prepareHostedManifest({ catalog, catalogSha256, prepared, policy, artifacts, environment, now = Date.now() }) {
  fields(policy, ['schema', 'maxUsd', 'durationMs', 'pricingVerifiedAt', 'pricingExpiresAt', 'route', 'projectId', 'models', 'overhead', 'observability', 'allocations', 'maxCells', 'capacityBound', 'controllerLockSha256']);
  if (policy.schema !== 'paperclip.runner-eval.hosted-policy/v1' || !policy.observability
      || !Number.isSafeInteger(policy.durationMs) || policy.durationMs < 1 || policy.durationMs > 4 * 3_600_000
      || !Number.isSafeInteger(policy.maxCells) || policy.maxCells < 1 || policy.maxCells > 512
      || !Array.isArray(policy.allocations) || !policy.allocations.length) throw new Error('A bounded hosted policy with tracing is required');
  if (!/^[a-f0-9]{64}$/.test(policy.controllerLockSha256 ?? '')) throw new Error('Invalid hosted controller lock binding');
  if (policy.overhead?.accountingReadiness !== 'model_requests' || policy.capacityBound !== undefined) {
    costRuntime.reservationBound('operating_allowance', policy.capacityBound, hostedPolicyConfiguration(policy));
  }
  fields(policy.observability, ['projectId', 'capture', 'nativeLimits']);
  const runId = environment.GITHUB_RUN_ID, paths = hostedPaths(runId);
  if (prepared.schema !== 'paperclip.runner-eval.prepared-requests/v1' || prepared.githubRunId !== runId || prepared.githubRunAttempt !== 1
      || prepared.campaignId !== `gha-${runId}-1` || prepared.catalogSha256 !== catalogSha256
      || catalog.schema !== 'paperclip.runner-protocol-eval.catalog/v1' || catalog.campaignId !== prepared.campaignId
      || prepared.sourceRevision !== environment.GITHUB_SHA || prepared.sourceRevision !== environment.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA || prepared.sourceRevision !== catalog.source?.paperclipSha
      || prepared.definitionsRevision !== environment.PAPERCLIP_PROTOCOL_EVALS_SHA || prepared.definitionsRevision !== catalog.source?.evalsSha
      || !Array.isArray(prepared.cells) || !prepared.cells.length || prepared.cells.length > policy.maxCells
      || !Array.isArray(catalog.cells) || catalog.cells.length !== prepared.cells.length
      || !Array.isArray(catalog.matrices) || catalog.matrices.length !== 2) throw new Error('Prepared selection does not match the authorized catalog');
  const indexed = new Map(catalog.cells.map(cell => [cell.cellId, cell]));
  const scheduled = catalog.matrices.flatMap(matrix => Array.isArray(matrix.include) ? matrix.include : []);
  if (indexed.size !== catalog.cells.length || scheduled.length !== catalog.cells.length
      || new Set(scheduled.map(cell => cell.cellId)).size !== indexed.size
      || scheduled.some(cell => canonical(cell) !== canonical(indexed.get(cell.cellId)))) throw new Error('Every selected cell must occur exactly once');
  const key = item => canonical([item.provider, item.acpxAgent ?? null, item.model]);
  const allocations = new Map();
  for (const allocation of policy.allocations) {
    fields(allocation, ['provider', 'acpxAgent', 'model', 'maxUsd', 'maxRequests', 'maxConcurrent', 'timeoutMs']);
    if (allocations.has(key(allocation))) throw new Error('Duplicate hosted allocation policy');
    allocations.set(key(allocation), allocation);
  }
  const seen = new Set();
  const attempts = prepared.cells.map(cell => {
    const request = cell.request, expected = indexed.get(cell.cellId), allocation = allocations.get(key(request));
    if (!expected || seen.has(cell.cellId) || !allocation || cell.runId !== `gha-${runId}-1-${cell.cellId}`
        || request.schema !== 'paperclip-runner/eval-session-request/v1'
        || !(request.provider === 'codex' && !request.acpxAgent || request.provider === 'acpx' && request.acpxAgent === 'claude')
        || request.driver !== (request.provider === 'codex' ? 'codex_app_server' : 'acpx_runtime') || request.driver !== expected.driver
        || request.provider !== expected.provider || (request.acpxAgent ?? null) !== (expected.acpxAgent ?? null) || request.model !== expected.model
        || request.runnerd?.path !== join(paths.runner, 'paperclip-runnerd') || request.runnerd.sha256?.replace(/^sha256:/, '') !== artifacts.runnerd.sha256
        || prepared.runnerd?.path !== request.runnerd.path || prepared.runnerd.sha256 !== request.runnerd.sha256) throw new Error('Unsupported or mismatched controlled cell');
    seen.add(cell.cellId);
    return { ...allocation, executionId: cell.cellId, attemptId: request.attemptId, requestSha256: requestBindingSha256(request) };
  });
  const manifest = { schema: 'paperclip.runner-eval.controller/v1', campaignId: prepared.campaignId,
    maxUsd: policy.maxUsd, deadlineAt: new Date(now + policy.durationMs).toISOString(), pricingVerifiedAt: policy.pricingVerifiedAt,
    pricingExpiresAt: policy.pricingExpiresAt, route: policy.route, ...(policy.projectId ? { projectId: policy.projectId } : {}),
    models: policy.models, overhead: policy.overhead, observability: { ...policy.observability },
    sourceRevision: prepared.sourceRevision, definitionsRevision: prepared.definitionsRevision, ...artifacts,
    outputDirectory: paths.evidence, hosted: { repository: environment.GITHUB_REPOSITORY, runId, runAttempt: 1, workflowRevision: environment.GITHUB_SHA, controllerLockSha256: policy.controllerLockSha256, policySha256: sha256(canonical(policy)) }, attempts };
  if (policy.capacityBound !== undefined) manifest.observability.provisionalBound = { ...policy.capacityBound, configurationSha256: sha256(canonical(observabilityBoundConfiguration(manifest))) };
  const validated = validateManifest(manifest, now);
  assertHostedAdmission(manifest, attempts[0], { ...environment, PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: attempts[0].executionId });
  return validated;
}

export async function verifyHostedCell({ manifestPath, manifestSha256, cellId, environment }) {
  const bytes = await readRegularFile(manifestPath, 16 * 1_048_576);
  if (sha256(bytes) !== manifestSha256) throw new Error('Hosted manifest bytes changed');
  const { manifest } = validateManifest(JSON.parse(bytes.toString('utf8')));
  const attempt = manifest.attempts.find(item => item.executionId === cellId);
  if (!attempt) throw new Error('Cell is outside the controlled selection');
  assertHostedAdmission(manifest, attempt, environment);
  return { manifest, attempt };
}

const safeAdmissionReasons = new Set([
  'Invalid hosted run ID', 'Invalid hosted controller lock binding', 'Invalid controller fields', 'A bounded hosted policy with tracing is required',
  'Invalid reviewed cost bound evidence', 'Reviewed cost bound configuration changed',
  'Prepared selection does not match the authorized catalog', 'Every selected cell must occur exactly once',
  'Duplicate hosted allocation policy', 'Unsupported or mismatched controlled cell',
  'Invalid controller campaign identity or validity window', 'Controller requires current full-lifecycle operating bounds',
  'Invalid controlled campaign selection', 'Invalid controller executable provenance', 'Invalid hosted controller identity',
  'Invalid controller model pricing', 'Invalid controlled attempt allocation', 'Controlled allocations exceed the campaign budget',
  'Incomplete operating overhead allowance', 'Operating overhead leaves no model allowance',
  'Invalid operating overhead component', 'Invalid operating overhead fields', 'Invalid controller observability allocation',
  'Observability capacity requires its operating bound evidence', 'Hosted manifest bytes changed',
  'Cell is outside the controlled selection', 'Hosted controller admission does not match the current first-attempt worker',
  'Hosted controller requires GitHub-hosted operating origin',
]);
export function hostedAdmissionDiagnostic(error) {
  if (error instanceof Error && safeAdmissionReasons.has(error.message)) return error.message;
  if (error?.code === 'ENOENT') return 'A required hosted input file is missing';
  if (error instanceof SyntaxError) return 'A hosted input is not valid JSON';
  return 'Invalid or unreadable hosted input; check the catalog, policy and runtime bindings';
}

if (await isEntrypoint(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'prepare' && args.length === 5) {
      const [catalogPath, preparedPath, policyPath, runner, output] = args;
      const json = async path => JSON.parse((await readRegularFile(path, 16 * 1_048_576)).toString('utf8'));
      const catalogBytes = await readRegularFile(catalogPath, 16 * 1_048_576);
      const prepared = await json(preparedPath), paths = hostedPaths(process.env.GITHUB_RUN_ID), artifacts = {};
      for (const [name, relative] of [['runnerCli', 'portable/dist/cli/eval-session.js'], ['runnerPackage', 'paperclip-runner.tgz'], ['runnerd', 'paperclip-runnerd']]) {
        artifacts[name] = { path: join(paths.runner, relative), sha256: sha256(await readFile(join(runner, relative))) };
      }
      const result = prepareHostedManifest({ catalog: JSON.parse(catalogBytes), catalogSha256: sha256(catalogBytes), prepared,
        policy: await json(policyPath), artifacts, environment: process.env });
      await mkdir(output, { mode: 0o700 });
      await writeFile(join(output, 'controller-manifest.json'), canonical(result.manifest), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ manifestSha256: result.manifestSha256, cells: result.manifest.attempts.length,
        allocatedUsd: result.allocatedUsd, providerCalls: 0 }));
    } else if (command === 'verify' && args.length === 3) {
      await verifyHostedCell({ manifestPath: args[0], manifestSha256: args[1], cellId: args[2], environment: process.env });
    } else throw new Error('Usage: hosted.mjs <prepare catalog prepared policy runner output | verify manifest digest cell>');
  } catch (error) {
    console.error(`Hosted campaign admission failed: ${hostedAdmissionDiagnostic(error)}. No provider work was started by this command.`); process.exitCode = 2;
  }
}
