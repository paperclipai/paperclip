import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, createHermesExecutionPlan, buildExecutionEnv } from '../src/server/execute.js';
import { __setTestRunChildProcess, __resetTestRunChildProcess } from '../src/server/runtime.js';
import { DEFAULT_NONINTERACTIVE_TOOLSETS } from '../src/shared/constants.js';

async function createBaseCtx() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-hermes-execute-'));
  return {
    runId: 'run-1',
    agent: { id: 'agent-1', companyId: 'company-1', name: 'CEO Hermes' },
    runtime: { sessionParams: { sessionId: 'resume-1', cwd } },
    config: { cwd, model: 'gpt-5.4', provider: 'copilot' },
    context: { taskId: 'ISS-1', wakeReason: 'work it', paperclipWorkspace: { cwd } },
    authToken: 'pcp-token',
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    cwd,
  };
}

test('createHermesExecutionPlan includes resume and auth-aware env', async () => {
  const baseCtx = await createBaseCtx();
  baseCtx.context = {
    ...baseCtx.context,
    childIssueId: 'ISS-2',
    childIssueIdentifier: 'HER-2',
    childIssueTitle: 'Worker follow-up',
    childIssueStatus: 'done',
  };
  const plan = await createHermesExecutionPlan(baseCtx);
  try {
    assert.equal(plan.command, 'hermes');
    assert.ok(plan.args.includes('--resume'));
    assert.ok(plan.args.includes('resume-1'));
    assert.equal(plan.provider, 'copilot');
    assert.equal(plan.env.PAPERCLIP_API_KEY, 'pcp-token');
    assert.equal(plan.env.PAPERCLIP_AGENT_ID, 'agent-1');
    assert.equal(plan.env.PAPERCLIP_COMPANY_ID, 'company-1');
    assert.equal(plan.env.PAPERCLIP_API_URL, 'http://127.0.0.1:3100/api');
    assert.equal(plan.env.PAPERCLIP_TASK_ID, 'ISS-1');
    assert.equal(plan.env.PAPERCLIP_CHILD_ISSUE_ID, 'ISS-2');
    assert.equal(plan.env.PAPERCLIP_CHILD_ISSUE_IDENTIFIER, 'HER-2');
    assert.equal(plan.env.PAPERCLIP_CHILD_ISSUE_TITLE, 'Worker follow-up');
    assert.equal(plan.env.PAPERCLIP_CHILD_ISSUE_STATUS, 'done');
    assert.equal(plan.env.TERMINAL_CWD, baseCtx.cwd);
    assert.equal(plan.env.HERMES_EXEC_ASK, '1');
    assert.ok(plan.args.includes('-t'));
    assert.ok(plan.args.includes(DEFAULT_NONINTERACTIVE_TOOLSETS));
    assert.ok(!DEFAULT_NONINTERACTIVE_TOOLSETS.split(',').includes('clarify'));
  } finally {
    await fs.rm(baseCtx.cwd, { recursive: true, force: true });
  }
});

test('execute retries once when Hermes reports an unknown session', async () => {
  const baseCtx = await createBaseCtx();
  let calls = 0;
  __setTestRunChildProcess(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Unknown session: resume-1',
      };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'Worked.\n\nsession_id: fresh-1',
      stderr: '',
    };
  });

  try {
    const result = await execute(baseCtx);
    assert.equal(calls, 2);
    assert.equal(result.sessionId, 'fresh-1');
    assert.equal(result.summary, 'Worked.');
  } finally {
    __resetTestRunChildProcess();
    await fs.rm(baseCtx.cwd, { recursive: true, force: true });
  }
});

