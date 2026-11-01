import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { admitDispatch, cases, targetSha, validateSelection, evidencePolicy } from './chat-completion-testops-contract.mjs';
import { actualContext } from './chat-completion-testops-cli.mjs';

function fixture() {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'paperclipai/paperclip',
    GITHUB_REF: 'refs/heads/master', GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-completion-testops.yml@refs/heads/master',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR_ID: '42', TESTOPS_ALLOWED_ACTOR_IDS: '[42]' };
  const event = { repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' },
    ref: env.GITHUB_REF, sender: { id: 42 }, inputs: { ALLURE_JOB_RUN_ID: '77' } };
  const context = admitDispatch(env, event, 42);
  const selection = { schema: 'paperclip.chat-completion-testops-selection/v1', ...context, projectId: 1,
    allureJobRunId: '77', planId: 10, jobId: 11, launchId: 12, cases: cases.map((row, index) => ({ ...row, caseId: 100 + index })) };
  return { env, event, context, selection };
}

test('actual TestOps selection can execute the three exact cases or a genuine subset', () => {
  const f = fixture(); assert.equal(validateSelection(f.selection, f.context, '77').length, 3);
  f.selection.cases = [f.selection.cases[2]];
  const policy = evidencePolicy(f.selection, f.context, '77');
  assert.deepEqual(policy.approvals[0].executionIds, [cases[2].executionId]);
  assert.equal(policy.approvals[0].targetSha, targetSha);
});

for (const kind of ['foreign-workflow', 'candidate-ref', 'replay', 'unlisted-trigger', 'foreign-repo', 'extra-source-input', 'missing-jobrun']) {
  test(`rejects ${kind} before any service or provider credential`, () => {
    const f = fixture(); let trigger = 42;
    if (kind === 'foreign-workflow') f.env.GITHUB_WORKFLOW_REF = f.env.GITHUB_WORKFLOW_REF.replace('chat-completion', 'chat-feature');
    if (kind === 'candidate-ref') f.env.GITHUB_REF = 'refs/heads/codex/candidate';
    if (kind === 'replay') f.env.GITHUB_RUN_ATTEMPT = '2';
    if (kind === 'unlisted-trigger') trigger = 99;
    if (kind === 'foreign-repo') f.event.repository.full_name = 'foreign/paperclip';
    if (kind === 'extra-source-input') f.event.inputs.targetSha = 'b'.repeat(40);
    if (kind === 'missing-jobrun') delete f.event.inputs.ALLURE_JOB_RUN_ID;
    assert.throws(() => admitDispatch(f.env, f.event, trigger));
  });
}

for (const kind of ['foreign-case', 'duplicate', 'wrong-fullname', 'foreign-source', 'wrong-run', 'wrong-jobrun', 'duplicate-case-id']) {
  test(`refuses evidence authority for ${kind}`, () => {
    const f = fixture();
    if (kind === 'foreign-case') f.selection.cases[0].executionId = 'chat-features.runner-opencode.local.tasks.delete';
    if (kind === 'duplicate') f.selection.cases.push(f.selection.cases[0]);
    if (kind === 'wrong-fullname') f.selection.cases[0].fullName = cases[1].fullName;
    if (kind === 'foreign-source') f.selection.targetSha = 'b'.repeat(40);
    if (kind === 'wrong-run') f.selection.runId = '456';
    if (kind === 'wrong-jobrun') f.selection.allureJobRunId = '78';
    if (kind === 'duplicate-case-id') f.selection.cases[1].caseId = f.selection.cases[0].caseId;
    assert.throws(() => evidencePolicy(f.selection, f.context, '77'));
  });
}

test('bootstrap and the fenced plan launcher cannot carry a TestOps execution identity', () => {
  const f = fixture(); f.event.inputs = { operation: 'bootstrap' };
  assert.equal(admitDispatch(f.env, f.event, 42).operation, 'bootstrap');
  f.event.inputs.operation = 'launch-plan'; assert.equal(admitDispatch(f.env, f.event, 42).operation, 'launch-plan');
  f.event.inputs.ALLURE_JOB_RUN_ID = '77'; assert.throws(() => admitDispatch(f.env, f.event, 42));
});

for (const value of ['00077', '9007199254740992', '12345678901234567']) {
  test(`dispatch rejects unsafe job identity ${value}`, () => {
    const f = fixture(); f.event.inputs.ALLURE_JOB_RUN_ID = value; assert.throws(() => admitDispatch(f.env, f.event, 42));
  });
}
test('dispatch preserves the maximum safe TestOps job identity', () => {
  const f = fixture(); f.event.inputs.ALLURE_JOB_RUN_ID = '9007199254740991';
  assert.equal(admitDispatch(f.env, f.event, 42).operation, 'evaluate');
});

