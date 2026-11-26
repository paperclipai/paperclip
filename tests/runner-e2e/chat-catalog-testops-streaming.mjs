import { cp, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hash, validateSelection, reject } from './chat-completion-testops-contract.mjs';
import { readPilotExport, exportPilotAllure } from './chat-completion-testops-results.mjs';
import { inspectPilotCaseUpload, verifyPilotCaseUpload } from './chat-completion-testops-api.mjs';

export function caseSelection(selection, context, executionId) {
  if (context.catalog !== 'full') reject('stream_scope');
  const authorized = validateSelection(selection, context, selection.allureJobRunId);
  const row = authorized.find(value => value.executionId === executionId);
  if (!row) reject('stream_scope');
  return { ...selection, cases: [row] };
}
const identity = (selection, context, executionId, selectionSha256) => {
  if (!/^[a-f0-9]{64}$/.test(selectionSha256)) reject('stream_binding');
  const scoped = caseSelection(selection, context, executionId), row = scoped.cases[0];
  return { schema: 'paperclip.chat-catalog-testops-case-bundle/v1', ...context,
    projectId: 1, planId: selection.planId, jobId: selection.jobId, launchId: selection.launchId,
    allureJobRunId: selection.allureJobRunId, executionId, caseId: row.caseId,
    fullSelectionSha256: selectionSha256, fullSelectionCount: selection.cases.length };
};
async function filesAt(root, wanted) {
  if (await realpath(root) !== path.resolve(root)) reject('stream_bundle');
  const names = (await readdir(root)).sort();
  if (names.length !== 3 || names.some(name => !/^[a-f0-9-]{36}-(?:attachment|result)\.json$/.test(name))
    || names.filter(name => name.endsWith('-result.json')).length !== 1) reject('stream_bundle');
  const files = []; let total = 0;
  for (const name of names) {
    const file = path.join(root, name), before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 12 * 1024 * 1024) reject('stream_bundle');
    const bytes = await readFile(file), after = await lstat(file); total += bytes.length;
    if (total > 32 * 1024 * 1024 || before.ino !== after.ino || before.dev !== after.dev || before.size !== bytes.length
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject('stream_bundle');
    files.push({ name, bytes, sha256: hash(bytes) });
  }
  const metadata = files.map(file => ({ name: file.name, bytes: file.bytes.length, sha256: file.sha256 }));
  if (wanted && JSON.stringify(metadata) !== JSON.stringify(wanted)) reject('stream_bundle');
  return { files, metadata };
}

// The existing exporter owns grades and the public allowlist. Materialize once;
// preserve these exact UUID-bearing bytes through every later readback.
export async function prepareCaseBundle(root, output, context, selection, executionId, selectionSha256) {
  const bound = identity(selection, context, executionId, selectionSha256);
  const scoped = caseSelection(selection, context, executionId);
  const exported = await exportPilotAllure(root, output, context, scoped);
  const { metadata: files } = await filesAt(output);
  const prepared = { ...bound,
    projectionBindingSha256: hash(await readFile(path.join(root, 'binding.json'))), exported, files };
  return { ...prepared, payloadSha256: hash(JSON.stringify(prepared)) };
}

export async function readCaseBundle(root, output, prepared, context, selection, executionId, selectionSha256) {
  const expected = identity(selection, context, executionId, selectionSha256);
  if (!prepared || Object.entries(expected).some(([key, value]) => prepared[key] !== value)) reject('stream_binding');
  const { payloadSha256, ...unsigned } = prepared;
  if (!/^[a-f0-9]{64}$/.test(payloadSha256) || hash(JSON.stringify(unsigned)) !== payloadSha256) reject('stream_bundle');
  const scoped = caseSelection(selection, context, executionId);
  const validated = await readPilotExport(root, context, scoped), original = validated.campaign.results[0];
  if (hash(await readFile(path.join(root, 'binding.json'))) !== prepared.projectionBindingSha256
    || !Array.isArray(prepared.exported) || prepared.exported.length !== 1
    || prepared.exported[0].caseId !== expected.caseId || prepared.exported[0].executionId !== executionId
    || prepared.exported[0].status !== (original.status === 'passed' && original.cleanup === 'passed' ? 'passed' : 'failed')
    || prepared.exported[0].cleanup !== original.cleanup) reject('stream_binding');
  return filesAt(output, prepared.files);
}

