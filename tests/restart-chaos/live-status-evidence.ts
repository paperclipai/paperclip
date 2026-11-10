import type { RunSample } from "./types.js";

type LiveRun = { id?: unknown; currentStatusUpdatedAt?: unknown; lastEventAt?: unknown };

function latest(values: ReadonlyArray<unknown>): string | null {
  let best: number | null = null;
  for (const value of values) {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && (best === null || at > best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}

export function mergeLiveStatusEvidence(runs: RunSample[], live: ReadonlyArray<LiveRun> | null): RunSample[] {
  if (!live?.length) return runs;
  const byId = new Map(live.filter(run => typeof run.id === "string").map(run => [run.id as string, run]));
  return runs.map(run => {
    const status = run.status === "running" ? byId.get(run.id) : undefined;
    if (!status) return run;
    return { ...run, lastEvidenceAt: latest([run.lastEvidenceAt, status.currentStatusUpdatedAt, status.lastEventAt]) };
  });
}

export async function withLiveStatusEvidence(api: { get<T>(path: string, timeoutMs?: number): Promise<T> }, issueId: string,
  runs: RunSample[]): Promise<RunSample[]> {
  if (!runs.some(run => run.status === "running")) return runs;
  const live = await api.get<LiveRun[]>(`/api/issues/${issueId}/live-runs`, 5_000).catch(() => null);
  return mergeLiveStatusEvidence(runs, Array.isArray(live) ? live : null);
}
