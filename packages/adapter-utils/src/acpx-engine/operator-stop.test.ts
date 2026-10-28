import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { AdapterExecutionContext } from '../types.js';
import { createAcpxEngineExecutor } from './execute.js';
import { sessionCodec } from './session-codec.js';
const fixture = fileURLToPath(new URL('../../../../scripts/mcp-fixtures/servers/acp-stop-agent.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup(tool?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-acp-stop-'));
  roots.push(root);
  const abort = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const ctx = {
    runId: 'stop-test', agent: { id: 'agent', companyId: 'company' }, runtime: {},
    config: { agent: 'custom', agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`, mode: 'persistent',
      stateDir: path.join(root, 'state'), cwd: root, graceSec: 5,
      env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, ...(tool ? { PAPERCLIP_STOP_FIXTURE_TOOL: tool } : {}) } },
    context: {}, signal: abort.signal,
    onLog: async (_stream: string, text: string) => { await fs.appendFile(path.join(root, 'logs'), text); if (text.includes('Waiting for Stop.')) ready(); },
  } as unknown as AdapterExecutionContext;
  return { root, ctx, abort, started, execute: createAcpxEngineExecutor() };
}
it('stops an actual ACP process and resumes its established session with the new request', async () => {
  const { root, ctx, abort, started, execute } = await setup('read');
  ctx.authToken = 'first-run-test-token';
  const running = execute(ctx);
  await started;
  abort.abort(new Error('Operator Stop'));
  const result = await running;
  expect(result.resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged', forced: false });
  expect(result.executionRecovery).toMatchObject({ kind: 'interrupted', sessionPreserved: true });
  const params = sessionCodec.serialize(result.sessionParams ?? null);
  expect(params?.interruptedCheckpoint).toBe(true);
  const next = await execute({ ...ctx, runId: 'follow-up', authToken: 'follow-up-test-token', signal: undefined, context: { prompt: 'List recent Drive files' },
    runtime: { ...ctx.runtime, sessionParams: params } });
  expect(next.exitCode, JSON.stringify(next)).toBe(0);
  const prompts = (await fs.readFile(path.join(root, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(prompts).toHaveLength(2);
  expect(prompts[1].sessionId).toBe(prompts[0].sessionId);
  const launches = (await fs.readFile(path.join(root, 'run-env'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(launches.map(launch => launch.runId)).toEqual(['stop-test', 'follow-up']);
  expect(launches[1].tokenHash).toBe(createHash('sha256').update('follow-up-test-token').digest('hex'));
});
it('continues after an interrupted write without replaying that write', async () => {
  const { root, ctx, abort, started, execute } = await setup('write');
  const running = execute(ctx);
  await started;
  await new Promise(resolve => setTimeout(resolve, 100));
  abort.abort();
  const result = await running;
  expect(result.resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged' });
  expect(result.executionRecovery).toBeUndefined();
  const before = await fs.readFile(path.join(root, 'writes'), 'utf8');
  const next = await execute({ ...ctx, runId: 'follow-up', signal: undefined, context: { prompt: 'What happened?' },
    runtime: { ...ctx.runtime, sessionParams: sessionCodec.serialize(result.sessionParams ?? null) } });
  expect(next.exitCode, JSON.stringify(next)).toBe(0);
  expect(await fs.readFile(path.join(root, 'writes'), 'utf8')).toBe(before);
  expect((await fs.readFile(path.join(root, 'completed'), 'utf8')).trim()).toBe('follow-up');
}, 15000);
it('does not dispatch a provider when Stop precedes startup', async () => {
  const { root, ctx, abort, execute } = await setup();
  abort.abort(new Error('Stopped before startup'));
  expect(await execute(ctx)).toMatchObject({ errorCode: 'cancelled', executionRecovery: { kind: 'bootstrap', providerWorkStarted: false } });
  await expect(fs.access(path.join(root, 'prompts'))).rejects.toThrow();
});

it.each(['missing session', 'changed configuration'])('starts a new turn when the interrupted session cannot resume: %s', async (change) => {
  const { root, ctx, abort, started, execute } = await setup();
  const running = execute(ctx);
  await started;
  abort.abort();
  const result = await running;
  expect(result.executionRecovery?.kind).toBe('interrupted');
  if (change === 'missing session') await fs.rm(path.join(root, 'session'));
  let next = await execute({ ...ctx, signal: undefined,
    config: change === 'changed configuration' ? { ...ctx.config, env: { ...(ctx.config.env as object), SETTING: 'changed' } } : ctx.config,
    runtime: { ...ctx.runtime, sessionParams: sessionCodec.serialize(result.sessionParams ?? null) },
  });
  if (change === 'missing session') {
    expect(next.clearSession, JSON.stringify(next)).toBe(true);
    next = await execute({ ...ctx, runId: 'fresh-follow-up', signal: undefined,
      runtime: { ...ctx.runtime, sessionParams: null } });
  }
  expect(next.exitCode, JSON.stringify(next)).toBe(0);
  expect((await fs.readFile(path.join(root, 'prompts'), 'utf8')).trim().split('\n')).toHaveLength(2);
});

it('keeps the Stop deadline active after cancellation returns until provider exit', async () => {
  const { ctx, abort, started, execute } = await setup();
  ctx.config.graceSec = 1;
  ctx.config.env = { ...(ctx.config.env as object), PAPERCLIP_STOP_FIXTURE_HANG_ON_CLOSE: '1' };
  let providerPid: number | undefined;
  ctx.onSpawn = async ({ pid }) => { providerPid = pid; };
  const running = execute(ctx);
  await started;
  abort.abort();
  const result = await running;
  expect(result.resultJson?.executionCancellation).toMatchObject({ state: 'acknowledged', forced: true });
  expect(result.executionRecovery).toBeUndefined();
  expect(providerPid).toBeTypeOf('number');
  expect(() => process.kill(providerPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}, 10000);
