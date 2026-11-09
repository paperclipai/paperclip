import type { IssueListPhase } from "./issues.js";

// Closed, content-free phase names for the Mine snapshot. This is a response
// header only (inspectable in DevTools); it emits no telemetry or spans.
export type InboxMinePhase =
  | "access" | "issues" | "parents" | "failures" | "failure_context"
  | `issues_${IssueListPhase}`;

export type InboxMinePhaseDurations = ReadonlyArray<readonly [InboxMinePhase, number]>;

export function createInboxMineTiming() {
  const start = performance.now();
  const durations = new Map<InboxMinePhase, number>();
  const time = async <T>(phase: InboxMinePhase, read: () => Promise<T>): Promise<T> => {
    const phaseStart = performance.now();
    try {
      return await read();
    } finally {
      // Batched reads (context loads in chunks) accumulate into one phase.
      durations.set(phase, (durations.get(phase) ?? 0) + performance.now() - phaseStart);
    }
  };
  return {
    time,
    /** Adapts the timer to the issue list's internal phases under an `issues_` prefix. */
    listPhases: <T>(phase: IssueListPhase, read: () => Promise<T>) => time(`issues_${phase}`, read),
    /** Completed phase durations, to share with requests that reuse this read. */
    phases(): InboxMinePhaseDurations {
      return [...durations];
    },
    /**
     * A coalesced request reuses another request's read and never runs its own
     * phases, so it reports the shared read's phases it did not time itself.
     */
    header(shared: InboxMinePhaseDurations = []) {
      const reported = new Map(shared);
      for (const [phase, duration] of durations) reported.set(phase, duration);
      return [
        `paperclip_inbox;dur=${(performance.now() - start).toFixed(1)}`,
        ...[...reported].map(([phase, duration]) => `inbox_${phase};dur=${duration.toFixed(1)}`),
      ].join(", ");
    },
  };
}
