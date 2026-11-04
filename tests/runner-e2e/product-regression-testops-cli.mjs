import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testopsClient } from './chat-feature-testops-api.mjs';
import { endpoint, workflowUrls, selectProductRegression, validateSelection, projectProductResults } from './product-regression-testops.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`product_regression_testops_${code}`); };
const positive = value => /^[1-9][0-9]{0,15}$/.test(String(value ?? ''));

export function admitProductTestOps(env) {
  if (env.GITHUB_REPOSITORY !== 'paperclipai/paperclip' || env.GITHUB_REF !== 'refs/heads/master'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_WORKFLOW_REF !== 'paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master'
      || !positive(env.GITHUB_RUN_ID) || !positive(env.GITHUB_RUN_ATTEMPT)
      || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[a-f0-9]{40}$/.test(env.SOURCE_SHA ?? '')
      || env.ALLURE_ENDPOINT !== endpoint || env.ALLURE_PROJECT_ID !== '1'
      || (env.EVAL_CADENCE ?? 'manual') !== 'manual'
      || ['SELECT_ID', 'SELECT_SUITE', 'SELECT_GROUP', 'SELECT_PROFILE', 'SELECT_ENVIRONMENT', 'SELECT_CASE'].some(key => env[key])) fail('untrusted_context');
}

async function readJson(file, limit) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('file_invalid');
  return JSON.parse(await readFile(file, 'utf8'));
}

export function officialProductContext(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16_384) fail('official_context');
  const found = {};
  for (const line of stdout.split(/\r?\n/)) for (const key of ['ALLURE_JOB_RUN_ID', 'ALLURE_LAUNCH_ID']) {
    if (!line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1);
    if (found[key] || !positive(value)) fail('official_context');
    found[key] = value;
  }
  if (Object.keys(found).length !== 2) fail('official_context');
  return { jobRunId: found.ALLURE_JOB_RUN_ID, launchId: Number(found.ALLURE_LAUNCH_ID) };
}

export async function verifyProductJob(api, context, env, allowUnstarted = false) {
  const run = await api(`/api/jobrun/${context.jobRunId}`);
  if (run.id !== Number(context.jobRunId) || run.launchId !== context.launchId || !positive(run.job?.id)
      || run.job.type !== 'github' || (run.url !== `https://github.com/paperclipai/paperclip/actions/runs/${env.GITHUB_RUN_ID}`
        && !(allowUnstarted && (run.url == null || run.url === '')))) fail('job_run_mismatch');
  const [job, launch] = await Promise.all([api(`/api/job/${run.job.id}`), api(`/api/launch/${context.launchId}`)]);
  if (job.id !== run.job.id || job.type !== 'github' || !workflowUrls.has(job.url)
      || launch.id !== context.launchId || launch.projectId !== 1) fail('job_mismatch');
  return { jobId: job.id, launchId: launch.id };
}

export function validateUploadedProductResults(details, selection, summary) {
  if (!Array.isArray(summary.cases) || summary.cases.length !== selection.cases.length
      || new Set(summary.cases.map(row => row.caseId)).size !== selection.cases.length
      || summary.cases.some(row => !selection.cases.some(value => value.id === row.caseId)
        || !['passed', 'failed', 'broken'].includes(row.status))) fail('expected_status_invalid');
  if (details.length !== selection.cases.length || new Set(details.map(row => row.testCaseId)).size !== selection.cases.length || details.some(row => {
    const selected = selection.cases.find(value => value.id === row.testCaseId);
    return !selected || row.fullName !== selected.fullName || row.projectId !== 1 || row.launchId !== selection.launchId
      || row.jobRun?.id !== Number(selection.jobRunId) || !['passed', 'failed', 'broken'].includes(row.status);
  })) fail('uploaded_identity_mismatch');
  const counts = Object.fromEntries(['passed', 'failed', 'broken'].map(status => [status, details.filter(row => row.status === status).length]));
  if (Object.entries(counts).some(([status, count]) => summary[status] !== count)
      || details.some(row => summary.cases.find(value => value.caseId === row.testCaseId).status !== row.status)) fail('uploaded_status_mismatch');
}

