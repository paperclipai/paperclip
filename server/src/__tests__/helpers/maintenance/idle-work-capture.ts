import { mock } from 'node:test';
import { promiseHooks } from 'node:v8';

type Admission = typeof import('../../../services/task-admission.js');
type Entry = { id: number; kind: 'begin' | 'track'; sourceId: number; startedAt: number; generation: number };
type Completion = Entry & { finishedAt: number; finishedGeneration: number };
export type IdleWorkCaptureSnapshot = {
  actual: { active: number; generation: number }; observedActive: number; active: Entry[]; completionTail: Completion[];
  newSources: Array<{ id: number; callers: string[] }>; overflow: number; sourceOverflow: number;
  missingCallsites: number; missingPaths: number; observerErrors: number; disposed: boolean;
};

/** Test-only metadata. No original work, promise, drain or counter is changed. */
export function createMaintenanceIdleWorkCapture(actual: Pick<Admission, 'beginIdleTrackedWork' | 'trackIdleWork' | 'idleWorkSnapshot'>,
  controls: { now?: () => number; stack?: () => string | undefined } = {}) {
  const active = new Map<number, Entry>(), sources = new Map<string, { id: number; callers: string[] }>();
  const tail: Completion[] = [];
  let trackedPromises = new WeakMap<Promise<unknown>, number>();
  let disposed = false;
  let serial = 0, emittedSourceId = 0, overflow = 0, sourceOverflow = 0, missingCallsites = 0, missingPaths = 0, observerErrors = 0;
  const now = controls.now ?? Date.now;
  function start(kind: Entry['kind']): number | undefined {
    try {
      if (disposed) return;
      if (active.size >= 512) { overflow++; return; }
      const callers: string[] = [];
      for (const line of (controls.stack?.() ?? new Error().stack ?? '').split('\n')) {
        const match = line.match(/[/\\]server[/\\](?:src|dist)[/\\]((?:(?:services|middleware|routes|modules)[/\\][A-Za-z0-9_./\\-]+|(?:app|index))\.[cm]?[jt]s):(\d+):(\d+)/);
        if (!match || match[1]!.split(/[/\\]/).includes('..')) continue;
        const caller = `${match[1]!.replaceAll('\\', '/')}:${match[2]}:${match[3]}`;
        if (!callers.includes(caller)) callers.push(caller);
        if (callers.length === 4) break;
      }
      if (!callers.length) missingCallsites++;
      const key = JSON.stringify(callers); let source = sources.get(key);
      if (!source) {
        if (sources.size >= 512) { sourceOverflow++; return; }
        source = { id: sources.size + 1, callers }; sources.set(key, source);
      }
      const id = ++serial;
      active.set(id, { id, kind, sourceId: source.id, startedAt: now(), generation: actual.idleWorkSnapshot().generation });
      return id;
    } catch { observerErrors++; return; }
  }
  // V8 observes settlement without attaching a continuation or marking a rejected
  // original promise handled. Unrelated promises only perform a WeakMap lookup.
  const stopSettlementHook = promiseHooks.onSettled(promise => {
    try {
      const id = trackedPromises.get(promise);
      if (id === undefined) return;
      trackedPromises.delete(promise);
      finish(id);
    } catch { observerErrors++; }
  });
  function finish(id: number | undefined) {
    try {
      if (id === undefined) return;
      const entry = active.get(id); if (!entry) return;
      active.delete(id);
      tail.push({ ...entry, finishedAt: now(), finishedGeneration: actual.idleWorkSnapshot().generation });
      if (tail.length > 64) tail.shift();
    } catch { observerErrors++; }
  }
  const beginIdleTrackedWork: Admission['beginIdleTrackedWork'] = () => {
    const originalFinish = actual.beginIdleTrackedWork(); const id = start('begin');
    return () => { try { return originalFinish(); } finally { finish(id); } };
  };
  const trackIdleWork: Admission['trackIdleWork'] = <T>(work: Promise<T>) => {
    const original = actual.trackIdleWork(work); const id = start('track');
    try { if (id !== undefined) trackedPromises.set(original, id); } catch { observerErrors++; }
    return original;
  };
  return { beginIdleTrackedWork, trackIdleWork,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { stopSettlementHook(); } finally { trackedPromises = new WeakMap(); }
    },
    snapshot(): IdleWorkCaptureSnapshot {
      const state = actual.idleWorkSnapshot();
      if (state.active !== active.size) missingPaths++;
      const newSources = [...sources.values()].filter(source => source.id > emittedSourceId).map(source => ({ ...source, callers: [...source.callers] }));
      emittedSourceId = sources.size;
      return { actual: state, observedActive: active.size, active: [...active.values()].map(entry => ({ ...entry })), completionTail: tail.map(entry => ({ ...entry })),
        newSources, overflow, sourceOverflow, missingCallsites, missingPaths, observerErrors, disposed };
    },
    summary() { return { sourceCatalog: [...sources.values()], snapshot: this.snapshot() }; },
  };
}

