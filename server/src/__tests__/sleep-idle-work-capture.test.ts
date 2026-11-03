import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMaintenanceIdleWorkCapture as createCapture, createSettledWorkSamples } from './helpers/maintenance/idle-work-capture.js';

const captures: ReturnType<typeof createCapture>[] = [];
function createMaintenanceIdleWorkCapture(...args: Parameters<typeof createCapture>) {
  const capture = createCapture(...args); captures.push(capture); return capture;
}
afterEach(() => { for (const capture of captures.splice(0)) capture.dispose(); });

const stack = () => 'Error\n at begin (/checkout/server/src/services/owned-work.ts:12:3)\n at owner (/checkout/server/src/index.ts:100:5)';
function original() {
  let active = 0, generation = 0, finishes = 0, tracked: Promise<unknown> | undefined;
  const beginIdleTrackedWork = () => {
    active++; generation++; let done = false;
    return () => { finishes++; if (!done) { done = true; active--; generation++; } };
  };
  const trackIdleWork = <T>(work: Promise<T>) => {
    const finish = beginIdleTrackedWork(); const result = work.finally(finish); tracked = result; return result;
  };
  return { beginIdleTrackedWork, trackIdleWork, idleWorkSnapshot: () => ({ active, generation }),
    finishes: () => finishes, lastTracked: () => tracked };
}
it('delegates original finish calls/idempotence and returns the exact original tracked promise and rejection', async () => {
  const actual = original(), capture = createMaintenanceIdleWorkCapture(actual, { stack });
  const finish = capture.beginIdleTrackedWork(); expect(actual.idleWorkSnapshot().active).toBe(1);
  finish(); finish(); expect(actual.finishes()).toBe(2); expect(actual.idleWorkSnapshot().active).toBe(0);
  let resolve!: (value: string) => void;
  const tracked = capture.trackIdleWork(new Promise<string>(done => { resolve = done; }));
  expect(tracked).toBe(actual.lastTracked()); expect(capture.snapshot().observedActive).toBe(1);
  resolve('same'); await expect(tracked).resolves.toBe('same'); expect(capture.snapshot().observedActive).toBe(0);
  const failure = new Error('original rejection'), rejected = capture.trackIdleWork(Promise.reject(failure));
  expect(rejected).toBe(actual.lastTracked()); await expect(rejected).rejects.toBe(failure);
  expect(capture.snapshot().observedActive).toBe(0); expect(actual.idleWorkSnapshot().active).toBe(0);
  capture.dispose(); capture.dispose(); expect(capture.snapshot().disposed).toBe(true);
  await expect(capture.trackIdleWork(Promise.resolve('after-dispose'))).resolves.toBe('after-dispose');
  expect(actual.idleWorkSnapshot().active).toBe(0); expect(capture.snapshot().observedActive).toBe(0);
});
it('cannot throw from passive metadata into actual work and makes missing observation explicit', () => {
  const actual = original(), capture = createMaintenanceIdleWorkCapture(actual, { stack, now: () => { throw new Error('private observer detail'); } });
  let finish!: () => void; expect(() => { finish = capture.beginIdleTrackedWork(); }).not.toThrow();
  expect(actual.idleWorkSnapshot().active).toBe(1); expect(capture.snapshot().missingPaths).toBeGreaterThan(0);
  expect(() => finish()).not.toThrow(); expect(actual.idleWorkSnapshot().active).toBe(0);
  expect(capture.snapshot().observerErrors).toBeGreaterThan(0); expect(JSON.stringify(capture.summary())).not.toContain('private observer detail');
});
it('bounds active entries, completion tail and filtered callsites without clearing original work', () => {
  const actual = original();
  const callers = () => 'private outside value\n' + Array.from({ length: 8 }, (_, i) => ` at work (/root/server/src/services/owned-${i}.ts:1:2)`).join('\n');
  const capture = createMaintenanceIdleWorkCapture(actual, { stack: callers });
  const finish = Array.from({ length: 513 }, () => capture.beginIdleTrackedWork());
  const busy = capture.snapshot(); expect(busy.active).toHaveLength(512); expect(busy.overflow).toBe(1);
  expect(busy.newSources[0]!.callers).toHaveLength(4); expect(JSON.stringify(busy)).not.toContain('private outside value');
  expect(actual.idleWorkSnapshot().active).toBe(513); expect(busy.missingPaths).toBeGreaterThan(0);
  finish.forEach(done => done()); expect(actual.idleWorkSnapshot().active).toBe(0); expect(capture.snapshot().completionTail).toHaveLength(64);
});
it('bounds unique source metadata and preserves original finisher failures', () => {
  const actual = original(); let source = 0;
  const capture = createMaintenanceIdleWorkCapture(actual, { stack: () => `Error\n at owner (/checkout/server/src/services/source-${source++}.ts:1:1)` });
  for (let i = 0; i < 513; i++) capture.beginIdleTrackedWork()();
  const state = capture.snapshot(); expect(capture.summary().sourceCatalog).toHaveLength(512); expect(state.sourceOverflow).toBe(1);
  expect(actual.idleWorkSnapshot().active).toBe(0);
  const failure = new Error('original finisher'), begin = actual.beginIdleTrackedWork;
  actual.beginIdleTrackedWork = () => { const finish = begin(); return () => { finish(); throw failure; }; };
  const observed = createMaintenanceIdleWorkCapture(actual, { stack }); const finish = observed.beginIdleTrackedWork();
  expect(() => finish()).toThrow(failure); expect(actual.idleWorkSnapshot().active).toBe(0); expect(observed.snapshot().observedActive).toBe(0);
});
it('bounds settle samples and stores callsites once, while missing paths forbid diagnostic completion', () => {
  const actual = original(), capture = createMaintenanceIdleWorkCapture(actual, { stack }); const finish = capture.beginIdleTrackedWork();
  const state = capture.snapshot(), catalog = state.newSources;
  const samples = createSettledWorkSamples(() => catalog);
  for (let i = 0; i < 2442; i++) samples.sample({ now: 1000 + i, idle: actual.idleWorkSnapshot(), workCapture: state }, 20 + i, 0);
  const report = samples.report(); expect(report.samples).toHaveLength(2441); expect(report.sampleLimit).toBe(2441); expect(report.overflowSamples).toBe(1);
  expect(report.samples[1]!.queryDelta).toBe(1); expect(report.sourceCatalog).toHaveLength(1);
  expect(JSON.stringify(report.samples)).not.toContain('owned-work'); expect(() => samples.assertComplete()).toThrow('incomplete');
  finish();
  const missing = createSettledWorkSamples(() => []); missing.sample({ now: 0, idle: actual.idleWorkSnapshot() }, 0, 0);
  expect(() => missing.assertComplete()).toThrow('incomplete');
});
it('intercepts the actual Node24 TS module and preserves every other original export and existing state', async () => {
  const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./helpers/maintenance/idle-work-capture-probe.ts', import.meta.url))], { timeout: 15_000, maxBuffer: 128 * 1024 });
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ identity: true, originalStatePreserved: true, finalActive: 0 });
});
it('preserves actual Node unhandledRejection with the same original tracked promise and reason', async () => {
  const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./helpers/maintenance/idle-work-capture-probe.ts', import.meta.url)), 'unhandled'], { timeout: 15_000, maxBuffer: 128 * 1024 });
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ unhandledOriginalPromise: true, unhandledOriginalReason: true, finalActive: 0 });
});
