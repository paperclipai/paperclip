export const IDLE_DEADLINE_CATALOG = "domain_deadlines_v1" as const;
export interface IdleDeadlineReceipt {
  catalog: typeof IDLE_DEADLINE_CATALOG;
  generation: string;
}
export interface DomainScheduledWake {
  version: 2;
  kind: "domain_deadlines";
  catalog: typeof IDLE_DEADLINE_CATALOG;
  generation: string;
  nextWakeAt: string;
}
export interface IdleDeadlineSnapshot {
  blocked: boolean;
    state: unknown;
  deadlines: number[];
}
export const idleDeadlineRowLimit = 10_000;
export const isFutureIdleDeadline = (at: number, now: number) => Number.isFinite(at) && at > now;