export async function publishCaseBundle(api, root, output, prepared, context, selection, executionId, selectionSha256, markOnce, options) {
  const { files } = await readCaseBundle(root, output, prepared, context, selection, executionId, selectionSha256);
  const before = await inspectPilotCaseUpload(api, selection, context, executionId, options);
  let response, uncertain = null;
  if (!before.present) {
    // Once markers are retained before this call. An uncertain reply is reconciled
    // by GET only. Neither this function nor the finalizer repeats the POST.
    await markOnce({ executionId, caseId: prepared.caseId, payloadSha256: prepared.payloadSha256 });
    const body = new FormData();
    for (const file of files) body.append('file', new Blob([file.bytes], { type: 'application/json' }), file.name);
    try { response = await api(`/api/jobrun/${selection.allureJobRunId}/upload`, 'POST', body); }
    catch (error) { uncertain = { kind: ['testops_api_http', 'testops_response_invalid', 'testops_response_too_large'].includes(error?.code)
      ? error.code : 'transport_or_response_failure', httpStatus: Number.isInteger(error?.status) ? error.status : null }; }
  }
  let verification;
  try { verification = await verifyPilotCaseUpload(api, selection, context, executionId, prepared.exported, options); }
  catch (error) {
    if (uncertain) { const stopped = new Error('chat_completion_testops_stream_upload_uncertain'); stopped.uploadFailure = uncertain; throw stopped; }
    throw error;
  }
  const after = await api(`/api/jobrun/${selection.allureJobRunId}`);
  if (after.id !== Number(selection.allureJobRunId) || after.job?.id !== selection.jobId || after.launchId !== selection.launchId
    || after.url !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}` || !['in_progress', 'finished'].includes(after.stage)) reject('jobrun_mismatch');
  return { ...identity(selection, context, executionId, selectionSha256), schema: 'paperclip.chat-catalog-testops-case-publication/v1',
    payloadSha256: prepared.payloadSha256, projectionBindingSha256: prepared.projectionBindingSha256, exported: prepared.exported[0],
    uploadSent: !before.present, uncertainUpload: uncertain, jobRunStageBefore: before.jobRunStage, jobRunStageAfter: after.stage,
    responseFilesCount: Number.isSafeInteger(response?.filesCount) && response.filesCount >= 0 ? response.filesCount : null,
    verification: verification.verification, results: verification.results };
}

// Artifact names remain authoritative. Singleton downloads must use an exact
// action `name` and that named child destination: the pinned downloader flattens
// a one-artifact pattern result even with merge-multiple:false.
async function artifactDirectories(root, kind, context, selection) {
  if (context.catalog !== 'full') reject('stream_scope');
  const rows = validateSelection(selection, context, selection.allureJobRunId);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== path.resolve(root)) reject('stream_publications');
  const names = rows.map((_, index) => `chat-catalog-case-${kind}-${context.runId}-1-${index}`);
  const actual = await readdir(root);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))) reject('stream_publications');
  const directories = names.map(name => path.join(root, name));
  for (const directory of directories) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) reject('stream_publications');
    const wanted = kind === 'bundle' ? ['allure', 'prepared.json', 'projection'] : ['publication.json', 'once-upload_case.json'];
    const entries = await readdir(directory);
    if (entries.some(name => !wanted.includes(name))
      || (kind === 'bundle' ? entries.length !== wanted.length : !entries.includes('publication.json'))) reject('stream_publications');
    if (kind === 'publication' && entries.includes('once-upload_case.json')) {
      const marker = await artifactJson(directory, 'once-upload_case.json');
      if (Object.keys(marker).sort().join() !== 'stage,status' || marker.stage !== 'upload_case'
        || marker.status !== 'STARTED_NO_AUTOMATIC_RESEND') reject('stream_publications');
    }
  }
  return directories;
}
async function artifactJson(directory, name) {
  const file = path.join(directory, name), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) reject('stream_publications');
  return JSON.parse(await readFile(file, 'utf8'));
}

// Copy only authenticated safe projections. UUID-bearing Allure bytes are read
// for integrity, never regenerated or uploaded by this metadata-only command.
export async function gatherCaseProjections(bundlesRoot, output, context, selection, selectionSha256) {
  const bundles = await artifactDirectories(bundlesRoot, 'bundle', context, selection);
  for (const [index, bundle] of bundles.entries()) {
    const prepared = await artifactJson(bundle, 'prepared.json');
    await readCaseBundle(path.join(bundle, 'projection'), path.join(bundle, 'allure'), prepared, context,
      selection, selection.cases[index].executionId, selectionSha256);
  }
  await mkdir(output, { mode: 0o700 });
  for (const [index, bundle] of bundles.entries()) {
    const destination = path.join(output, path.basename(bundle));
    await cp(path.join(bundle, 'projection'), destination, { recursive: true, force: false, errorOnExist: true });
    await readPilotExport(destination, context, caseSelection(selection, context, selection.cases[index].executionId));
  }
}

// The finalizer authenticates the already-emitted bytes and their original
// grades. It never calls the random-UUID exporter or the upload endpoint.
export async function publicationSet(bundlesRoot, publicationsRoot, context, selection, selectionSha256) {
  const rows = validateSelection(selection, context, selection.allureJobRunId);
  const bundles = await artifactDirectories(bundlesRoot, 'bundle', context, selection);
  const publications = await artifactDirectories(publicationsRoot, 'publication', context, selection);
  const exported = [];
  for (const [index, row] of rows.entries()) {
    const bundle = bundles[index], publication = publications[index];
    const prepared = await artifactJson(bundle, 'prepared.json');
    await readCaseBundle(path.join(bundle, 'projection'), path.join(bundle, 'allure'), prepared, context, selection, row.executionId, selectionSha256);
    const value = await artifactJson(publication, 'publication.json');
    const expected = { ...identity(selection, context, row.executionId, selectionSha256), schema: 'paperclip.chat-catalog-testops-case-publication/v1' };
    if (Object.entries(expected).some(([key, wanted]) => value[key] !== wanted)
      || value.payloadSha256 !== prepared.payloadSha256 || value.projectionBindingSha256 !== prepared.projectionBindingSha256
      || JSON.stringify(value.exported) !== JSON.stringify(prepared.exported[0]) || value.verification !== 'VERIFIED'
      || !Array.isArray(value.results) || value.results.length !== 1 || value.results[0].caseId !== row.caseId
      || value.results[0].executionId !== row.executionId || value.results[0].attachmentsVerified !== true) reject('stream_publications');
    exported.push(value.exported);
  }
  return exported;
}
