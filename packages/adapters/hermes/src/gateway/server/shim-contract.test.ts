import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { execute } from './execute.js';

// The shim has separate ownership: opt in with its checked-out directory. This
// executes the real adapter and shim HTTP/coordinator, with a fake native backend.
describe.skipIf(!process.env.HERMES_COMPAT_SOURCE)('adapter to shim contract', () => {
  it('refuses success and keeps output after native TCP loss mid-emission', async () => {
    const child = spawn('python3', ['-B', join(process.env.HERMES_COMPAT_SOURCE!, 'test/native_loss_fixture.py')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout });
    try {
      const base = await Promise.race([
        once(lines, 'line').then(([line]) => String(line)),
        once(child, 'exit').then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
      ]);
      const config = { apiBaseUrl: base, apiKey: 'offline-contract-key', timeoutSec: 5, pollIntervalMs: 250 };
      const result = await execute({
        runId: 'loss-run', agent: { id: 'agent', companyId: 'company', name: 'test', adapterType: 'hermes_gateway', adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, onLog: vi.fn(async () => undefined),
      });
      expect(result.exitCode).toBe(1);
      expect(result.resultJson).toMatchObject({ event_gap: true, output: 'kept after native disconnect' });
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }, 15_000);

  it.each(['expiry', 'headers', 'body'])('terminates %s without duplicate inference', async (scenario) => {
    const child = spawn('python3', ['-B', join(process.env.HERMES_COMPAT_SOURCE!, 'test/adapter_contract_fixture.py'), scenario],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout });
    try {
      const base = await Promise.race([
        once(lines, 'line').then(([line]) => String(line)),
        once(child, 'exit').then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
      ]);
      const config = { apiBaseUrl: base, apiKey: 'offline-contract-key', timeoutSec: scenario === 'expiry' ? 0 : .05, pollIntervalMs: 250 };
      const ctx = {
        runId: 'contract-run', agent: { id: 'agent', companyId: 'company', name: 'test', adapterType: 'hermes_gateway', adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, onLog: vi.fn(async () => undefined),
      } satisfies AdapterExecutionContext;
      const result = await execute(ctx);
      expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: 'hermes_gateway_timeout' });
      if (scenario !== 'expiry') expect(result.resultJson).toMatchObject({ stop_confirmed: true });
      const counts = await fetch(base + '/test/counts', { headers: { Authorization: 'Bearer offline-contract-key' } }).then((r) => r.json());
      expect(counts.invocations).toBe(1);
      if (scenario === 'expiry') expect(counts.bodies).toEqual([{ input: 'blocker' }]); // Expired adapter run invoked zero times.
      else expect(counts.stops).toBeGreaterThanOrEqual(1);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }, 15_000);
});