export async function productTestOps(command, argument, env = process.env, exec = execute, fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  admitProductTestOps(env);
  if (command === 'select') {
    const requestedJob = env.ALLURE_JOB_RUN_ID || '';
    if (requestedJob && !positive(requestedJob)) fail('job_run_invalid');
    // Reject a bad bootstrap selector before opening any run. Before adopting
    // a TestOps dispatch, independently check its pending job and project.
    const manualCases = requestedJob ? undefined : selectProductRegression(undefined, env.TESTOPS_CASE || 'all');
    const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
    if (requestedJob) {
      const pending = await api(`/api/jobrun/${requestedJob}`);
      if (!Number.isSafeInteger(pending.launchId) || pending.launchId < 1) fail('job_run_invalid');
      await verifyProductJob(api, { jobRunId: requestedJob, launchId: pending.launchId }, env, true);
    }
    // Start and stop are separated so the official job run remains open while
    // the existing isolated GitHub matrix runs in other jobs.
    // A final always() job uses the same official CI identity even if start
    // times out ambiguously or cancellation interrupts the following reads.
    await appendFile(env.GITHUB_OUTPUT, 'job_run_started=true\n');
    await exec('allurectl', ['job-run', 'start'], { env, timeout: 60_000, maxBuffer: 32_768 });
    const { stdout } = await exec('allurectl', ['job-run', 'env'], { env, timeout: 30_000, maxBuffer: 16_384 });
    const context = officialProductContext(stdout);
    if (requestedJob && requestedJob !== context.jobRunId) fail('job_run_mismatch');
    await appendFile(env.GITHUB_OUTPUT, `job_run_id=${context.jobRunId}\nlaunch_url=${endpoint}/launch/${context.launchId}\n`);
    const boundEnv = { ...env, ALLURE_JOB_RUN_ID: context.jobRunId };
    const job = await verifyProductJob(api, context, env);
    let plan;
    if (requestedJob) {
      const planFile = path.join(env.RUNNER_TEMP, 'product-regression-testplan.json');
      await exec('allurectl', ['job-run', 'plan', '--job-run-id', context.jobRunId, '--output-file', planFile],
        { env: boundEnv, timeout: 30_000, maxBuffer: 32_768 });
      plan = await readJson(planFile, 65_536);
    }
    const cases = manualCases ?? selectProductRegression(plan, env.TESTOPS_CASE || 'all', true);
    const selection = { schema: 'paperclip.product-regression-testops-selection/v1',
      runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowSha: env.GITHUB_SHA,
      targetSha: env.SOURCE_SHA, ...context, ...job, cases };
    validateSelection(selection, env);
    const bytes = Buffer.from(JSON.stringify(selection, null, 2));
    await mkdir(path.dirname(argument), { recursive: true });
    await writeFile(argument, bytes, { flag: 'wx', mode: 0o600 });
    await appendFile(env.GITHUB_OUTPUT, `ids=${cases.map(row => row.executionId).join(',')}\nselection_sha256=${hash(bytes)}\n`);
    return 0;
  }
  if (!['project', 'verify'].includes(command)) fail('command_invalid');
  const bytes = await readFile(argument);
  if (bytes.length > 65_536 || hash(bytes) !== env.SELECTION_SHA256) fail('selection_hash');
  const selection = validateSelection(JSON.parse(bytes), env);
  if (env.ALLURE_JOB_RUN_ID !== selection.jobRunId) fail('job_run_mismatch');
  if (command === 'project') {
    let campaign;
    try { campaign = await readJson(path.join(env.REPORT_DIR, 'normalized', 'normalized-results.json'), 20 * 1024 * 1024); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { records, summary } = projectProductResults(campaign, selection, env.SOURCE_SHA);
    await mkdir(env.ALLURE_RESULTS, { recursive: false, mode: 0o700 });
    for (const row of records) await writeFile(path.join(env.ALLURE_RESULTS, row.file), JSON.stringify(row.value), { flag: 'wx', mode: 0o600 });
    await writeFile(env.EXPORT_SUMMARY, JSON.stringify(summary), { flag: 'wx', mode: 0o600 });
    await appendFile(env.GITHUB_STEP_SUMMARY, `### [Product regression TestOps results](${endpoint}/launch/${selection.launchId})\n\n${summary.passed}/${summary.selected} passed; ${summary.failed} failed; ${summary.broken} broken. ${summary.fullPlan ? 'Complete 20-case plan selection.' : 'Targeted selection; not a full-plan verdict.'}\n`);
    return 0;
  }
  const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
  await verifyProductJob(api, selection, env);
  const summary = await readJson(env.EXPORT_SUMMARY, 16_384);
  // Observe one upload with at most 55 seconds of poll waits, matching the
  // mature chat lane. This budget never retries or extends a product scenario.
  let observed, lastVerification;
  for (let attempt = 0; attempt < 12; attempt++) {
    observed = await api(`/api/testresult?${new URLSearchParams({ launchId: String(selection.launchId), page: '0', size: '100' })}`);
    if (!Array.isArray(observed?.content) || observed.totalPages > 1 || observed.totalElements !== observed.content.length) fail('result_page_invalid');
    const actual = observed.content;
    if (actual.length === selection.cases.length && actual.every(row => selection.cases.some(value => value.id === row.testCaseId))) {
      const details = await Promise.all(actual.map(row => api(`/api/testresult/${row.id}`)));
      try { validateUploadedProductResults(details, selection, summary); return 0; }
      catch (error) {
        if (!['product_regression_testops_uploaded_identity_mismatch', 'product_regression_testops_uploaded_status_mismatch'].includes(error.message)) throw error;
        lastVerification = error;
      }
    }
    // Planned rows can exist before the asynchronous upload processor settles
    // their run binding and verdict. Observe this one upload, without rerunning
    // the product or accepting unknown/partial results.
    if (attempt === 11) { if (lastVerification) throw lastVerification; fail('upload_incomplete'); }
    await wait(5_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  productTestOps(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; }).catch(error => {
    const safe = /^product_regression_testops_[a-z_]+$/.test(error.message) ? error.message : 'product_regression_testops_failed';
    process.stderr.write(`${safe}\n`); process.exitCode = 1;
  });
}
