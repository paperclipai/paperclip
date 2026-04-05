import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, createHermesExecutionPlan, buildExecutionEnv } from '../src/server/execute.js';
import { __setTestRunChildProcess, __resetTestRunChildProcess } from '../src/server/runtime.js';

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
  const plan = await createHermesExecutionPlan(baseCtx);
  try {
    assert.equal(plan.command, 'hermes');
    assert.ok(plan.args.includes('--resume'));
    assert.ok(plan.args.includes('resume-1'));
    assert.equal(plan.provider, 'copilot');
    assert.equal(plan.env.PAPERCLIP_API_KEY, 'pcp-token');
    assert.equal(plan.env.PAPERCLIP_TASK_ID, 'ISS-1');
    assert.equal(plan.env.TERMINAL_CWD, baseCtx.cwd);
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
