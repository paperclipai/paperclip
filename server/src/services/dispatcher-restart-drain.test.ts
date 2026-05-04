import { describe, expect, it, vi } from 'vitest';
import { drainRunsBeforeRestart } from './dispatcher-restart-drain.js';

describe('drainRunsBeforeRestart', () => {
  it('returns immediately when there are no active runs', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const listActiveRuns = vi.fn().mockResolvedValue([]);
    const forceTerminateRun = vi.fn();
    const sleep = vi.fn();

    const result = await drainRunsBeforeRestart({
      maxDrainMs: 300_000,
      pollIntervalMs: 5_000,
      now: () => now,
      listActiveRuns,
      forceTerminateRun,
      sleep,
      emit: () => {},
    });

    expect(result).toEqual({ deferredMs: 0, initialRunsInFlight: 0, forcedTerminations: 0 });
    expect(forceTerminateRun).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits and exits once active runs clear before timeout', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const nowTicks = [t0, t0, t0 + 5_000, t0 + 5_000];
    let idx = 0;
    const now = () => new Date(nowTicks[Math.min(idx++, nowTicks.length - 1)]);

    const listActiveRuns = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'run-1' }])
      .mockResolvedValueOnce([]);

    const forceTerminateRun = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await drainRunsBeforeRestart({
      maxDrainMs: 300_000,
      pollIntervalMs: 5_000,
      now,
      listActiveRuns,
      forceTerminateRun,
      sleep,
      emit: () => {},
    });

    expect(result.initialRunsInFlight).toBe(1);
    expect(result.deferredMs).toBe(5_000);
    expect(result.forcedTerminations).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(forceTerminateRun).not.toHaveBeenCalled();
  });

  it('force terminates runs when drain timeout elapses', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const nowTicks = [t0, t0, t0 + 5_000, t0 + 10_000, t0 + 10_000];
    let idx = 0;
    const now = () => new Date(nowTicks[Math.min(idx++, nowTicks.length - 1)]);

    const listActiveRuns = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'run-1' }, { id: 'run-2' }])
      .mockResolvedValueOnce([{ id: 'run-1' }, { id: 'run-2' }])
      .mockResolvedValueOnce([{ id: 'run-1' }, { id: 'run-2' }]);

    const forceTerminateRun = vi.fn().mockResolvedValue(true).mockResolvedValueOnce(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await drainRunsBeforeRestart({
      maxDrainMs: 10_000,
      pollIntervalMs: 5_000,
      now,
      listActiveRuns,
      forceTerminateRun,
      sleep,
      emit: () => {},
    });

    expect(result.initialRunsInFlight).toBe(2);
    expect(result.deferredMs).toBe(10_000);
    expect(result.forcedTerminations).toBe(1);
    expect(forceTerminateRun).toHaveBeenCalledTimes(2);
  });
});