test('the executable guard binds the actual original GitHub run before service or provider access', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'testops-context-')));
  try {
    const f = fixture(), eventPath = path.join(root, 'event.json'); await writeFile(eventPath, JSON.stringify(f.event));
    const env = { ...f.env, GITHUB_EVENT_PATH: eventPath, GH_TOKEN: 'synthetic-gh-token', GITHUB_RUN_NUMBER: '5' };
    const run = { id: 123, run_attempt: 1, run_number: 5, workflow_id: 99, head_sha: env.GITHUB_SHA, head_branch: 'master',
      event: 'workflow_dispatch', path: '.github/workflows/chat-completion-testops.yml', repository: { full_name: 'paperclipai/paperclip', private: false },
      actor: { id: 42 }, triggering_actor: { id: 42 } };
    let calls = 0;
    const exec = async (program, args) => {
      calls++; assert.equal(program, 'gh'); assert.deepEqual(args, ['api', 'repos/paperclipai/paperclip/actions/runs/123']);
      return { stdout: JSON.stringify(run) };
    };
    assert.equal((await actualContext(env, exec)).workflowId, 99); assert.equal(calls, 1);
    for (const field of ['head_sha', 'path', 'head_branch', 'run_attempt', 'run_number', 'workflow_id']) {
      const other = { ...run, [field]: typeof run[field] === 'number' ? run[field] + 1 : 'wrong' };
      if (field === 'workflow_id') other[field] = 0;
      await assert.rejects(actualContext(env, async () => ({ stdout: JSON.stringify(other) })));
    }
    await assert.rejects(actualContext({ ...env, GITHUB_RUN_ID: '../other' }, () => assert.fail('no request before numeric admission')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the real workflow separates metadata authority, provider execution and result reporting', async () => {
  const text = await readFile(new URL('../../.github/workflows/chat-completion-testops.yml', import.meta.url), 'utf8');
  const w = parse(text);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(), ['ALLURE_JOB_RUN_ID', 'ALLURE_USERNAME', 'operation']);
  assert.equal(w.concurrency['cancel-in-progress'], false);
  assert.equal(w.jobs.chat.strategy['max-parallel'], 1); assert.equal(w.jobs.chat.strategy['fail-fast'], false);
  assert.equal(w.jobs.select.environment, 'runner-e2e-testops-reporting');
  assert.equal(w.jobs.chat.environment, 'runner-e2e-private-paid');
  assert.equal(w.jobs.report.environment, 'runner-e2e-private-history');
  assert.equal(w.jobs.upload.environment, 'runner-e2e-testops-reporting');
  for (const [name, job] of Object.entries(w.jobs)) {
    assert.ok(job.steps.slice(0, 3).some(step => step.run?.endsWith('chat-completion-testops-cli.mjs guard')), name);
    if (name !== 'chat') assert.ok(!JSON.stringify(job).includes('secrets.OPENROUTER_API_KEY'), name);
    if (!['select', 'upload'].includes(name)) assert.ok(!JSON.stringify(job).includes('secrets.ALLURE_TOKEN'), name);
  }
  assert.ok(w.jobs.upload.if.includes("needs.report.result == 'success'"));
  assert.ok(w.jobs.report.needs.includes('build'));
  assert.ok(w.jobs.report.if.includes("needs.build.result == 'success'"));
  assert.ok(w.jobs.report.if.includes("needs.chat.result == 'failure'"));
  assert.ok(!text.includes('<<:')); assert.ok(!text.includes('target_branch:'));
  assert.equal(w.jobs.build.steps.find(step => step.name?.startsWith('Resolve the fixed')).run.includes('--ignore-scripts'), true);
  const paid = w.jobs.chat.steps.find(step => step.env?.OPENROUTER_API_KEY);
  assert.equal(paid.env.PAPERCLIP_CHAT_COMPLETION_TESTOPS, 'v1');
  assert.equal(paid.env.ALLURE_JOB_RUN_ID, '${{ inputs.ALLURE_JOB_RUN_ID }}');
  assert.ok(paid.run.includes('--max-automatic-retries 0'));
  assert.ok(w.jobs.build.steps.some(step => step.run?.includes('chat-completion-testops-host-control.mjs')));
  assert.ok(w.jobs.chat.steps.indexOf(paid) > w.jobs.chat.steps.findIndex(step => step.name?.startsWith('Verify source-bound')));
});

test('target checkout cannot populate or overwrite the trusted helper path', async () => {
  const definition = parse(await readFile(new URL('../../.github/workflows/chat-completion-testops.yml', import.meta.url), 'utf8'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'testops-checkout-boundary-')));
  try {
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
    git('init'); await writeFile(path.join(root, 'fixture.txt'), 'normal target'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'normal target');
    for (const job of [definition.jobs.build, definition.jobs.chat]) {
      const target = job.steps.findIndex(step => step.with?.ref === '${{ needs.authorize.outputs.target_sha }}');
      const boundary = job.steps.findIndex(step => step.id === 'target_boundary');
      const trusted = job.steps.findIndex(step => step.with?.path === '.testops-trusted');
      assert.ok(target >= 0 && boundary > target && trusted > boundary, 'Reject reserved target paths, then check out trusted main last');
      assert.notEqual(job.steps[target].with.clean, false);
      execFileSync('bash', ['-euo', 'pipefail', '-c', job.steps[boundary].run], { cwd: root, stdio: 'pipe' });
    }
    await mkdir(path.join(root, '.testops-trusted'));
    await writeFile(path.join(root, '.testops-trusted', 'helper.js'), 'candidate-controlled helper'); git('add', '.testops-trusted');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'reserved path in target');
    for (const job of [definition.jobs.build, definition.jobs.chat]) {
      const guard = job.steps.find(step => step.id === 'target_boundary');
      assert.throws(() => execFileSync('bash', ['-euo', 'pipefail', '-c', guard.run], { cwd: root, stdio: 'pipe' }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
