import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { cases, model, targetSha, workflow } from './chat-completion-testops-contract.mjs';

/** A credential-free caller/source control with synthetic IMDS responses.
 * It does not qualify an actual AWS host or make a provider call.
 */
export async function verifyHostContract(workspace, temporaryRoot, env = process.env) {
  if (env.ALLURE_TOKEN || env.OPENROUTER_API_KEY || !path.isAbsolute(workspace)) throw new Error('Credential-free source control required');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  if (source !== targetSha) throw new Error('Source control pin mismatch');
  const definition = parse(await readFile(new URL(`../../${workflow}`, import.meta.url), 'utf8'));
  const paid = definition.jobs.chat.steps.find(step => step.env?.OPENROUTER_API_KEY);
  if (paid.env.PAPERCLIP_CHAT_COMPLETION_TESTOPS !== 'v1' || paid.env.ALLURE_JOB_RUN_ID !== '${{ inputs.ALLURE_JOB_RUN_ID }}'
    || !paid.run.includes('--max-automatic-retries 0') || definition.jobs.chat.strategy['max-parallel'] !== 1) throw new Error('Workflow host contract mismatch');
  const { runnerMatrix } = await import(pathToFileURL(path.join(workspace, 'tests/runner-e2e/catalog.ts')).href);
  const { prepareChatRemoteHost } = await import(pathToFileURL(path.join(workspace, 'tests/runner-e2e/chat-remote-host.ts')).href);
  const root = await realpath(await mkdtemp(path.join(temporaryRoot, 'chat-completion-host-control-')));
  try {
    for (const descriptor of cases) {
      const execution = runnerMatrix.find(row => row.id === descriptor.executionId);
      if (!execution || execution.task.id !== descriptor.scenario || execution.profile.model !== model
        || execution.profile.id !== 'runner-opencode' || execution.environment.id !== 'local'
        || execution.task.expectedRunCount !== descriptor.maximumRuns
        || (execution.task.minimumExpectedRunCount ?? execution.task.expectedRunCount) !== descriptor.minimumRuns) throw new Error('Pinned source selection mismatch');
      const controlEnv = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master',
        GITHUB_WORKFLOW_REF: `paperclipai/paperclip/${workflow}@refs/heads/master`, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
        PAPERCLIP_RUNNER_E2E_SOURCE_SHA: targetSha, PAPERCLIP_CHAT_COMPLETION_TESTOPS: paid.env.PAPERCLIP_CHAT_COMPLETION_TESTOPS,
        ALLURE_JOB_RUN_ID: '1' };
      let calls = 0;
      const dependencies = { platform: 'linux', arch: 'x64', sourceRevision: async () => source,
        fetch: async url => {
          calls++;
          if (String(url) === 'http://169.254.169.254/latest/api/token') return new Response('synthetic-imds-control');
          if (String(url) === 'http://169.254.169.254/latest/meta-data/instance-life-cycle') return new Response('spot');
          if (String(url) === 'http://169.254.169.254/latest/dynamic/instance-identity/document') return Response.json({
            instanceId: 'i-1234567890abcdef0', imageId: 'ami-1234567890abcdef0', region: 'us-east-1', architecture: 'x86_64' });
          throw new Error('Unexpected control request');
        } };
      const input = { executions: [execution], env: controlEnv, repositoryRoot: workspace, outputDirectory: root, dependencies };
      await prepareChatRemoteHost(input);
      const receipt = JSON.parse(await readFile(path.join(root, 'chat-remote-host.json'), 'utf8'));
      if (calls !== 3 || receipt.workflowRef !== controlEnv.GITHUB_WORKFLOW_REF || receipt.testOps?.allureJobRunId !== '1'
        || receipt.testOps.admission !== 'v1' || receipt.evaluationAdmitted !== false) throw new Error('Host audit contract mismatch');
      let rejected = false;
      try { await prepareChatRemoteHost({ ...input, executions: [{ ...execution, task: { ...execution.task, id: 'foreign' } }] }); }
      catch { rejected = true; }
      if (!rejected || calls !== 3) throw new Error('Host task identity contract mismatch');
    }
    return { fixtureOnly: true, liveHostQualified: false, providerCalls: 0, source, cases: cases.length };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyHostContract(process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP)
    .then(value => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch(() => { process.stderr.write('Workflow/source host control failed before provider access\n'); process.exitCode = 1; });
}
