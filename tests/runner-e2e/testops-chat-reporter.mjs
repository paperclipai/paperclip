import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicContext, aliases, executionId, scenario, endpoint, testopsClient, bootstrapJobMetadata, failureProjection } from './chat-feature-testops-api.mjs';
import { run } from './chat-feature-testops-cli.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('chat_testops_selection_rejected'); };

async function readVerifiedSelection(file, env) {
  const expected = publicContext(env);
  if (!/^[a-f0-9]{64}$/.test(env.EXPECTED_SELECTION_SHA256 ?? '') || !/^[1-9][0-9]{0,15}$/.test(env.ALLURE_JOB_RUN_ID ?? '')) fail();
  const root = await realpath(env.GITHUB_WORKSPACE ?? process.cwd()), absolute = path.resolve(file);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail();
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep);
  for (const [index, part] of parts.entries()) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || ['.', '..'].includes(part)) fail();
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 16_384)) fail();
  }
  const bytes = await readFile(absolute);
  if (hash(bytes) !== env.EXPECTED_SELECTION_SHA256) fail();
  const value = JSON.parse(bytes);
  if (value.schema !== 'paperclip.chat-feature-testops-selection/v1' || value.runId !== expected.runId || value.attempt !== '1'
    || value.workflowSha !== expected.workflowSha || value.targetSha !== expected.targetSha || value.allureJobRunId !== env.ALLURE_JOB_RUN_ID
    || value.executionId !== executionId || value.canonicalScenario !== scenario || value.projectId !== 1 || !aliases.includes(value.fullName)
    || ['planId', 'jobId', 'caseId', 'launchId'].some(key => !Number.isSafeInteger(value[key]) || value[key] <= 0)) fail();
  return { value, bytes };
}

export async function verifySelectionFile(file, env) {
  return (await readVerifiedSelection(file, env)).value;
}

const officialExec = promisify(execFile);
class BootstrapContextFailure extends Error {}
const rejectBootstrapContext = () => { throw new BootstrapContextFailure('chat_testops_bootstrap_context_invalid'); };

export function parseOfficialBootstrapContext(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16_384) rejectBootstrapContext();
  const values = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    for (const name of ['ALLURE_JOB_RUN_ID', 'ALLURE_LAUNCH_ID']) {
      if (!line.startsWith(`${name}=`)) continue;
      const value = line.slice(name.length + 1);
      if (values.has(name) || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) rejectBootstrapContext();
      values.set(name, value);
    }
  }
  if (values.size !== 2) rejectBootstrapContext();
  return { jobRunId: values.get('ALLURE_JOB_RUN_ID'), launchId: Number(values.get('ALLURE_LAUNCH_ID')) };
}

