import { isEntrypoint } from './entrypoint.mjs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assertHostedAdmission, bindRequest, canonical, fields, readJson, requestBindingSha256, sha256, units, usd, validateManifest } from './manifest.mjs';
import { attemptDirectory, controlledResultArtifact } from './run.mjs';
import { summarizeControlledCampaign } from './report.mjs';
import { FILE_LIMITS, RECEIPT, limitFor, readRegularFile } from './evidence-files.mjs';

const MiB = 1_048_576;
const MAX_RAW_BYTES = 64 * MiB;
const MAX_ARCHIVE_BYTES = 96 * MiB;


function secretValues({ environment = process.env, secrets = [] } = {}) {
  const configured = [...secrets, ...Object.entries(environment)
    .filter(([name]) => /(?:KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY_ID|CONFIG_CONTENT)$/i.test(name))
    .map(([, value]) => value)].filter(value => typeof value === 'string' && value.length > 0);
  for (const [name, value] of Object.entries(environment)) {
    if (!/CONFIG_CONTENT$/i.test(name) || typeof value !== 'string') continue;
    try {
      const visit = item => {
        if (!item || typeof item !== 'object') return;
        for (const [key, entry] of Object.entries(item)) {
          if (/(?:key|token|secret|password)$/i.test(key) && typeof entry === 'string' && entry) configured.push(entry);
          else visit(entry);
        }
      };
      visit(JSON.parse(value));
    } catch {}
  }
  return [...new Set(configured.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))];
}
function excludeSecrets(bytes, secrets) {
  if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('Controller evidence contains a configured credential');
}