export async function installMaintenanceIdleWorkCapture() {
  const actual = await import('../../../services/task-admission.js');
  const capture = createMaintenanceIdleWorkCapture(actual);
  let moduleCapture: ReturnType<typeof mock.module> | undefined;
  const disposeCapture = capture.dispose;
  capture.dispose = () => { try { disposeCapture(); } finally { const installed = moduleCapture; moduleCapture = undefined; installed?.restore(); } };
  try {
    moduleCapture = mock.module(new URL('../../../services/task-admission.ts', import.meta.url).href, {
      namedExports: { ...actual, beginIdleTrackedWork: capture.beginIdleTrackedWork, trackIdleWork: capture.trackIdleWork },
    });
    const observed = await import('../../../services/task-admission.js');
    if (observed.beginIdleTrackedWork !== capture.beginIdleTrackedWork || observed.trackIdleWork !== capture.trackIdleWork
      || Object.keys(observed).sort().join(',') !== Object.keys(actual).sort().join(',')
      || Object.keys(actual).some(key => !['beginIdleTrackedWork', 'trackIdleWork'].includes(key)
        && observed[key as keyof Admission] !== actual[key as keyof Admission])) throw new Error('Idle work module capture did not preserve original exports/identity');
    return capture;
  } catch (error) {
    try { capture.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Idle work capture installation and cleanup failed'); }
    throw error;
  }
}

/** Reuse existing settle-loop observations. No extra poll, timer, SQL or raw stack per sample. */
export function createSettledWorkSamples(sourceCatalog: () => Array<{ id: number; callers: string[] }>) {
  // Finite longest setup observation at the existing 25ms cadence, plus its
  // terminal sample. Overflow still makes diagnostic completion fail closed.
  const sampleLimit = Math.ceil(61_000 / 25) + 1;
  const samples: Array<{ id: number; at: number; queryTotal: number; queryDelta: number; pending: number;
    idle: { active: number; generation: number }; activeIds: number[] }> = [];
  let previous: number | undefined, overflowSamples = 0, lastCapture: IdleWorkCaptureSnapshot | undefined;
  const startedAt = Date.now();
  return {
    sample(snapshot: { now: number; idle: { active: number; generation: number }; workCapture?: IdleWorkCaptureSnapshot }, queryTotal: number, pending: number) {
      lastCapture = snapshot.workCapture;
      if (samples.length < sampleLimit) samples.push({ id: samples.length + 1, at: snapshot.now, queryTotal,
        queryDelta: previous === undefined ? 0 : queryTotal - previous, pending, idle: { ...snapshot.idle }, activeIds: lastCapture?.active.map(entry => entry.id) ?? [] });
      else overflowSamples++;
      previous = queryTotal;
    },
    report() { return { startedAt, finishedAt: Date.now(), settleDeadlineMs: 30_000, sampleLimit, overflowSamples,
      samples, sourceCatalog: sourceCatalog(), lastCapture }; },
    assertComplete() {
      if (!lastCapture || overflowSamples || lastCapture.overflow || lastCapture.sourceOverflow || lastCapture.missingCallsites
        || lastCapture.missingPaths || lastCapture.observerErrors || lastCapture.disposed) throw new Error('Passive idle work diagnostic capture incomplete');
    },
  };
}
