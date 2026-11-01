import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitDispatch, targetSha, workflow, hash, reject, validateSelection, evidencePolicy } from './chat-completion-testops-contract.mjs';
import { testopsClient, bootstrapPilotPlan, completePilotRegistration, validatePilotSelection, launchPilotPlan, verifyPilotUpload } from './chat-completion-testops-api.mjs';
import { parseOfficialBootstrapContext } from './testops-chat-reporter.mjs';
import { exportPilotAllure, readPilotExport } from './chat-completion-testops-results.mjs';

const execute = promisify(execFile);
async function readOwned(file, root, limit) {
  const absolute = path.resolve(file), base = await realpath(root);
  if (!absolute.startsWith(`${base}${path.sep}`)) reject('file_path');
  let current = base; const parts = path.relative(base, absolute).split(path.sep);
  for (const [index, part] of parts.entries()) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || ['.', '..'].includes(part)) reject('file_path');
    current = path.join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > limit)) reject('file_path');
  }
  return readFile(absolute);
}
export async function actualContext(env, exec = execute) {
  if (!env.GITHUB_EVENT_PATH || !env.GH_TOKEN || !/^[1-9][0-9]{0,15}$/.test(env.GITHUB_RUN_ID ?? '')) reject('context');
  const stat = await lstat(env.GITHUB_EVENT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) reject('event');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const { stdout } = await exec('gh', ['api', `repos/paperclipai/paperclip/actions/runs/${env.GITHUB_RUN_ID}`],
    { env, shell: false, timeout: 30_000, maxBuffer: 512_000, encoding: 'utf8' });
  const run = JSON.parse(stdout), context = admitDispatch(env, event, run.triggering_actor?.id);
  if (run.id !== Number(context.runId) || run.run_attempt !== 1 || run.head_sha !== context.workflowSha || run.head_branch !== 'master'
    || run.event !== 'workflow_dispatch' || run.path !== workflow || run.repository?.full_name !== 'paperclipai/paperclip' || run.repository.private !== false
    || run.actor?.id !== context.actorId || run.run_number !== Number(env.GITHUB_RUN_NUMBER)
    || !Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0) reject('actual_run');
  return { ...context, workflowId: run.workflow_id };
}
async function readSelection(file, env, context) {
  if (!/^[a-f0-9]{64}$/.test(env.EXPECTED_SELECTION_SHA256 ?? '')) reject('selection_digest');
  const bytes = await readOwned(file, env.GITHUB_WORKSPACE, 32_768);
  if (hash(bytes) !== env.EXPECTED_SELECTION_SHA256) reject('selection_digest');
  const selected = JSON.parse(bytes); validateSelection(selected, context, env.ALLURE_JOB_RUN_ID); return selected;
}
async function output(env, key, value) {
  if (!env.GITHUB_OUTPUT || /[\r\n]/.test(value)) reject('output');
  await appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
async function stateDirectory(env, command, existing = false) {
  const root = path.join(await realpath(env.RUNNER_TEMP), `chat-completion-testops-${command}`);
  if (!existing) await mkdir(root, { mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) reject('state_directory');
  return root;
}
const writeReceipt = (root, name, value) => writeFile(path.join(root, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
function mutationMarker(root) {
  return async stage => {
    if (!/^[a-z_]{1,80}$/.test(stage)) reject('mutation_marker');
    const handle = await open(path.join(root, `once-${stage}.json`), 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ stage, status: 'STARTED_NO_AUTOMATIC_RESEND' })); await handle.close();
  };
}

export async function run(command, argument, env = process.env, { fetchImpl = fetch, exec = execute } = {}) {
  let state;
  try {
    if (!['guard', 'bootstrap', 'bootstrap-context', 'selection', 'launch-plan', 'verify-selection', 'upload', 'verify-upload'].includes(command)) reject('operation');
    const context = await actualContext(env, exec);
    if (command === 'guard') {
      await output(env, 'operation', context.operation); await output(env, 'target_sha', targetSha);
      await output(env, 'workflow_id', String(context.workflowId)); return 0;
    }
    if (command === 'verify-selection') {
      if (Object.hasOwn(env, 'ALLURE_TOKEN')) reject('worker_credential');
      await readSelection(argument, env, context); return 0;
    }
    if (['bootstrap', 'bootstrap-context'].includes(command) && context.operation !== 'bootstrap'
      || command === 'launch-plan' && context.operation !== 'launch-plan'
      || ['selection', 'upload', 'verify-upload'].includes(command) && context.operation !== 'evaluate') reject('operation');
    state = await stateDirectory(env, command === 'bootstrap-context' ? 'bootstrap' : command, command === 'bootstrap-context');
    const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
    if (command === 'bootstrap') {
      const prepared = await bootstrapPilotPlan(api, Number(env.CHAT_TESTOPS_INTEGRATION_ID), mutationMarker(state));
      await writeReceipt(state, 'prepared.json', prepared); return 0;
    }
    if (command === 'bootstrap-context') {
      const official = parseOfficialBootstrapContext((await exec('allurectl', ['job-run', 'env'],
        { env, shell: false, timeout: 30_000, maxBuffer: 16_384, encoding: 'utf8' })).stdout);
      const prepared = JSON.parse(await readOwned(path.join(state, 'prepared.json'), env.RUNNER_TEMP, 32_768));
      const receipt = await completePilotRegistration(api, prepared, official, context, context.workflowId, mutationMarker(state),
        observation => writeReceipt(state, 'registration-observed.json', observation));
      await writeReceipt(state, 'registration.json', receipt); return 0;
    }
    if (command === 'launch-plan') {
      const receipt = await launchPilotPlan(api, env, context, context.workflowId, mutationMarker(state));
      await writeReceipt(state, 'launch.json', receipt); return 0;
    }
    if (command === 'selection') {
      const selection = await validatePilotSelection(api, env, context, context.workflowId);
      await writeReceipt(state, 'selection.json', selection);
      const bytes = Buffer.from(JSON.stringify(selection, null, 2));
      await writeFile(path.join(env.GITHUB_WORKSPACE, 'testops-pilot-selection.json'), bytes, { flag: 'wx', mode: 0o600 });
      await output(env, 'selection_sha256', hash(bytes));
      await output(env, 'execution_ids', JSON.stringify(selection.cases.map(row => row.executionId)));
      await output(env, 'matrix', JSON.stringify({ include: selection.cases.map(row => ({ executionId: row.executionId, key: row.key })) }));
      await output(env, 'policy', JSON.stringify(evidencePolicy(selection, context, env.ALLURE_JOB_RUN_ID))); return 0;
    }
    const selected = await readSelection(path.join(env.GITHUB_WORKSPACE, 'chat-completion-testops-selection', 'testops-pilot-selection.json'), env, context);
    if (command === 'upload') {
      const exported = await exportPilotAllure(path.resolve(argument), env.ALLURE_RESULTS, context, selected);
      await writeReceipt(state, 'exported.json', exported); return exported.some(row => row.status !== 'passed') ? 1 : 0;
    }
    const prior = path.join(env.RUNNER_TEMP, 'chat-completion-testops-upload', 'exported.json');
    const exported = JSON.parse(await readOwned(prior, env.RUNNER_TEMP, 32_768));
    const { campaign } = await readPilotExport(path.resolve(argument), context, selected);
    if (exported.some(row => {
      const original = campaign.results.find(value => value.executionId === row.executionId);
      return !original || row.status !== (original.status === 'passed' && original.cleanup === 'passed' ? 'passed' : 'failed') || row.cleanup !== original.cleanup;
    })) reject('upload_receipt');
    const verification = await verifyPilotUpload(api, selected, context, exported);
    await writeReceipt(state, 'verification.json', verification); return 0;
  } catch (error) {
    const code = /^(chat_completion_testops_[a-z_]{1,80}|testops_(?:api|auth)_http(?:_[1-5][0-9]{2})?)$/.test(error?.message ?? '') ? error.message : 'chat_completion_testops_unknown';
    const receipt = { command, code, httpStatus: Number.isInteger(error?.status) ? error.status : null };
    if (state) await writeReceipt(state, 'failure.json', receipt).catch(() => {});
    process.stderr.write(`Chat completion TestOps stopped: ${JSON.stringify(receipt)}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; });
}
