import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from '@paperclipai/adapter-utils/server-utils';

const runChildProcess = vi.hoisted(() => vi.fn());
const resolveDevinModelUid = vi.hoisted(() => vi.fn());
const resolveRunUsageAndCost = vi.hoisted(() => vi.fn());

vi.mock('@paperclipai/adapter-utils/server-utils', async () => {
  const actual = await vi.importActual<typeof import('@paperclipai/adapter-utils/server-utils')>(
    '@paperclipai/adapter-utils/server-utils',
  );
  return { ...actual, runChildProcess };
});

vi.mock('./models.js', async () => {
  const actual = await vi.importActual<typeof import('./models.js')>('./models.js');
  return { ...actual, resolveDevinModelUid };
});

vi.mock('./usage.js', async () => {
  const actual = await vi.importActual<typeof import('./usage.js')>('./usage.js');
  return { ...actual, resolveRunUsageAndCost };
});

import { buildDevinPrompt, execute } from './execute.js';

const basePromptOpts = () => ({
  instructionsPrefix: '',
  promptTemplate: DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  bootstrapPromptTemplate: '',
  templateData: {
    agentId: 'agent-1',
    companyId: 'company-1',
    runId: 'run-1',
    company: { id: 'company-1' },
    agent: { id: 'agent-1', name: 'Atlas', companyId: 'company-1' },
    run: { id: 'run-1', source: 'on_demand' },
    context: {},
  },
  wake: undefined as unknown,
  sessionHandoffMarkdown: '',
  env: {} as Record<string, string>,
  resumeSessionId: null as string | null,
});