async function captureBootstrapContext(env, fetchImpl, execImpl) {
  let stateRoot;
  try {
    if (env.ALLURE_ENDPOINT !== endpoint || env.ALLURE_PROJECT_ID !== '1' || !env.RUNNER_TEMP
      || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE) || !env.GITHUB_EVENT_PATH) rejectBootstrapContext();
    const eventStat = await lstat(env.GITHUB_EVENT_PATH);
    if (!eventStat.isFile() || eventStat.isSymbolicLink() || eventStat.nlink !== 1 || eventStat.size > 65_536) rejectBootstrapContext();
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.inputs || Object.keys(event.inputs).some(key => !['operation', 'ALLURE_JOB_RUN_ID', 'ALLURE_USERNAME'].includes(key))
      || event.inputs.operation !== 'bootstrap' || (event.inputs.ALLURE_JOB_RUN_ID ?? '') !== '') rejectBootstrapContext();
    const requested = path.join(await realpath(env.RUNNER_TEMP), 'chat-testops-bootstrap-state');
    const stateStat = await lstat(requested);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || await realpath(requested) !== requested
      || process.getuid && stateStat.uid !== process.getuid() || stateStat.mode & 0o077) rejectBootstrapContext();
    stateRoot = requested;
    for (const name of ['registration.json', 'registration-failure.json']) {
      try { await lstat(path.join(stateRoot, name)); rejectBootstrapContext(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let output;
    try {
      output = await execImpl('allurectl', ['job-run', 'env'], { cwd: await realpath(env.GITHUB_WORKSPACE), env,
        shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384, windowsHide: true });
    } catch { throw new BootstrapContextFailure('chat_testops_bootstrap_command_failed'); }
    const captured = parseOfficialBootstrapContext(output.stdout);
    const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
    const registration = await bootstrapJobMetadata(api, { ...env, ALLURE_JOB_RUN_ID: captured.jobRunId }, captured.launchId);
    await writeFile(path.join(stateRoot, 'registration.json'), JSON.stringify(registration, null, 2), { flag: 'wx', mode: 0o600 });
    return 0;
  } catch (error) {
    const safe = error instanceof BootstrapContextFailure
      ? { stage: 'bootstrap_context', code: error.message, httpStatus: null }
      : failureProjection(error, 'bootstrap_context');
    if (stateRoot) await writeFile(path.join(stateRoot, 'registration-failure.json'), JSON.stringify(safe, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
    process.stderr.write(`Chat TestOps bootstrap context stopped: ${JSON.stringify(safe)}\n`);
    return 1;
  }
}

export async function reporter(command, argument, env = process.env, fetchImpl = fetch, execImpl = officialExec) {
  publicContext(env);
  if (command === 'bootstrap-context') return captureBootstrapContext(env, fetchImpl, execImpl);
  if (command === 'verify-selection') {
    if (Object.hasOwn(env, 'ALLURE_TOKEN')) fail();
    await verifySelectionFile(argument, env);
    return 0;
  }
  if (!['bootstrap', 'launch-plan', 'selection', 'upload', 'verify-upload'].includes(command) || !env.RUNNER_TEMP) fail();
  const stage = command === 'selection' ? 'validate-selection' : command === 'upload' ? 'export' : command;
  const stateRoot = path.join(env.RUNNER_TEMP, `chat-testops-${command}-state`);
  const selectionPath = path.join(env.GITHUB_WORKSPACE ?? process.cwd(), 'chat-testops-selection', 'testops-selection.json');
  let copiedSelectionPath = selectionPath;
  if (command === 'upload' || command === 'verify-upload') {
    const { bytes } = await readVerifiedSelection(selectionPath, env);
    copiedSelectionPath = path.join(env.RUNNER_TEMP, 'chat-testops-authenticated-selection.json');
    if (command === 'upload') await writeFile(copiedSelectionPath, bytes, { flag: 'wx', mode: 0o600 });
    else if (!(await readFile(copiedSelectionPath)).equals(bytes)) fail();
  }
  const result = await run({ ...env, CHAT_TESTOPS_OPERATION: stage, CHAT_TESTOPS_STATE_ROOT: stateRoot,
    ...(['upload', 'verify-upload'].includes(command) ? { CHAT_TESTOPS_EXPORT_ROOT: path.resolve(argument), CHAT_TESTOPS_SELECTION: copiedSelectionPath,
      ALLURE_RESULTS: env.ALLURE_RESULTS ?? path.join(env.RUNNER_TEMP, 'chat-testops-allure-results') } : {}) }, fetchImpl);
  if (command === 'selection' && result === 0) {
    const bytes = await readFile(path.join(stateRoot, 'selection.json'));
    await writeFile(path.join(env.GITHUB_WORKSPACE ?? process.cwd(), 'testops-selection.json'), bytes, { flag: 'wx', mode: 0o600 });
    if (!env.GITHUB_OUTPUT) fail();
    await appendFile(env.GITHUB_OUTPUT, `sha256=${hash(bytes)}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reporter(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; })
    .catch(() => { process.stderr.write('Chat TestOps reporter stopped: invalid source, custody or selection\n'); process.exitCode = 1; });
}