async function realDirectory(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Controller evidence directory is not a real directory');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function packControlledAttempt({ manifest: value, attemptId, ...options }) {
  const { manifest, manifestSha256 } = validateManifest(value, Date.now(), { admission: false });
  const allocation = manifest.attempts.find(attempt => attempt.attemptId === attemptId);
  if (!allocation) throw new Error('Attempt is absent from the controller manifest');
  const secrets = secretValues(options);
  const manifestBytes = Buffer.from(canonical(manifest));
  if (manifestBytes.length > MiB) throw new Error('Controller manifest exceeds its archive limit');
  excludeSecrets(manifestBytes, secrets);
  const root = attemptDirectory(manifest, attemptId), files = {};
  let total = manifestBytes.length;
  if (await realDirectory(root)) {
    const names = [...FILE_LIMITS.keys()];
    if (await realDirectory(join(root, 'receipts'))) {
      for (const name of await readdir(join(root, 'receipts'))) {
        if (RECEIPT.test(`receipts/${name.replace(/\.tmp$/, '')}`) && name.endsWith('.tmp')) continue;
        if (!RECEIPT.test(`receipts/${name}`)) throw new Error('Unexpected controller receipt path');
        names.push(`receipts/${name}`);
      }
    }
    if (names.length > allocation.maxRequests + FILE_LIMITS.size) throw new Error('Too many controller receipts');
    for (const name of names.sort()) {
      let bytes;
      try { bytes = await readRegularFile(join(root, name), limitFor(name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      total += bytes.length;
      if (total > MAX_RAW_BYTES) throw new Error('Controller evidence exceeds its archive limit');
      excludeSecrets(bytes, secrets);
      files[name] = { sizeBytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    }
  }
  return { schema: 'paperclip.runner-eval.control-evidence/v1', manifest, manifestSha256, attemptId, files };
}

export function decodeControlledEvidence(value, options) {
  fields(value, ['schema', 'manifest', 'manifestSha256', 'attemptId', 'files']);
  const { manifest, manifestSha256 } = validateManifest(value.manifest, Date.now(), { admission: false });
  const allocation = manifest.attempts.find(attempt => attempt.attemptId === value.attemptId);
  if (value.schema !== 'paperclip.runner-eval.control-evidence/v1' || value.manifestSha256 !== manifestSha256 || !allocation) throw new Error('Controller archive identity mismatch');
  fields(value.files, Object.keys(value.files ?? {}));
  const entries = Object.entries(value.files);
  if (entries.length > allocation.maxRequests + FILE_LIMITS.size) throw new Error('Too many controller evidence files');
  const secrets = secretValues(options), manifestBytes = Buffer.from(canonical(manifest));
  if (manifestBytes.length > MiB) throw new Error('Controller manifest exceeds its archive limit');
  excludeSecrets(manifestBytes, secrets);
  let total = manifestBytes.length;
  const files = new Map();
  for (const [name, file] of entries) {
    const limit = limitFor(name);
    fields(file, ['sizeBytes', 'sha256', 'base64']);
    if (!limit || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > limit
        || typeof file.base64 !== 'string' || file.base64.length !== 4 * Math.ceil(file.sizeBytes / 3)
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid controller evidence file');
    total += file.sizeBytes;
    if (total > MAX_RAW_BYTES) throw new Error('Controller evidence exceeds its archive limit');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.sizeBytes || bytes.toString('base64') !== file.base64 || sha256(bytes) !== file.sha256) throw new Error('Controller evidence digest mismatch');
    excludeSecrets(bytes, secrets);
    files.set(name, bytes);
  }
  return { manifest, manifestSha256, attemptId: value.attemptId, files };
}

export async function readControlledEvidence(path, options) {
  const value = JSON.parse((await readRegularFile(path, MAX_ARCHIVE_BYTES)).toString('utf8'));
  decodeControlledEvidence(value, options);
  return value;
}

export async function readAttemptControlledEvidence(directory, options) {
  const bundle = await readControlledEvidence(join(directory, 'controller-evidence.json'), options);
  const artifact = JSON.parse((await readRegularFile(join(directory, 'artifact.json'), 16 * MiB)).toString('utf8'));
  const request = JSON.parse((await readRegularFile(join(directory, 'request.json'), 8 * MiB)).toString('utf8'));
  const allocation = bundle.manifest.attempts.find(attempt => attempt.attemptId === bundle.attemptId);
  if (basename(resolve(directory)) !== bundle.attemptId || artifact.attemptId !== bundle.attemptId
      || requestBindingSha256(request) !== allocation.requestSha256
      || artifact.controllerAccounting && artifact.controllerAccounting.manifestSha256 !== bundle.manifestSha256) {
    throw new Error('Immutable attempt does not match its controller archive');
  }
  const { files } = decodeControlledEvidence(bundle, options);
  const reportBytes = files.get('result.json'), providerBytes = files.get('provider-artifact.json');
  if (reportBytes) {
    let report, provider;
    try { report = JSON.parse(reportBytes.toString('utf8')); provider = providerBytes ? JSON.parse(providerBytes.toString('utf8')) : undefined; }
    catch { throw new Error('Malformed immutable controller result proof'); }
    const expected = controlledResultArtifact(provider, report, allocation), actual = { ...artifact };
    delete expected.provenance; delete actual.provenance;
    if (actual.controllerEvidenceError !== undefined) {
      if (typeof actual.controllerEvidenceError !== 'string' || !actual.controllerEvidenceError.trim()
          || typeof actual.accountingError !== 'string' || !actual.accountingError.trim()
          || canonical(actual.accountingFailure) !== canonical({ class: 'provider_budget_coverage_unknown', category: 'provider_budget', retryable: false })) {
        throw new Error('Invalid immutable controller retention failure');
      }
      delete actual.controllerEvidenceError;
      if (expected.accountingFailure) { actual.accountingFailure = expected.accountingFailure; actual.accountingError = expected.accountingError; }
      else { delete actual.accountingFailure; delete actual.accountingError; }
    }
    if (canonical(actual) !== canonical(expected)) throw new Error('Immutable result disagrees with its controller proof');
  }

  return bundle;
}

export async function summarizeControlledEvidence(bundles, options) {
  if (!Array.isArray(bundles) || !bundles.length) throw new Error('No controller evidence supplied');
  const groups = new Map();
  for (const bundle of bundles) {
    const decoded = decodeControlledEvidence(bundle, options);
    let group = groups.get(decoded.manifest.campaignId);
    if (group && group.manifestSha256 !== decoded.manifestSha256) throw new Error('Conflicting controller campaign manifests');
    if (!group) {
      group = { ...decoded, filesByAttempt: new Map(), digests: new Map() };
      groups.set(decoded.manifest.campaignId, group);
    }
    const digest = sha256(canonical(bundle));
    if (group.digests.has(decoded.attemptId) && group.digests.get(decoded.attemptId) !== digest) throw new Error('Conflicting controller attempt archives');
    group.digests.set(decoded.attemptId, digest);
    group.filesByAttempt.set(decoded.attemptId, decoded.files);
  }
  const campaigns = [];
  for (const group of [...groups.values()].sort((a, b) => a.manifest.campaignId.localeCompare(b.manifest.campaignId))) {
    campaigns.push(await summarizeControlledCampaign(group.manifest, { filesByAttempt: group.filesByAttempt }));
  }
  return history(campaigns);
}

function history(campaigns) {
  const sum = field => usd(campaigns.reduce((total, campaign) => total + units(campaign[field]), 0n));
  return { schema: 'paperclip.runner-eval.control-history/v1', costStatus: campaigns.some(c => c.costStatus === 'incomplete') ? 'incomplete' : 'provisional',
    ...(campaigns.length && campaigns.every(c => c.accountingReadiness === 'model_requests')
      ? { accountingReadiness: 'model_requests' } : {}),
    ...(campaigns.some(c => c.operatingReconciliation === 'pending') ? { operatingReconciliation: 'pending' } : {}),
    knownUsd: sum('knownUsd'), heldUsd: sum('heldUsd'), committedUsd: sum('committedUsd'), operatingHeldUsd: sum('operatingHeldUsd'),
    incompleteAttempts: campaigns.reduce((total, c) => total + c.incompleteAttempts, 0), overBudget: campaigns.some(c => c.overBudget), campaigns };
}

export async function summarizeControlledManifest(value, bundles, options) {
  const { manifest, manifestSha256 } = validateManifest(value, Date.now(), { admission: false });
  const filesByAttempt = new Map(), digests = new Map();
  for (const bundle of bundles) {
    const decoded = decodeControlledEvidence(bundle, options), digest = sha256(canonical(bundle));
    if (decoded.manifestSha256 !== manifestSha256 || digests.has(decoded.attemptId) && digests.get(decoded.attemptId) !== digest) {
      throw new Error('Archive disagrees with the retained campaign manifest');
    }
    digests.set(decoded.attemptId, digest); filesByAttempt.set(decoded.attemptId, decoded.files);
  }
  return history([await summarizeControlledCampaign(manifest, { filesByAttempt })]);
}

if (await isEntrypoint(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify' && args.length === 2) {
    const { manifest } = validateManifest(await readJson(args[0]));
    const attempt = bindRequest(manifest, await readJson(args[1], 8 * MiB));
    assertHostedAdmission(manifest, attempt, process.env);
  } else if (command === 'pack' && args.length === 3) {
    const bundle = await packControlledAttempt({ manifest: await readJson(args[0]), attemptId: args[1] });
    await writeFile(args[2], JSON.stringify(bundle) + '\n', { flag: 'wx', mode: 0o600 });
  } else if (command === 'report-campaign' && args.length) {
    const result = await summarizeControlledManifest(await readJson(args[0]), await Promise.all(args.slice(1).map(path => readAttemptControlledEvidence(path))));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.costStatus === 'incomplete' ? 2 : 0;
  } else if (['report', 'report-attempts'].includes(command) && args.length) {
    const read = command === 'report' ? readControlledEvidence : readAttemptControlledEvidence;
    const result = await summarizeControlledEvidence(await Promise.all(args.map(path => read(path))));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.costStatus === 'incomplete') process.exitCode = 2;
  } else throw new Error('Usage: archive.mjs verify <manifest.json> <request.json> | pack <manifest.json> <attempt-id> <output.json> | report <evidence.json>... | report-attempts <attempt-directory>... | report-campaign <manifest.json> [attempt-directory...]');
}
