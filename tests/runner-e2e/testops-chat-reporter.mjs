import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicContext, aliases, executionId, scenario } from './chat-feature-testops-api.mjs';
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

export async function reporter(command, argument, env = process.env, fetchImpl = fetch) {
  publicContext(env);
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