describe('buildDevinPrompt', () => {
  it('starts with the default agent template', () => {
    const { prompt } = buildDevinPrompt(basePromptOpts());
    expect(prompt).toContain('You are agent');
    expect(prompt).toContain('Execution contract:');
  });

  it('includes the API access note when PAPERCLIP_API_URL + KEY are present', () => {
    const { prompt } = buildDevinPrompt({
      ...basePromptOpts(),
      env: {
        PAPERCLIP_API_URL: 'http://localhost:3100',
        PAPERCLIP_API_KEY: 'secret',
        PAPERCLIP_RUN_ID: 'run-1',
      },
    });
    expect(prompt).toContain('Paperclip API access note:');
    expect(prompt).toContain('curl');
    expect(prompt).toContain('/api/issues');
  });

  it('omits the API access note when the API url/key are absent', () => {
    const { prompt } = buildDevinPrompt(basePromptOpts());
    expect(prompt).not.toContain('Paperclip API access note:');
  });

  it('omits the default heartbeat prompt on resume-delta (resumed session + wake)', () => {
    const opts = {
      ...basePromptOpts(),
      resumeSessionId: 'session-abc',
      wake: {
        reason: 'comment',
        issue: { id: 'issue-1', identifier: 'ISS-1', title: 'Do the thing' },
        comments: [{ id: 'c1', body: 'please continue' }],
      },
    };
    const { prompt, promptMetrics } = buildDevinPrompt(opts);
    const wakePrompt = buildDevinPrompt({ ...opts, resumeSessionId: null });
    expect(wakePrompt.promptMetrics.wakePromptChars).toBeGreaterThan(0);
    expect(promptMetrics.heartbeatPromptChars).toBe(0);
    expect(prompt).not.toContain('You are agent');
  });

  it('includes the session handoff markdown and reports its metric', () => {
    const { prompt, promptMetrics } = buildDevinPrompt({
      ...basePromptOpts(),
      sessionHandoffMarkdown: 'HANDOFF-MARKER: previous run summary',
    });
    expect(prompt).toContain('HANDOFF-MARKER');
    expect(promptMetrics.sessionHandoffChars).toBeGreaterThan(0);
  });

  it('includes the PAPERCLIP_* env note even without API credentials', () => {
    const { prompt } = buildDevinPrompt({
      ...basePromptOpts(),
      env: { PAPERCLIP_RUN_ID: 'run-1' },
    });
    expect(prompt).toContain('environment variables are available in this run');
    expect(prompt).toContain('PAPERCLIP_RUN_ID');
    expect(prompt).not.toContain('Paperclip API access note:');
  });

  it('joins sections in order: instructions, bootstrap, wake, handoff, env note, API note, template', () => {
    const { prompt } = buildDevinPrompt({
      ...basePromptOpts(),
      instructionsPrefix: 'INSTRUCTIONS-MARKER\n\n',
      bootstrapPromptTemplate: 'BOOTSTRAP-MARKER for {{agent.name}}',
      wake: {
        reason: 'comment',
        issue: { id: 'issue-1', identifier: 'ISS-1', title: 'Do the thing' },
        comments: [{ id: 'c1', body: 'WAKE-MARKER please continue' }],
      },
      sessionHandoffMarkdown: 'HANDOFF-MARKER: previous run summary',
      env: {
        PAPERCLIP_API_URL: 'http://localhost:3100',
        PAPERCLIP_API_KEY: 'secret',
        PAPERCLIP_RUN_ID: 'run-1',
      },
    });
    const markers = [
      'INSTRUCTIONS-MARKER',
      'BOOTSTRAP-MARKER',
      'WAKE-MARKER',
      'HANDOFF-MARKER',
      'environment variables are available in this run',
      'Paperclip API access note:',
      'You are agent',
    ];
    const positions = markers.map((m) => prompt.indexOf(m));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('reports the instructions prefix in promptMetrics', () => {
    const { prompt, promptMetrics } = buildDevinPrompt({
      ...basePromptOpts(),
      instructionsPrefix: 'INSTRUCTIONS-MARKER\n\n',
    });
    expect(prompt.startsWith('INSTRUCTIONS-MARKER')).toBe(true);
    expect(promptMetrics.instructionsChars).toBe('INSTRUCTIONS-MARKER\n\n'.length);
  });
});

describe('execute', () => {
  let tmp = '';
  const logs: { stream: 'stdout' | 'stderr'; chunk: string }[] = [];
  let fakeHome = '';

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'devin-exec-test-'));
    fakeHome = path.join(tmp, 'home');
    mkdirSync(fakeHome);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('TMP', tmp);
    vi.stubEnv('TEMP', tmp);
    expect(homedir()).toBe(fakeHome);
    expect(tmpdir()).toBe(tmp);
    runChildProcess.mockReset();
    runChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'ok',
      stderr: '',
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    resolveDevinModelUid.mockReset();
    resolveDevinModelUid.mockResolvedValue('swe-1-7');
    resolveRunUsageAndCost.mockReset();
    resolveRunUsageAndCost.mockResolvedValue({
      sessionId: 'session-abc',
      usage: { inputTokens: 10, outputTokens: 5 },
      usageBasis: 'per_run' as const,
      costUsd: 0,
      billingType: 'subscription_included' as const,
      biller: 'devin',
      provider: 'devin',
      model: 'swe-1-7',
      resultJson: { devinSessionId: 'session-abc' },
    });
    logs.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Best-effort cleanup of temp files that may leak if a test fails.
    for (const prefix of ['devin-prompt-', 'devin-run-']) {
      try {
        const files = new Set<string>(['run-1', 'run-2', 'run-3']);
        for (const id of files) {
          rmSync(path.join(tmp, `${prefix}${id}.txt`), { force: true });
          rmSync(path.join(tmp, `${prefix}${id}.atif`), { force: true });
        }
      } catch {
        // ignore
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function baseCtx(overrides?: {
    config?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    context?: Record<string, unknown>;
  }): Record<string, unknown> {
    const config = overrides?.config ?? {};
    const runtime = overrides?.runtime ?? {};
    const ctx = overrides?.context ?? {};
    return {
      runId: 'run-1',
      agent: { id: 'agent-1', name: 'Atlas', companyId: 'company-1' },
      runtime: { sessionParams: null, ...runtime },
      config: {
        command: 'devin',
        cwd: tmp,
        model: 'swe-1.7',
        permissionMode: 'dangerous',
        respectWorkspaceTrust: false,
        ...config,
      },
      context: ctx,
      onLog: async (stream: 'stdout' | 'stderr', chunk: string) => {
        logs.push({ stream, chunk });
      },
    };
  }

  it('fails the run without spawning when the configured effort is unavailable for the model family', async () => {
    resolveDevinModelUid.mockRejectedValue(
      new Error('thinkingEffort "max" is not available for swe-1.7 (available: medium, high)'),
    );
    const result = await execute(baseCtx({ config: { thinkingEffort: 'max' } }) as never);
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('not available for swe-1.7');
    expect(logs.some((l) => l.stream === 'stderr' && l.chunk.includes('not available for swe-1.7'))).toBe(true);
  });

  it('spawns devin with --export, --prompt-file, and default flags', async () => {
    await execute(baseCtx() as never);
    const [runId, command, args, opts] = runChildProcess.mock.calls[0];
    expect(runId).toBe('run-1');
    expect(command).toBe('devin');
    expect(args).toContain('--respect-workspace-trust');
    expect(args).toContain('false');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dangerous');
    expect(args).toContain('--model');
    expect(args).toContain('swe-1-7');
    expect(args).toContain('--export');
    expect(args).toContain('--prompt-file');
    expect(args).toContain('-p');
    expect(opts.cwd).toBe(tmp);
    expect(opts.env.PAPERCLIP_RUN_ID).toBe('run-1');
  });

  it('resumes a stored session when cwd matches', async () => {
    const ctx = baseCtx({
      runtime: {
        sessionParams: { sessionId: 'prev-session', cwd: tmp },
      },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).toContain('-r');
    expect(args).toContain('prev-session');
  });

  it('does not resume when cwd differs', async () => {
    const ctx = baseCtx({
      runtime: {
        sessionParams: { sessionId: 'prev-session', cwd: '/elsewhere' },
      },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).not.toContain('prev-session');
  });

  it('resumes from context.resumeSessionParams when runtime.sessionParams is missing and cwd matches', async () => {
    const ctx = baseCtx({
      context: {
        resumeSessionParams: { sessionId: 'prev-session', cwd: tmp },
      },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).toContain('-r');
    expect(args).toContain('prev-session');
    const warnings = logs.filter((l) => l.stream === 'stderr');
    expect(warnings.some((l) => l.chunk.includes('runtime.sessionParams missing'))).toBe(true);
  });

  it('does not resume from context when cwd differs', async () => {
    const ctx = baseCtx({
      context: {
        resumeSessionParams: { sessionId: 'prev-session', cwd: '/elsewhere' },
      },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).not.toContain('prev-session');
  });

  it('prefers runtime.sessionParams over context.resumeSessionParams', async () => {
    const ctx = baseCtx({
      runtime: {
        sessionParams: { sessionId: 'runtime-session', cwd: tmp },
      },
      context: {
        resumeSessionParams: { sessionId: 'context-session', cwd: tmp },
      },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).toContain('runtime-session');
    expect(args).not.toContain('context-session');
  });

  it('delivers a non-cwd instructions entry in the prompt with a sibling directive', async () => {
    const bundleDir = path.join(tmp, `devin-bundle-${Date.now()}`);
    mkdirSync(bundleDir, { recursive: true });
    const entry = path.join(bundleDir, 'AGENTS.md');
    writeFileSync(entry, 'BUNDLE-MARKER: obey the bundle');
    let metaPrompt = '';
    try {
      const ctx = {
        ...baseCtx({ config: { instructionsFilePath: entry } }),
        onMeta: async (meta: { prompt: string }) => {
          metaPrompt = meta.prompt;
        },
      };
      await execute(ctx as never);
      expect(metaPrompt.startsWith('BUNDLE-MARKER: obey the bundle')).toBe(true);
      expect(metaPrompt).toContain(`loaded from ${entry}`);
      expect(metaPrompt).toContain('./HEARTBEAT.md');
      expect(metaPrompt).toContain(bundleDir);
      const warnings = logs.filter((l) => l.stream === 'stderr');
      expect(warnings.some((l) => l.chunk.includes('could not read instructions entry'))).toBe(false);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it('delivers the managed bundle root+entry when it does not resolve to <cwd>/AGENTS.md', async () => {
    const bundleDir = path.join(tmp, `devin-bundle-root-${Date.now()}`);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(path.join(bundleDir, 'AGENTS.md'), 'ROOT-BUNDLE-MARKER');
    let metaPrompt = '';
    try {
      const ctx = {
        ...baseCtx({
          config: { instructionsRootPath: bundleDir, instructionsEntryFile: 'AGENTS.md' },
        }),
        onMeta: async (meta: { prompt: string }) => {
          metaPrompt = meta.prompt;
        },
      };
      await execute(ctx as never);
      expect(metaPrompt).toContain('ROOT-BUNDLE-MARKER');
      expect(metaPrompt).toContain(`loaded from ${path.join(bundleDir, 'AGENTS.md')}`);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it('does not inject instructions when the entry is <cwd>/AGENTS.md (auto-load covers it)', async () => {
    let metaPrompt = '';
    const ctx = {
      ...baseCtx({ config: { instructionsFilePath: path.join(tmp, 'AGENTS.md') } }),
      onMeta: async (meta: { prompt: string }) => {
        metaPrompt = meta.prompt;
      },
    };
    await execute(ctx as never);
    expect(metaPrompt).not.toContain('loaded from');
    expect(metaPrompt).not.toContain('./HEARTBEAT.md');
    const warnings = logs.filter((l) => l.stream === 'stderr');
    expect(warnings.some((l) => l.chunk.includes('could not read instructions entry'))).toBe(false);
  });

  it('treats an absolute instructionsEntryFile as authoritative (root ignored)', async () => {
    let metaPrompt = '';
    const ctx = {
      ...baseCtx({
        config: {
          instructionsRootPath: '/some/other/root',
          instructionsEntryFile: path.join(tmp, 'AGENTS.md'),
        },
      }),
      onMeta: async (meta: { prompt: string }) => {
        metaPrompt = meta.prompt;
      },
    };
    await execute(ctx as never);
    expect(metaPrompt).not.toContain('loaded from');
  });

  it('fails fast without spawning when a configured instructions entry cannot be read', async () => {
    const ctx = baseCtx({
      config: { instructionsRootPath: tmp, instructionsEntryFile: 'missing/INSTRUCTIONS.md' },
    });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('could not read configured instructions entry');
    expect(runChildProcess).not.toHaveBeenCalled();
    const warnings = logs.filter((l) => l.stream === 'stderr');
    expect(warnings.some((l) => l.chunk.includes('could not read configured instructions entry'))).toBe(true);
  });

  it('omits --permission-mode when unset so the CLI applies its own default', async () => {
    const ctx = baseCtx({ config: { permissionMode: undefined } });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).not.toContain('--permission-mode');
  });

  it('passes an unrecognized permission mode through unchanged for the CLI to validate', async () => {
    await execute(baseCtx({ config: { permissionMode: 'smart' } }) as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('smart');
    expect(args).not.toContain('dangerous');
  });

  it('passes autonomous through without sandbox and lets the CLI reject it', async () => {
    await execute(baseCtx({ config: { permissionMode: 'autonomous', sandbox: false } }) as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('autonomous');
    expect(args).not.toContain('--sandbox');
  });

  it('always passes --sandbox when configured and logs the permission-mode coercion', async () => {
    await execute(baseCtx({ config: { sandbox: true, permissionMode: 'dangerous' } }) as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dangerous');
    expect(
      logs.some(
        (l) => l.stream === 'stderr' && l.chunk.includes('--sandbox always uses the autonomous permission mode'),
      ),
    ).toBe(true);
  });

  it('does not log the sandbox coercion note for autonomous or unset modes', async () => {
    await execute(baseCtx({ config: { sandbox: true, permissionMode: 'autonomous' } }) as never);
    expect(
      logs.some((l) => l.chunk.includes('--sandbox always uses the autonomous permission mode')),
    ).toBe(false);
  });

  it('forwards onSpawn to the child process runner', async () => {
    const onSpawn = vi.fn();
    const ctx = { ...baseCtx(), onSpawn };
    await execute(ctx as never);
    const [, , , opts] = runChildProcess.mock.calls[0];
    expect(typeof opts.onSpawn).toBe('function');
    await opts.onSpawn({ pid: 123, processGroupId: null, startedAt: new Date().toISOString() });
    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 123 }),
    );
  });

  it('reports adapter_startup progress before spawning', async () => {
    const onRuntimeProgress = vi.fn();
    const ctx = { ...baseCtx(), onRuntimeProgress };
    await execute(ctx as never);
    expect(onRuntimeProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'adapter_startup' }),
    );
  });

  it('passes the stored usage baseline when resuming so cost is a delta', async () => {
    const ctx = baseCtx({
      runtime: {
        sessionParams: {
          sessionId: 'prev-session',
          cwd: tmp,
          resumeBaseline: {
            totalSteps: 7,
            totalPromptTokens: 1000,
            totalCompletionTokens: 200,
            totalCachedTokens: 800,
          },
        },
      },
    });
    await execute(ctx as never);
    expect(resolveRunUsageAndCost).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeBaseline: {
          totalSteps: 7,
          totalPromptTokens: 1000,
          totalCompletionTokens: 200,
          totalCachedTokens: 800,
        },
      }),
    );
  });

  it('does not pass the baseline after a failed resume falls over to a fresh session', async () => {
    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: "Error: No session found matching 'gone'",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'ok',
        stderr: '',
        pid: 2,
        startedAt: new Date().toISOString(),
      });
    const ctx = baseCtx({
      runtime: {
        sessionParams: {
          sessionId: 'gone',
          cwd: tmp,
          resumeBaseline: {
            totalSteps: 7,
            totalPromptTokens: 1000,
            totalCompletionTokens: 200,
            totalCachedTokens: 800,
          },
        },
      },
    });
    await execute(ctx as never);
    expect(resolveRunUsageAndCost).toHaveBeenCalledWith(
      expect.objectContaining({ resumeBaseline: null }),
    );
  });

  it('persists the cumulative totals from this run as the next baseline', async () => {
    resolveRunUsageAndCost.mockResolvedValue({
      sessionId: 'session-abc',
      usage: { inputTokens: 10, outputTokens: 5 },
      usageBasis: 'per_run' as const,
      costUsd: 0,
      billingType: 'subscription_included' as const,
      biller: 'devin',
      provider: 'devin',
      model: 'swe-1-7',
      resultJson: {
        devinCumulative: {
          totalSteps: 12,
          totalPromptTokens: 3456,
          totalCompletionTokens: 222,
          totalCachedTokens: 999,
        },
      },
    });
    const result = await execute(baseCtx() as never);
    expect(result.sessionParams).toEqual({
      sessionId: 'session-abc',
      cwd: tmp,
      resumeBaseline: {
        totalSteps: 12,
        totalPromptTokens: 3456,
        totalCompletionTokens: 222,
        totalCachedTokens: 999,
      },
    });
  });

  it('persists the replacement session after an unknown-session retry (no false clearSession)', async () => {
    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: "Error: No session found matching 'gone-session'",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'ok',
        stderr: '',
        pid: 2,
        startedAt: new Date().toISOString(),
      });
    const ctx = baseCtx({
      runtime: { sessionParams: { sessionId: 'gone-session', cwd: tmp } },
    });
    const result = await execute(ctx as never);
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(runChildProcess.mock.calls[1][2]).not.toContain('gone-session');
    // The platform must keep the replacement session, not clear it.
    expect(result.clearSession).toBe(false);
    expect(result.sessionParams).toEqual({ sessionId: 'session-abc', cwd: tmp });
  });

  it('keeps timeoutSec 0 unbounded across an unknown-session retry', async () => {
    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: "Error: No session found matching 'gone-session'",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'ok',
        stderr: '',
        pid: 2,
        startedAt: new Date().toISOString(),
      });
    const ctx = baseCtx({
      config: { timeoutSec: 0 },
      runtime: { sessionParams: { sessionId: 'gone-session', cwd: tmp } },
    });
    await execute(ctx as never);
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(runChildProcess.mock.calls[0][3].timeoutSec).toBe(0);
    expect(runChildProcess.mock.calls[1][3].timeoutSec).toBe(0);
    expect(runChildProcess.mock.calls[1][2]).not.toContain('-r');
    expect(runChildProcess.mock.calls[1][2]).not.toContain('gone-session');
  });

  it('clears session only when the retry produced no usable session id', async () => {
    runChildProcess.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: "Error: No session found matching 'gone-session'",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    resolveRunUsageAndCost.mockResolvedValue({
      sessionId: null,
      usage: undefined,
      usageBasis: 'per_run' as const,
      costUsd: null,
      billingType: 'unknown' as const,
      biller: 'devin',
      provider: 'devin',
      model: null,
      resultJson: {},
    });
    const ctx = baseCtx({
      runtime: { sessionParams: { sessionId: 'gone-session', cwd: tmp } },
    });
    const result = await execute(ctx as never);
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeNull();
  });

  it('suffixes a configured exportPath with the run id (no cross-run ATIF overwrites)', async () => {
    const ctx = baseCtx({ config: { exportPath: '/tmp/shared-export.atif' } });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).toContain('/tmp/shared-export-run-1.atif');
    expect(args).not.toContain('/tmp/shared-export.atif');
  });

  it('accepts extraArgs stored as a string and places them before --prompt-file', async () => {
    const ctx = baseCtx({ config: { extraArgs: '--verbose, --foo bar' } });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    for (const a of ['--verbose', '--foo', 'bar']) expect(args).toContain(a);
    expect(args.indexOf('--verbose')).toBeLessThan(args.indexOf('--prompt-file'));
  });

  it('never exposes the auth token value in the prompt, and redacts it in meta env', async () => {
    let metaEnv: Record<string, string> = {};
    const ctx = {
      ...baseCtx(),
      authToken: 'secret-run-token-value',
      onMeta: async (meta: { env: Record<string, string>; prompt: string }) => {
        metaEnv = meta.env;
        expect(meta.prompt).not.toContain('secret-run-token-value');
      },
    };
    await execute(ctx as never);
    const [, , , opts] = runChildProcess.mock.calls[0];
    // The child receives the token through env (the platform's standard
    // local-agent mechanism)...
    expect(opts.env.PAPERCLIP_API_KEY).toBe('secret-run-token-value');
    // ...but nothing LLM-visible (prompt, meta payload) carries the value.
    expect(metaEnv.PAPERCLIP_API_KEY ?? '').not.toContain('secret-run-token-value');
  });

  it('strips an inherited ACP_BACKEND from the child env', async () => {
    process.env.ACP_BACKEND = 'windsurf';
    try {
      await execute(baseCtx() as never);
      const [, , , opts] = runChildProcess.mock.calls[0];
      expect(opts.env.ACP_BACKEND).toBeUndefined();
      expect(opts.env.PAPERCLIP_RUN_ID).toBe('run-1');
    } finally {
      delete process.env.ACP_BACKEND;
    }
  });

  it('deletes the prompt and temp ATIF files even when the run throws mid-flight', async () => {
    runChildProcess.mockRejectedValue(new Error('spawn exploded'));
    const promptFile = path.join(tmp, 'devin-prompt-run-1.txt');
    const atifFile = path.join(tmp, 'devin-run-run-1.atif');
    await expect(execute(baseCtx() as never)).rejects.toThrow('spawn exploded');
    expect(lstatSync(promptFile, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(atifFile, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('returns session params and usage from the usage resolver', async () => {
    const result = await execute(baseCtx() as never);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ sessionId: 'session-abc', cwd: tmp });
    expect(result.sessionDisplayId).toBe('session-abc');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.provider).toBe('devin');
  });

  it('links desired skills into <cwd>/.devin/skills before spawn and logs one line', async () => {
    const cwd = path.join(tmp, `devin-run-skills-${Date.now()}`);
    const reviewSource = path.join(cwd, 'runtime-skills', 'review');
    mkdirSync(reviewSource, { recursive: true });
    writeFileSync(path.join(reviewSource, 'SKILL.md'), '---\nname: review\n---\n');
    try {
      await execute(
        baseCtx({
          config: {
            cwd,
            paperclipRuntimeSkills: [
              { key: 'company/review', runtimeName: 'review', source: reviewSource },
            ],
            paperclipSkillSync: { desiredSkills: ['company/review'] },
          },
        }) as never,
      );
      const target = path.join(cwd, '.devin', 'skills', 'review');
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBe(reviewSource);
      expect(
        logs.some(
          (l) =>
            l.stream === 'stdout' &&
            l.chunk.includes('[paperclip] Synced 1 Devin skill(s) into') &&
            l.chunk.includes(path.join(cwd, '.devin', 'skills')),
        ),
      ).toBe(true);
      expect(runChildProcess).toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('mounts only the operational skill when nothing is configured (legacy local rule)', async () => {
    const cwd = path.join(tmp, `devin-run-skills-empty-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      await execute(baseCtx({ config: { cwd } }) as never);
      const home = path.join(cwd, '.devin', 'skills');
      const stat = lstatSync(home, { throwIfNoEntry: false });
      if (stat) {
        // Legacy local adapters always mount the operational control-plane
        // skill when available; nothing else may be linked.
        expect(readdirSync(home)).toEqual(['paperclip']);
        expect(logs.some((l) => l.chunk.includes('Synced 1 Devin skill(s)'))).toBe(true);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('executes in the resolved project workspace instead of a different configured cwd', async () => {
    const projectDir = path.join(tmp, `devin-ws-project-${Date.now()}`);
    const configuredDir = path.join(tmp, `devin-ws-configured-${Date.now()}`);
    const reviewSource = path.join(projectDir, 'runtime-skills', 'review');
    mkdirSync(reviewSource, { recursive: true });
    mkdirSync(configuredDir, { recursive: true });
    writeFileSync(path.join(reviewSource, 'SKILL.md'), '---\nname: review\n---\n');
    try {
      const result = await execute(
        baseCtx({
          config: {
            cwd: configuredDir,
            paperclipRuntimeSkills: [
              { key: 'company/review', runtimeName: 'review', source: reviewSource },
            ],
            paperclipSkillSync: { desiredSkills: ['company/review'] },
          },
          context: {
            paperclipWorkspace: { cwd: projectDir, source: 'project_primary' },
          },
        }) as never,
      );
      const [, , , opts] = runChildProcess.mock.calls[0];
      expect(opts.cwd).toBe(projectDir);
      expect(result.sessionParams).toMatchObject({ cwd: projectDir });
      const link = path.join(projectDir, '.devin', 'skills', 'review');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(
        lstatSync(path.join(configuredDir, '.devin'), { throwIfNoEntry: false }),
      ).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(configuredDir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit configured cwd when the resolved workspace is the agent home', async () => {
    const configuredDir = path.join(tmp, `devin-ws-kept-${Date.now()}`);
    const agentHomeDir = path.join(tmp, `devin-ws-home-${Date.now()}`);
    mkdirSync(configuredDir, { recursive: true });
    mkdirSync(agentHomeDir, { recursive: true });
    try {
      const result = await execute(
        baseCtx({
          config: { cwd: configuredDir },
          context: {
            paperclipWorkspace: { cwd: agentHomeDir, source: 'agent_home' },
          },
        }) as never,
      );
      const [, , , opts] = runChildProcess.mock.calls[0];
      expect(opts.cwd).toBe(configuredDir);
      expect(result.sessionParams).toMatchObject({ cwd: configuredDir });
    } finally {
      rmSync(configuredDir, { recursive: true, force: true });
      rmSync(agentHomeDir, { recursive: true, force: true });
    }
  });

  it('executes in the supplied workspace when no cwd is configured', async () => {
    const workspaceDir = path.join(tmp, `devin-ws-only-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    try {
      const result = await execute(
        baseCtx({
          config: { cwd: '' },
          context: {
            paperclipWorkspace: { cwd: workspaceDir, source: 'agent_home' },
          },
        }) as never,
      );
      const [, , , opts] = runChildProcess.mock.calls[0];
      expect(opts.cwd).toBe(workspaceDir);
      expect(result.sessionParams).toMatchObject({ cwd: workspaceDir });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rejects before spawning when neither a configured cwd nor a resolved workspace exists', async () => {
    await expect(
      execute(baseCtx({ config: { cwd: '' } }) as never),
    ).rejects.toThrow('resolved Paperclip workspace');
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it('does not resume a stored session that has no recorded cwd', async () => {
    const ctx = baseCtx({
      runtime: { sessionParams: { sessionId: 'prev-session' } },
    });
    await execute(ctx as never);
    const [, , args] = runChildProcess.mock.calls[0];
    expect(args).not.toContain('prev-session');
  });

  it('does not write skills when the configured instructions entry cannot be read', async () => {
    const cwd = path.join(tmp, `devin-skills-gated-${Date.now()}`);
    const reviewSource = path.join(cwd, 'runtime-skills', 'review');
    mkdirSync(reviewSource, { recursive: true });
    writeFileSync(path.join(reviewSource, 'SKILL.md'), '---\nname: review\n---\n');
    try {
      const result = await execute(
        baseCtx({
          config: {
            cwd,
            instructionsRootPath: tmp,
            instructionsEntryFile: 'missing/INSTRUCTIONS.md',
            paperclipRuntimeSkills: [
              { key: 'company/review', runtimeName: 'review', source: reviewSource },
            ],
            paperclipSkillSync: { desiredSkills: ['company/review'] },
          },
        }) as never,
      );
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain('could not read configured instructions entry');
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(
        lstatSync(path.join(cwd, '.devin'), { throwIfNoEntry: false }),
      ).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('treats a relative instructionsFilePath of AGENTS.md as auto-loaded from the effective cwd', async () => {
    const cwd = path.join(tmp, `devin-rel-agents-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'CWD-AGENTS-MARKER');
    let metaPrompt = '';
    try {
      const ctx = {
        ...baseCtx({ config: { cwd, instructionsFilePath: 'AGENTS.md' } }),
        onMeta: async (meta: { prompt: string }) => {
          metaPrompt = meta.prompt;
        },
      };
      await execute(ctx as never);
      expect(metaPrompt).not.toContain('loaded from');
      expect(metaPrompt).not.toContain('CWD-AGENTS-MARKER');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('resolves a relative instructionsFilePath against the effective cwd, not the process cwd', async () => {
    const cwd = path.join(tmp, `devin-rel-custom-${Date.now()}`);
    const instructionsDir = path.join(cwd, 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    const entry = path.join(instructionsDir, 'custom.md');
    writeFileSync(entry, 'CUSTOM-MARKER: obey the relative file');
    let metaPrompt = '';
    let exitCode: number | null = null;
    try {
      const ctx = {
        ...baseCtx({ config: { cwd, instructionsFilePath: 'instructions/custom.md' } }),
        onMeta: async (meta: { prompt: string }) => {
          metaPrompt = meta.prompt;
        },
      };
      exitCode = (await execute(ctx as never)).exitCode;
      expect(exitCode).toBe(0);
      expect(metaPrompt).toContain('CUSTOM-MARKER');
      expect(metaPrompt).toContain(`loaded from ${entry}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('forwards an explicit timeoutSec 0 as unbounded', async () => {
    await execute(baseCtx({ config: { timeoutSec: 0 } }) as never);
    const [, , , opts] = runChildProcess.mock.calls[0];
    expect(opts.timeoutSec).toBe(0);
  });

  it('still clamps a negative timeoutSec to 1', async () => {
    await execute(baseCtx({ config: { timeoutSec: -5 } }) as never);
    const [, , , opts] = runChildProcess.mock.calls[0];
    expect(opts.timeoutSec).toBe(1);
  });

  it('defaults timeoutSec to 1800 when unset', async () => {
    await execute(baseCtx() as never);
    const [, , , opts] = runChildProcess.mock.calls[0];
    expect(opts.timeoutSec).toBe(1800);
  });

  it.each([undefined, { totalSteps: -1, totalPromptTokens: 100, totalCompletionTokens: 50, totalCachedTokens: 10 }])('preserves unavailable resume-counter provenance for usage accounting: %j', async (resumeBaseline) => {
    await execute(baseCtx({ runtime: { sessionParams: { sessionId: 'prev-session', cwd: tmp, resumeBaseline } } }) as never);
    expect(resolveRunUsageAndCost).toHaveBeenCalledWith(expect.objectContaining({ resumeBaseline: resumeBaseline ?? {} }));
  });
});

describe('execute fusion model selection', () => {
  const fusionLogs: { stream: 'stdout' | 'stderr'; chunk: string }[] = [];
  let scratch = '';
  let fakeHome = '';
  const FUSION_PAIR = 'fusion-alpha-1-high-sidekick-beta-2-medium';
  const fusionFixture = [
    {
      family_label: 'SWE-1.7',
      family_uid: 'swe-1.7',
      slug: 'swe-1-7',
      aliases: [],
      variants: [{
        model_uid: 'swe-1-7',
        label: 'SWE-1.7 Max',
        max_context_tokens: 200_000,
        max_output_tokens: 8_192,
        cost_tier: 'Free',
        cost_summary: null,
        is_new: false,
        is_beta: true,
      }],
    },
    {
      family_label: 'Fusion',
      family_uid: 'fusion',
      slug: 'fusion',
      aliases: [],
      variants: [{
        model_uid: FUSION_PAIR,
        label: 'Fusion (Alpha 1 High + Beta 2 Medium)',
        max_context_tokens: 1_000_000,
        max_output_tokens: 8_192,
        cost_tier: 'High cost',
        cost_summary: '$2 / 1M Input · $8 / 1M Output',
        is_new: false,
        is_beta: false,
      }],
    },
  ];

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'devin-fusion-test-'));
    fakeHome = path.join(scratch, 'home');
    mkdirSync(fakeHome);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('TMPDIR', scratch);
    vi.stubEnv('TMP', scratch);
    vi.stubEnv('TEMP', scratch);
    expect(homedir()).toBe(fakeHome);
    expect(tmpdir()).toBe(scratch);
    fusionLogs.length = 0;
    runChildProcess.mockReset();
    runChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'ok',
      stderr: '',
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    resolveDevinModelUid.mockReset();
    resolveRunUsageAndCost.mockReset();
    resolveRunUsageAndCost.mockResolvedValue({
      sessionId: 'session-abc',
      usage: { inputTokens: 10, outputTokens: 5 },
      usageBasis: 'per_run' as const,
      costUsd: 0,
      billingType: 'subscription_included' as const,
      biller: 'devin',
      provider: 'devin',
      model: 'swe-1-7',
      resultJson: { devinSessionId: 'session-abc' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  function useRealResolver() {
    resolveDevinModelUid.mockImplementation(async (selection: Record<string, unknown>) => {
      const { buildDiscoveredModels, resolveModelUidFrom } = await vi.importActual<
        typeof import('./models.js')
      >('./models.js');
      return resolveModelUidFrom(
        buildDiscoveredModels(fusionFixture),
        selection as { model: string },
      );
    });
  }

  function fusionBaseCtx(config: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: 'run-1',
      agent: { id: 'agent-1', name: 'Atlas', companyId: 'company-1' },
      runtime: { sessionParams: null },
      config: {
        command: 'devin',
        cwd: tmpdir(),
        permissionMode: 'dangerous',
        ...config,
      },
      context: {},
      onLog: async (stream: 'stdout' | 'stderr', chunk: string) => {
        fusionLogs.push({ stream, chunk });
      },
    };
  }

  it('fails before spawn on the ambiguous bare fusion family', async () => {
    useRealResolver();
    const result = await execute(fusionBaseCtx({ model: 'fusion' }) as never);
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('Choose an explicit Fusion combination');
  });

  it('emits the exact fusion uid in one --model argument despite generic axes', async () => {
    useRealResolver();
    await execute(
      fusionBaseCtx({
        model: FUSION_PAIR,
        thinkingEffort: 'high',
        contextSize: '1m',
        fastMode: true,
        priority: true,
      }) as never,
    );
    const [, , args] = runChildProcess.mock.calls[0];
    const indices = (args as string[]).reduce<number[]>(
      (acc: number[], a: string, i: number) =>
        a === '--model' ? [...acc, i] : acc,
      [],
    );
    expect(indices).toHaveLength(1);
    expect(args[indices[0] + 1]).toBe(FUSION_PAIR);
  });
});
