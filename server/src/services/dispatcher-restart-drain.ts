export type RestartDrainRun = { id: string };

export type RestartDrainResult = {
  deferredMs: number;
  initialRunsInFlight: number;
  forcedTerminations: number;
};

export type RestartDrainDeps = {
  maxDrainMs: number;
  pollIntervalMs: number;
  now?: () => Date;
  listActiveRuns: () => Promise<RestartDrainRun[]>;
  forceTerminateRun: (runId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  emit?: (event: {
    name:
      | 'dispatcher_restart_runs_in_flight'
      | 'dispatcher_restart_drain_deferred_ms'
      | 'dispatcher_restart_forced_terminations';
    value: number;
  }) => void;
};

const defaultNow = () => new Date();
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function drainRunsBeforeRestart(deps: RestartDrainDeps): Promise<RestartDrainResult> {
  const now = deps.now ?? defaultNow;
  const sleep = deps.sleep ?? defaultSleep;
  const emit = deps.emit ?? (() => {});

  const startedAt = now().getTime();
  let activeRuns = (await deps.listActiveRuns()) ?? [];
  const initialRunsInFlight = activeRuns.length;

  emit({ name: 'dispatcher_restart_runs_in_flight', value: initialRunsInFlight });

  while (activeRuns.length > 0 && now().getTime() - startedAt < deps.maxDrainMs) {
    await sleep(deps.pollIntervalMs);
    activeRuns = (await deps.listActiveRuns()) ?? [];
  }

  const deferredMs = Math.min(Math.max(now().getTime() - startedAt, 0), deps.maxDrainMs);
  emit({ name: 'dispatcher_restart_drain_deferred_ms', value: deferredMs });

  let forcedTerminations = 0;
  if (activeRuns.length > 0) {
    for (const run of activeRuns) {
      if (await deps.forceTerminateRun(run.id)) {
        forcedTerminations += 1;
      }
    }
  }

  emit({ name: 'dispatcher_restart_forced_terminations', value: forcedTerminations });

  return { deferredMs, initialRunsInFlight, forcedTerminations };
}