test('createHermesExecutionPlan honors config.env.HERMES_HOME and avoids unsupported provider flags', async () => {
  const baseCtx = await createBaseCtx();
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-hermes-home-'));
  await fs.writeFile(
    path.join(hermesHome, 'config.yaml'),
    [
      'model:',
      '  default: Nemotron-Cascade-2-30B-A3B',
      '  provider: custom',
      '  base_url: http://pgx.home:4000/v1',
      '  api_key: sk-local-no-key-required',
      '  api_mode: chat_completions',
      '',
    ].join('\n'),
    'utf8',
  );

  baseCtx.config = {
    cwd: baseCtx.cwd,
    model: 'Nemotron-Cascade-2-30B-A3B',
    env: {
      HERMES_HOME: hermesHome,
      OPENAI_BASE_URL: 'http://pgx.home:4000/v1',
      OPENAI_API_KEY: 'sk-local-no-key-required',
    },
  };

  try {
    const plan = await createHermesExecutionPlan(baseCtx);
    assert.equal(plan.model, 'Nemotron-Cascade-2-30B-A3B');
    assert.equal(plan.provider, 'custom');
    assert.equal(plan.env.HERMES_HOME, hermesHome);
    assert.equal(plan.env.HERMES_INFERENCE_PROVIDER, 'custom');
    assert.ok(!plan.args.includes('--provider'));
  } finally {
    await fs.rm(hermesHome, { recursive: true, force: true });
    await fs.rm(baseCtx.cwd, { recursive: true, force: true });
  }
});

test('buildExecutionEnv ignores placeholder Paperclip context ids', async () => {
  const baseCtx = await createBaseCtx();
  try {
    const env = buildExecutionEnv(
      baseCtx,
      baseCtx.config,
      baseCtx.cwd,
      {
        taskId: 'None',
        issueId: 'undefined',
        wakeReason: 'null',
        approvalId: 'apr-1',
      },
      null,
    );

    assert.equal(env.PAPERCLIP_TASK_ID, undefined);
    assert.equal(env.PAPERCLIP_WAKE_REASON, undefined);
    assert.equal(env.PAPERCLIP_APPROVAL_ID, 'apr-1');
  } finally {
    await fs.rm(baseCtx.cwd, { recursive: true, force: true });
  }
});

test('buildExecutionEnv exports approval payload summary vars for approval wakes', async () => {
  const baseCtx = await createBaseCtx();
  try {
    const env = buildExecutionEnv(
      baseCtx,
      baseCtx.config,
      baseCtx.cwd,
      {
        approvalId: 'apr-9',
        approvalStatus: 'approved',
        approvalType: 'hire_agent',
        approvalPayloadName: 'HermesWorker',
        approvalPayloadRole: 'engineer',
        approvalPayloadAgentId: '11111111-1111-4111-8111-111111111111',
        approvalPayloadReportsTo: '22222222-2222-4222-8222-222222222222',
        approvalPayloadAdapterType: 'hermes_local',
        approvalPayloadDesiredSkills: ['company:verification-before-completion', 'paperclip:paperclip'],
      },
      null,
    );

    assert.equal(env.PAPERCLIP_APPROVAL_ID, 'apr-9');
    assert.equal(env.PAPERCLIP_APPROVAL_STATUS, 'approved');
    assert.equal(env.PAPERCLIP_APPROVAL_TYPE, 'hire_agent');
    assert.equal(env.PAPERCLIP_APPROVAL_PAYLOAD_NAME, 'HermesWorker');
    assert.equal(env.PAPERCLIP_APPROVAL_PAYLOAD_ROLE, 'engineer');
    assert.equal(env.PAPERCLIP_APPROVAL_PAYLOAD_AGENT_ID, '11111111-1111-4111-8111-111111111111');
    assert.equal(env.PAPERCLIP_APPROVAL_PAYLOAD_REPORTS_TO, '22222222-2222-4222-8222-222222222222');
    assert.equal(env.PAPERCLIP_APPROVAL_PAYLOAD_ADAPTER_TYPE, 'hermes_local');
    assert.equal(
      env.PAPERCLIP_APPROVAL_PAYLOAD_DESIRED_SKILLS,
      'company:verification-before-completion,paperclip:paperclip',
    );
  } finally {
    await fs.rm(baseCtx.cwd, { recursive: true, force: true });
  }
});
